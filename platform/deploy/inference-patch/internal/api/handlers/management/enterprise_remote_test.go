package management

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/auth/claude"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/auth/codex"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/auth/xai"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/watcher/synthesizer"
	login "github.com/router-for-me/CLIProxyAPI/v8/sdk/auth"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"golang.org/x/crypto/bcrypt"
)

func remoteRouter(h *Handler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	g := r.Group("/v8/management")
	g.Use(h.Middleware())
	g.POST("/oauth/remote", h.StartEnterpriseRemote)
	g.GET("/oauth/remote/:id", h.GetEnterpriseRemote)
	g.POST("/oauth/remote/:id/code", h.SubmitEnterpriseRemote)
	g.POST("/oauth/remote/:id/commit", h.CommitEnterpriseRemote)
	g.DELETE("/oauth/remote/:id", h.CancelEnterpriseRemote)
	return r
}
func remoteHandler(t *testing.T, dir string) *Handler {
	t.Helper()
	secret, err := bcrypt.GenerateFromPassword([]byte("fixture-management"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{AuthDir: dir}
	cfg.RemoteManagement.SecretKey = string(secret)
	cfg.RemoteManagement.AllowRemote = true
	return NewHandlerWithoutConfigFilePath(cfg, coreauth.NewManager(nil, nil, nil))
}
func remoteRequest(t *testing.T, r http.Handler, method, path, body string) map[string]any {
	t.Helper()
	req := httptest.NewRequest(method, "http://localhost/v8/management/oauth/remote"+path, strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:4000"
	req.Header.Set("Authorization", "Bearer fixture-management")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("%s %s returned %d: %s", method, path, w.Code, w.Body.String())
	}
	var value map[string]any
	if json.Unmarshal(w.Body.Bytes(), &value) != nil {
		t.Fatal("invalid response")
	}
	return value
}
func remoteAwait(t *testing.T, r http.Handler, id, status string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if remoteRequest(t, r, "GET", "/"+id, "")["status"] == status {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("did not reach %s", status)
}
func TestEnterpriseRemoteManagementAdmissionCancelRestartAndSave(t *testing.T) {
	h := remoteHandler(t, t.TempDir())
	r := remoteRouter(h)
	var starts atomic.Int32
	approve := make(chan struct{})
	h.remoteStore().start = func(ctx context.Context, cfg *config.Config, provider string) (*login.RemoteLogin, error) {
		starts.Add(1)
		return &login.RemoteLogin{Instructions: login.RemoteInstructions{Flow: "device", URL: "https://auth.openai.com/codex/device", UserCode: "DISPLAY", ExpiresAt: time.Now().Add(time.Minute), Interval: 5}, Wait: func(ctx context.Context) (*coreauth.Auth, error) {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-approve:
			}
			return &coreauth.Auth{Provider: "codex", Metadata: map[string]any{"type": "codex", "access_token": "private-fixture-token"}}, nil
		}}, nil
	}
	const id = "11111111-1111-4111-8111-111111111111"
	req := httptest.NewRequest("POST", "http://localhost/v8/management/oauth/remote", strings.NewReader(`{"id":"`+id+`","provider":"codex"}`))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code == 200 {
		t.Fatal("unauthenticated admission")
	}
	first := remoteRequest(t, r, "POST", "", `{"id":"`+id+`","provider":"codex"}`)
	if first["flow"] != "device" {
		t.Fatal("missing flow")
	}
	remoteRequest(t, r, "POST", "", `{"id":"`+id+`","provider":"codex"}`)
	if starts.Load() != 1 {
		t.Fatal("duplicate grant")
	}
	// Browser has no continuing request. Approval still completes to the private ready state.
	close(approve)
	remoteAwait(t, r, id, "ready")
	if _, err := os.Stat(filepath.Join(h.cfg.AuthDir, "enterprise-"+id+".json")); !os.IsNotExist(err) {
		t.Fatal("saved without authority confirmation")
	}
	complete := remoteRequest(t, r, "POST", "/"+id+"/commit", `{}`)
	if complete["status"] != "complete" {
		t.Fatal(complete)
	}
	remoteRequest(t, r, "POST", "/"+id+"/commit", `{}`)
	data, err := os.ReadFile(filepath.Join(h.cfg.AuthDir, "enterprise-"+id+".json"))
	if err != nil || !bytes.Contains(data, []byte("private-fixture-token")) {
		t.Fatal("not durably saved")
	}
	second := remoteRouter(remoteHandler(t, h.cfg.AuthDir))
	if remoteRequest(t, second, "GET", "/"+id, "")["status"] != "complete" {
		t.Fatal("restart lost receipt")
	}
	// A cancellation racing after commit removes only this attempt's unique file.
	remoteRequest(t, r, "DELETE", "/"+id, "")
	if _, err = os.Stat(filepath.Join(h.cfg.AuthDir, "enterprise-"+id+".json")); !os.IsNotExist(err) {
		t.Fatal("cancelled save survived")
	}
	const pendingID = "22222222-2222-4222-8222-222222222222"
	remoteRequest(t, r, "POST", "", `{"id":"`+pendingID+`","provider":"codex"}`)
	remoteAwait(t, r, pendingID, "ready")
	restarted := remoteRouter(remoteHandler(t, h.cfg.AuthDir))
	if remoteRequest(t, restarted, "GET", "/"+pendingID, "")["status"] != "interrupted" {
		t.Fatal("restart must not replay")
	}
	if remoteRequest(t, restarted, "POST", "", `{"id":"`+pendingID+`","provider":"codex"}`)["status"] != "interrupted" {
		t.Fatal("restarted admission replay")
	}
	remoteRequest(t, r, "DELETE", "/"+pendingID, "")
}
func TestEnterpriseRemoteCancellationFencesLateProviderSuccessAndExpiry(t *testing.T) {
	h := remoteHandler(t, t.TempDir())
	r := remoteRouter(h)
	finish := make(chan struct{})
	h.remoteStore().start = func(context.Context, *config.Config, string) (*login.RemoteLogin, error) {
		return &login.RemoteLogin{Instructions: login.RemoteInstructions{Flow: "device", ExpiresAt: time.Now().Add(time.Minute)}, Wait: func(context.Context) (*coreauth.Auth, error) { <-finish; return &coreauth.Auth{Provider: "codex"}, nil }}, nil
	}
	const id = "33333333-3333-4333-8333-333333333333"
	remoteRequest(t, r, "POST", "", `{"id":"`+id+`","provider":"codex"}`)
	remoteRequest(t, r, "DELETE", "/"+id, "")
	close(finish)
	remoteAwait(t, r, id, "cancelled")
	if _, err := os.Stat(filepath.Join(h.cfg.AuthDir, "enterprise-"+id+".json")); !os.IsNotExist(err) {
		t.Fatal("late success saved")
	}
	h.remoteStore().start = func(context.Context, *config.Config, string) (*login.RemoteLogin, error) {
		return &login.RemoteLogin{Instructions: login.RemoteInstructions{Flow: "device", ExpiresAt: time.Now().Add(20 * time.Millisecond)}, Wait: func(ctx context.Context) (*coreauth.Auth, error) { <-ctx.Done(); return nil, ctx.Err() }}, nil
	}
	const expired = "44444444-4444-4444-8444-444444444444"
	remoteRequest(t, r, "POST", "", `{"id":"`+expired+`","provider":"codex"}`)
	remoteAwait(t, r, expired, "expired")
}
func TestEnterpriseRemoteManagementUsesRealProviderTransport(t *testing.T) {
	// The route invokes the compiled provider SDK. This transport cannot contact a provider.
	h := remoteHandler(t, t.TempDir())
	r := remoteRouter(h)
	client := &http.Client{Transport: remoteManagementTransport(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/api/accounts/deviceauth/usercode" {
			t.Fatalf("unexpected initiation path %s", req.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"device_auth_id":"NEVER-EXPOSE","user_code":"DISPLAY","interval":30}`))}, nil
	})}
	h.remoteStore().start = func(ctx context.Context, cfg *config.Config, provider string) (*login.RemoteLogin, error) {
		return login.StartRemoteLoginWithClient(ctx, cfg, provider, client)
	}
	const id = "55555555-5555-4555-8555-555555555555"
	value := remoteRequest(t, r, "POST", "", `{"id":"`+id+`","provider":"codex"}`)
	data, _ := json.Marshal(value)
	if bytes.Contains(data, []byte("NEVER-EXPOSE")) || value["user_code"] != "DISPLAY" {
		t.Fatal("wrong structured response")
	}
	remoteRequest(t, r, "DELETE", "/"+id, "")
}

type remoteManagementTransport func(*http.Request) (*http.Response, error)

func (f remoteManagementTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestEnterpriseRemoteSavedCredentialsRegisterAllProvidersAndReceiptsAreNotAccounts(t *testing.T) {
	for _, provider := range []string{"codex", "claude", "xai"} {
		t.Run(provider, func(t *testing.T) {
			h := remoteHandler(t, t.TempDir())
			r := remoteRouter(h)
			h.SetPostAuthPersistHook(func(ctx context.Context, a *coreauth.Auth) error {
				if a.Metadata["access_token"] != "fixture-token" || a.Metadata["refresh_token"] != "fixture-refresh" {
					t.Fatal("registration lost credentials")
				}
				if provider == "codex" && a.Metadata["account_id"] != "fixture-account" {
					t.Fatal("lost Codex account")
				}
				if provider == "claude" && (a.Metadata["account_uuid"] != "fixture-account" || a.Metadata["organization_uuid"] != "fixture-org") {
					t.Fatal("lost Claude identity")
				}
				if provider == "xai" && (a.Metadata["auth_kind"] != "oauth" || a.Metadata["token_endpoint"] != "https://auth.x.ai/token") {
					t.Fatal("lost xAI refresh/usage configuration")
				}
				_, err := h.authManager.Register(coreauth.WithSkipPersist(ctx), a)
				return err
			})
			h.remoteStore().start = func(context.Context, *config.Config, string) (*login.RemoteLogin, error) {
				a := &coreauth.Auth{Provider: provider, Metadata: map[string]any{"email": "fixture@example.test"}}
				switch provider {
				case "codex":
					a.Storage = &codex.CodexTokenStorage{AccessToken: "fixture-token", RefreshToken: "fixture-refresh", AccountID: "fixture-account", Email: "fixture@example.test"}
				case "claude":
					a.Storage = &claude.ClaudeTokenStorage{AccessToken: "fixture-token", RefreshToken: "fixture-refresh", AccountUUID: "fixture-account", OrganizationUUID: "fixture-org", Email: "fixture@example.test", DeviceIDs: []string{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
				case "xai":
					a.Storage = &xai.TokenStorage{AccessToken: "fixture-token", RefreshToken: "fixture-refresh", AuthKind: "oauth", TokenEndpoint: "https://auth.x.ai/token", BaseURL: xai.DefaultAPIBaseURL}
				}
				return &login.RemoteLogin{Instructions: login.RemoteInstructions{Flow: "device", ExpiresAt: time.Now().Add(time.Minute)}, Wait: func(context.Context) (*coreauth.Auth, error) { return a, nil }}, nil
			}
			const id = "66666666-6666-4666-8666-666666666666"
			remoteRequest(t, r, "POST", "", `{"id":"`+id+`","provider":"`+provider+`"}`)
			remoteAwait(t, r, id, "ready")
			if remoteRequest(t, r, "POST", "/"+id+"/commit", `{}`)["status"] != "complete" {
				t.Fatal("not complete")
			}
			registered := h.authManager.List()
			if len(registered) != 1 || registered[0].Provider != provider || registered[0].Status != coreauth.StatusActive {
				t.Fatal("not registered as active")
			}
			info, err := os.Stat(filepath.Join(h.cfg.AuthDir, "enterprise-"+id+".json"))
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatal("unsafe credential permissions")
			}
			scanned, err := synthesizer.NewFileSynthesizer().Synthesize(&synthesizer.SynthesisContext{Config: h.cfg, AuthDir: h.cfg.AuthDir, Now: time.Now(), IDGenerator: synthesizer.NewStableIDGenerator()})
			if err != nil || len(scanned) != 1 || scanned[0].Provider != provider {
				t.Fatal("receipt was scanned as account")
			}
			request := httptest.NewRequest("GET", "http://localhost/credentials", nil)
			rec := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(rec)
			c.Request = request
			h.ListAuthFiles(c)
			if rec.Code != 200 || strings.Contains(rec.Body.String(), ".enterprise-signin") || strings.Contains(rec.Body.String(), "fixture-token") {
				t.Fatal("credential listing includes receipt or token")
			}
			remoteRequest(t, r, "DELETE", "/"+id, "")
			if len(h.authManager.List()) != 0 {
				t.Fatal("revocation did not remove runtime record")
			}
		})
	}
}
func TestEnterpriseRemoteConcurrentProviderConflict(t *testing.T) {
	h := remoteHandler(t, t.TempDir())
	r := remoteRouter(h)
	entered := make(chan struct{})
	release := make(chan struct{})
	var starts atomic.Int32
	h.remoteStore().start = func(context.Context, *config.Config, string) (*login.RemoteLogin, error) {
		starts.Add(1)
		close(entered)
		<-release
		return &login.RemoteLogin{Instructions: login.RemoteInstructions{Flow: "device", ExpiresAt: time.Now().Add(time.Minute)}, Wait: func(ctx context.Context) (*coreauth.Auth, error) { <-ctx.Done(); return nil, ctx.Err() }}, nil
	}
	const id = "77777777-7777-4777-8777-777777777777"
	done := make(chan struct{})
	go func() { defer close(done); remoteRequest(t, r, "POST", "", `{"id":"`+id+`","provider":"codex"}`) }()
	<-entered
	req := httptest.NewRequest("POST", "http://localhost/v8/management/oauth/remote", strings.NewReader(`{"id":"`+id+`","provider":"xai"}`))
	req.RemoteAddr = "127.0.0.1:4000"
	req.Header.Set("Authorization", "Bearer fixture-management")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 409 {
		t.Fatalf("mismatched provider got %d", w.Code)
	}
	close(release)
	<-done
	if starts.Load() != 1 {
		t.Fatal("duplicate admission")
	}
	remoteRequest(t, r, "DELETE", "/"+id, "")
}

func TestEnterpriseRemoteExpiryDuringSaveAndCorruptReceiptNeverReplay(t *testing.T) {
	h := remoteHandler(t, t.TempDir())
	r := remoteRouter(h)
	h.remoteStore().start = func(context.Context, *config.Config, string) (*login.RemoteLogin, error) {
		return &login.RemoteLogin{Instructions: login.RemoteInstructions{Flow: "device", ExpiresAt: time.Now().Add(80 * time.Millisecond)}, Wait: func(context.Context) (*coreauth.Auth, error) {
			return &coreauth.Auth{Provider: "codex", Metadata: map[string]any{"type": "codex", "access_token": "fixture-token"}}, nil
		}}, nil
	}
	h.SetPostAuthPersistHook(func(ctx context.Context, a *coreauth.Auth) error { <-ctx.Done(); return ctx.Err() })
	const id = "88888888-8888-4888-8888-888888888888"
	remoteRequest(t, r, "POST", "", `{"id":"`+id+`","provider":"codex"}`)
	remoteAwait(t, r, id, "ready")
	if remoteRequest(t, r, "POST", "/"+id+"/commit", `{}`)["status"] != "expired" {
		t.Fatal("late save survived expiry")
	}
	if _, err := os.Stat(filepath.Join(h.cfg.AuthDir, "enterprise-"+id+".json")); !os.IsNotExist(err) {
		t.Fatal("late credential survived")
	}
	const corrupt = "99999999-9999-4999-8999-999999999999"
	if err := os.WriteFile(h.remoteReceiptPath(corrupt), []byte("broken receipt"), 0600); err != nil {
		t.Fatal(err)
	}
	if remoteRequest(t, r, "GET", "/"+corrupt, "")["status"] != "interrupted" {
		t.Fatal("corruption not fenced")
	}
	req := httptest.NewRequest("POST", "http://localhost/v8/management/oauth/remote", strings.NewReader(`{"id":"`+corrupt+`","provider":"codex"}`))
	req.RemoteAddr = "127.0.0.1:4000"
	req.Header.Set("Authorization", "Bearer fixture-management")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 409 {
		t.Fatal("corrupt receipt resubmitted")
	}
}
