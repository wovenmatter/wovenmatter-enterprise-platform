// Structured remote authentication for the Enterprise management client.
package management

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/watcher/synthesizer"
	login "github.com/router-for-me/CLIProxyAPI/v8/sdk/auth"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

var remoteID = regexp.MustCompile(`^[a-f0-9-]{36}$`)

type remoteReceipt struct {
	Status    string    `json:"status"`
	Provider  string    `json:"provider"`
	ExpiresAt time.Time `json:"expires_at"`
}
type remoteSession struct {
	mu           sync.Mutex
	receipt      remoteReceipt
	instructions login.RemoteInstructions
	operation    *login.RemoteLogin
	record       *coreauth.Auth
	cancel       context.CancelFunc
	ctx          context.Context
	submitted    bool
}

// Dependencies are per handler. Tests replace the provider transport, not HTTP routes.
type remoteSessions struct {
	mu    sync.Mutex
	items map[string]*remoteSession
	start func(context.Context, *config.Config, string) (*login.RemoteLogin, error)
}

func (h *Handler) remoteStore() *remoteSessions {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.enterpriseRemote == nil {
		h.enterpriseRemote = &remoteSessions{items: make(map[string]*remoteSession), start: login.StartRemoteLogin}
	}
	return h.enterpriseRemote
}
func (h *Handler) remoteReceiptPath(id string) string {
	return filepath.Join(h.cfg.AuthDir, ".enterprise-signin", id+".receipt")
}
func syncRemoteDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func (h *Handler) writeRemoteReceipt(id string, s *remoteSession) error {
	path := h.remoteReceiptPath(id)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err := syncRemoteDirectory(h.cfg.AuthDir); err != nil {
		return err
	}
	data, _ := json.Marshal(s.receipt)
	if err := os.WriteFile(path+".tmp", data, 0600); err != nil {
		return err
	}
	f, err := os.OpenFile(path+".tmp", os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = f.Sync()
	_ = f.Close()
	if err != nil {
		return err
	}
	if err = os.Rename(path+".tmp", path); err != nil {
		return err
	}
	return syncRemoteDirectory(filepath.Dir(path))
}
func (h *Handler) remoteGet(id string) *remoteSession {
	if !remoteID.MatchString(id) {
		return nil
	}
	store := h.remoteStore()
	store.mu.Lock()
	defer store.mu.Unlock()
	if s := store.items[id]; s != nil {
		return s
	}
	data, err := os.ReadFile(h.remoteReceiptPath(id))
	if os.IsNotExist(err) {
		return nil
	}
	var r remoteReceipt
	if err != nil || json.Unmarshal(data, &r) != nil {
		return &remoteSession{receipt: remoteReceipt{Status: "interrupted"}}
	}
	if r.Status != "complete" && r.Status != "cancelled" && r.Status != "expired" && r.Status != "denied" && r.Status != "error" {
		r.Status = "interrupted"
	}
	return &remoteSession{receipt: r}
}
func remoteDTO(s *remoteSession) gin.H {
	d := gin.H{"status": s.receipt.Status, "provider": s.receipt.Provider, "expires_at": s.receipt.ExpiresAt}
	if s.receipt.Status == "pending" || s.receipt.Status == "ready" {
		d["flow"] = s.instructions.Flow
		d["url"] = s.instructions.URL
		d["user_code"] = s.instructions.UserCode
		d["interval"] = s.instructions.Interval
	}
	return d
}
func (h *Handler) StartEnterpriseRemote(c *gin.Context) {
	var b struct {
		ID       string `json:"id"`
		Provider string `json:"provider"`
	}
	if c.ShouldBindJSON(&b) != nil || !remoteID.MatchString(b.ID) || (b.Provider != "codex" && b.Provider != "claude" && b.Provider != "xai") {
		c.JSON(400, gin.H{"error": "invalid sign-in request"})
		return
	}
	if existing := h.remoteGet(b.ID); existing != nil {
		existing.mu.Lock()
		defer existing.mu.Unlock()
		if existing.receipt.Provider != b.Provider {
			c.JSON(409, gin.H{"error": "session conflict"})
			return
		}
		c.JSON(200, remoteDTO(existing))
		return
	}
	store := h.remoteStore()
	store.mu.Lock()
	// Bound in-memory terminal receipts; disk receipts fence IDs across restarts.
	for id, s := range store.items {
		s.mu.Lock()
		if time.Now().After(s.receipt.ExpiresAt.Add(time.Hour)) {
			delete(store.items, id)
		}
		s.mu.Unlock()
	}
	if len(store.items) >= 128 {
		store.mu.Unlock()
		c.JSON(429, gin.H{"error": "too many sign-in sessions"})
		return
	}
	if existing := store.items[b.ID]; existing != nil {
		store.mu.Unlock()
		existing.mu.Lock()
		defer existing.mu.Unlock()
		if existing.receipt.Provider != b.Provider {
			c.JSON(409, gin.H{"error": "session conflict"})
			return
		}
		c.JSON(200, remoteDTO(existing))
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	s := &remoteSession{receipt: remoteReceipt{"starting", b.Provider, time.Now().Add(30 * time.Minute)}, ctx: ctx, cancel: cancel}
	store.items[b.ID] = s
	store.mu.Unlock()
	s.mu.Lock()
	if h.writeRemoteReceipt(b.ID, s) != nil {
		s.receipt.Status = "error"
		cancel()
		s.mu.Unlock()
		c.JSON(503, gin.H{"error": "sign-in unavailable"})
		return
	}
	s.mu.Unlock()
	// Initiation belongs to this receipt, never to a browser connection.
	startCtx, startCancel := context.WithTimeout(ctx, 30*time.Second)
	op, err := store.start(startCtx, h.cfg, b.Provider)
	startCancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.receipt.Status != "starting" || ctx.Err() != nil {
		cancel()
		c.JSON(200, remoteDTO(s))
		return
	}
	if err != nil {
		s.receipt.Status = "error"
		cancel()
		_ = h.writeRemoteReceipt(b.ID, s)
		c.JSON(200, remoteDTO(s))
		return
	}
	if !op.Instructions.ExpiresAt.After(time.Now()) {
		s.receipt.Status = "expired"
		cancel()
		_ = h.writeRemoteReceipt(b.ID, s)
		c.JSON(200, remoteDTO(s))
		return
	}
	s.operation = op
	s.instructions = op.Instructions
	s.receipt.Status = "pending"
	s.receipt.ExpiresAt = op.Instructions.ExpiresAt
	if h.writeRemoteReceipt(b.ID, s) != nil {
		s.receipt.Status = "error"
		cancel()
		c.JSON(503, gin.H{"error": "sign-in unavailable"})
		return
	}
	go h.waitRemote(b.ID, s, op)
	c.JSON(200, remoteDTO(s))
}
func (h *Handler) waitRemote(id string, s *remoteSession, op *login.RemoteLogin) {
	deadline, cancel := context.WithDeadline(s.ctx, op.Instructions.ExpiresAt)
	defer cancel()
	record, err := op.Wait(deadline)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.receipt.Status != "pending" {
		return
	}
	if deadline.Err() != nil || !time.Now().Before(s.receipt.ExpiresAt) {
		s.receipt.Status = "expired"
	} else if err != nil {
		s.receipt.Status = "error"
		if errors.Is(err, login.ErrRemoteDenied) {
			s.receipt.Status = "denied"
		}
		if errors.Is(err, login.ErrRemoteExpired) {
			s.receipt.Status = "expired"
		}
	} else {
		s.record = record
		s.receipt.Status = "ready"
	}
	_ = h.writeRemoteReceipt(id, s)
}
func (h *Handler) GetEnterpriseRemote(c *gin.Context) {
	s := h.remoteGet(c.Param("id"))
	if s == nil {
		c.JSON(200, gin.H{"status": "interrupted"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if (s.receipt.Status == "pending" || s.receipt.Status == "ready") && !time.Now().Before(s.receipt.ExpiresAt) {
		s.receipt.Status = "expired"
		s.record = nil
		if s.cancel != nil {
			s.cancel()
		}
		_ = h.writeRemoteReceipt(c.Param("id"), s)
	}
	c.JSON(200, remoteDTO(s))
}
func (h *Handler) SubmitEnterpriseRemote(c *gin.Context) {
	var b struct {
		Code string `json:"code"`
	}
	if c.ShouldBindJSON(&b) != nil {
		c.JSON(400, gin.H{"error": "invalid code"})
		return
	}
	s := h.remoteGet(c.Param("id"))
	if s == nil {
		c.JSON(409, gin.H{"error": "sign-in interrupted"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.receipt.Status != "pending" || s.operation == nil || s.operation.Submit == nil || s.submitted || !time.Now().Before(s.receipt.ExpiresAt) {
		c.JSON(409, gin.H{"error": "sign-in is closed or already submitted"})
		return
	}
	if s.operation.Submit(b.Code) != nil {
		c.JSON(400, gin.H{"error": "invalid authorization code"})
		return
	}
	s.submitted = true
	c.JSON(200, gin.H{"status": "pending"})
}
func (h *Handler) CommitEnterpriseRemote(c *gin.Context) {
	id := c.Param("id")
	s := h.remoteGet(id)
	if s == nil {
		c.JSON(200, gin.H{"status": "interrupted"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.receipt.Status == "complete" {
		c.JSON(200, remoteDTO(s))
		return
	}
	if s.receipt.Status != "ready" || s.record == nil || !time.Now().Before(s.receipt.ExpiresAt) || s.ctx.Err() != nil {
		c.JSON(409, gin.H{"error": "sign-in is not ready"})
		return
	}
	// A crash after this receipt is uncertain, never a request to replay a save/exchange.
	s.receipt.Status = "saving"
	if h.writeRemoteReceipt(id, s) != nil {
		c.JSON(503, gin.H{"error": "sign-in unavailable"})
		return
	}
	record := s.record
	record.ID = "enterprise-" + id + ".json"
	record.FileName = record.ID
	// Unique attempt-owned path prevents cancellation from removing an earlier account.
	store := h.tokenStoreWithBaseDir()
	saveDeadline := time.Now().Add(30 * time.Second)
	if s.receipt.ExpiresAt.Before(saveDeadline) {
		saveDeadline = s.receipt.ExpiresAt
	}
	saveCtx, saveCancel := context.WithDeadline(s.ctx, saveDeadline)
	defer saveCancel()
	var err error
	if store == nil {
		err = errors.New("store unavailable")
	} else {
		if h.postAuthHook != nil {
			err = h.postAuthHook(saveCtx, record)
		}
		var saved string
		if err == nil {
			// Establish private permissions before provider storage opens the attempt-owned file.
			var file *os.File
			file, err = os.OpenFile(filepath.Join(h.cfg.AuthDir, record.ID), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err == nil {
				err = file.Close()
			}
		}
		if err == nil {
			saved, err = store.Save(coreauth.WithAuthCreationIntent(saveCtx), record)
		}
		if err == nil {
			// Upstream storage closes the file; make the completed receipt a durable claim.
			var file *os.File
			file, err = os.OpenFile(saved, os.O_RDWR, 0600)
			if err == nil {
				err = file.Chmod(0600)
				if err == nil {
					err = file.Sync()
				}
				_ = file.Close()
			}
		}
		if err == nil {
			err = syncRemoteDirectory(h.cfg.AuthDir)
		}
		if err == nil {
			var data []byte
			data, err = os.ReadFile(saved)
			if err == nil {
				var records []*coreauth.Auth
				records, err = synthesizer.SynthesizeAuthFile(&synthesizer.SynthesisContext{Config: h.cfg, AuthDir: h.cfg.AuthDir, Now: time.Now(), IDGenerator: synthesizer.NewStableIDGenerator(), PluginAuthParser: h.pluginHost}, saved, data)
				if err == nil && len(records) == 0 {
					err = errors.New("saved credential cannot be registered")
				}
				if err == nil && h.postAuthPersistHook != nil {
					for _, persisted := range records {
						if err = h.postAuthPersistHook(saveCtx, persisted); err != nil {
							break
						}
					}
				}
			}
		}
	}
	if err == nil {
		err = saveCtx.Err()
	}
	if err == nil && !time.Now().Before(s.receipt.ExpiresAt) {
		err = context.DeadlineExceeded
	}
	if err != nil {
		s.receipt.Status = "error"
		if errors.Is(err, context.DeadlineExceeded) {
			s.receipt.Status = "expired"
		}
		if _, status, cleanupErr := h.deleteAuthFileByName(context.Background(), record.ID); cleanupErr != nil && status != http.StatusNotFound {
			s.receipt.Status = "interrupted"
		}
		if syncRemoteDirectory(h.cfg.AuthDir) != nil {
			s.receipt.Status = "interrupted"
		}
	} else {
		s.receipt.Status = "complete"
	}
	s.record = nil
	s.operation = nil
	s.cancel()
	if h.writeRemoteReceipt(id, s) != nil {
		s.receipt.Status = "interrupted"
	}
	c.JSON(200, remoteDTO(s))
}
func (h *Handler) CancelEnterpriseRemote(c *gin.Context) {
	id := c.Param("id")
	s := h.remoteGet(id)
	if s == nil {
		c.JSON(200, gin.H{"status": "cancelled"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
	}
	s.record = nil
	s.operation = nil
	// Cancel and commit serialize. Also undo a just-committed attempt if authority was lost.
	if s.receipt.Status == "complete" || s.receipt.Status == "saving" || s.receipt.Status == "interrupted" {
		if _, status, err := h.deleteAuthFileByName(context.Background(), "enterprise-"+id+".json"); err != nil && status != http.StatusNotFound {
			c.JSON(503, gin.H{"error": "cancellation not confirmed"})
			return
		}
	}
	if syncRemoteDirectory(h.cfg.AuthDir) != nil {
		c.JSON(503, gin.H{"error": "cancellation not confirmed"})
		return
	}
	s.receipt.Status = "cancelled"
	if h.writeRemoteReceipt(id, s) != nil {
		c.JSON(503, gin.H{"error": "cancellation not confirmed"})
		return
	}
	c.JSON(200, remoteDTO(s))
}
