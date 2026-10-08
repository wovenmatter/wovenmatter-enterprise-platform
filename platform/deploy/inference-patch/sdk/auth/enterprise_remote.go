// Enterprise remote sign-in uses the pinned provider helpers without CLI output.
package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/auth/claude"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/auth/codex"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/auth/xai"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/misc"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/util"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// Only Instructions is returned over management HTTP. All other fields stay in memory.
type RemoteInstructions struct {
	Flow      string    `json:"flow"`
	URL       string    `json:"url"`
	UserCode  string    `json:"user_code,omitempty"`
	ExpiresAt time.Time `json:"expires_at"`
	Interval  int       `json:"interval"`
}
type RemoteLogin struct {
	Instructions RemoteInstructions
	Wait         func(context.Context) (*coreauth.Auth, error)
	Submit       func(string) error
}

var ErrRemoteDenied = errors.New("denied")
var ErrRemoteExpired = errors.New("expired")

const ClaudeRemoteRedirect = "https://platform.claude.com/oauth/code/callback"

func StartRemoteLogin(ctx context.Context, cfg *config.Config, provider string) (*RemoteLogin, error) {
	return StartRemoteLoginWithClient(ctx, cfg, provider, nil)
}

// StartRemoteLoginWithClient supports embedded transport tests; HTTP endpoints are not configurable.
func StartRemoteLoginWithClient(ctx context.Context, cfg *config.Config, provider string, transport *http.Client) (*RemoteLogin, error) {
	switch provider {
	case "codex":
		client := util.SetProxy(&cfg.SDKConfig, &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }})
		if transport != nil {
			client = transport
		}
		started := time.Now()
		device, err := requestCodexDeviceUserCode(ctx, client)
		if err != nil {
			return nil, err
		}
		code := strings.TrimSpace(device.UserCode)
		if code == "" {
			code = strings.TrimSpace(device.UserCodeAlt)
		}
		if code == "" || device.DeviceAuthID == "" {
			return nil, errors.New("invalid device response")
		}
		interval := parseCodexDevicePollInterval(device.Interval)
		if interval <= 0 || interval > 24*time.Hour {
			return nil, errors.New("invalid poll interval")
		}
		deadline := started.Add(codexDeviceTimeout)
		if device.ExpiresIn > 0 && device.ExpiresIn < 900 {
			deadline = started.Add(time.Duration(device.ExpiresIn) * time.Second)
		}
		return &RemoteLogin{Instructions: RemoteInstructions{"device", codexDeviceVerificationURL, code, deadline, int(interval / time.Second)}, Wait: func(ctx context.Context) (*coreauth.Auth, error) {
			token, err := pollCodexDeviceToken(ctx, client, device.DeviceAuthID, code, interval)
			if err != nil {
				return nil, err
			}
			if token.AuthorizationCode == "" || token.CodeVerifier == "" || token.CodeChallenge == "" {
				return nil, errors.New("invalid exchange")
			}
			svc := codex.NewCodexAuth(cfg)
			if transport != nil {
				svc.SetRemoteHTTPClient(transport)
			}
			bundle, err := svc.ExchangeCodeForTokensWithRedirect(ctx, token.AuthorizationCode, codexDeviceTokenExchangeRedirectURI, &codex.PKCECodes{CodeVerifier: token.CodeVerifier, CodeChallenge: token.CodeChallenge})
			if err != nil {
				return nil, err
			}
			storage := svc.CreateTokenStorage(bundle)
			if storage == nil || storage.Email == "" || storage.AccessToken == "" {
				return nil, errors.New("invalid account")
			}
			return &coreauth.Auth{Provider: "codex", Storage: storage, Metadata: map[string]any{"email": storage.Email}}, nil
		}}, nil
	case "xai":
		svc := xai.NewXAIAuth(cfg)
		if transport != nil {
			svc.SetRemoteHTTPClient(transport)
		}
		started := time.Now()
		device, err := svc.StartDeviceFlow(ctx)
		if err != nil {
			return nil, err
		}
		seconds := device.ExpiresIn
		if seconds <= 0 || seconds > 1800 {
			seconds = 1800
		}
		interval := device.Interval
		if interval < 5 {
			interval = 5
		}
		link := device.VerificationURI
		if link == "" {
			link = device.VerificationURIComplete
		}
		return &RemoteLogin{Instructions: RemoteInstructions{"device", link, device.UserCode, started.Add(time.Duration(seconds) * time.Second), interval}, Wait: func(ctx context.Context) (*coreauth.Auth, error) {
			bundle, err := svc.WaitForAuthorization(ctx, device)
			if errors.Is(err, xai.ErrDeviceDenied) {
				return nil, ErrRemoteDenied
			}
			if errors.Is(err, xai.ErrDeviceExpired) {
				return nil, ErrRemoteExpired
			}
			if err != nil {
				return nil, err
			}
			storage := svc.CreateTokenStorage(bundle)
			if storage == nil || storage.AccessToken == "" {
				return nil, errors.New("invalid account")
			}
			return &coreauth.Auth{Provider: "xai", Storage: storage, Label: storage.Email, Metadata: map[string]any{"email": storage.Email, "auth_kind": "oauth"}, Attributes: map[string]string{"auth_kind": "oauth", "base_url": storage.BaseURL}}, nil
		}}, nil
	case "claude":
		pkce, err := claude.GeneratePKCECodes()
		if err != nil {
			return nil, err
		}
		state, err := misc.GenerateRandomState()
		if err != nil {
			return nil, err
		}
		svc := claude.NewClaudeAuth(cfg)
		if transport != nil {
			svc.SetRemoteHTTPClient(transport)
		}
		link, _, err := svc.GenerateRemoteAuthURL(state, pkce)
		if err != nil {
			return nil, err
		}
		codes := make(chan string, 1)
		return &RemoteLogin{Instructions: RemoteInstructions{"manual_code", link, "", time.Now().Add(5 * time.Minute), 0}, Submit: func(raw string) error {
			parts := strings.Split(strings.TrimSpace(raw), "#")
			if len(parts) > 2 || parts[0] == "" || len(raw) > 4096 || strings.ContainsAny(raw, "\r\n\t ") || (len(parts) == 2 && parts[1] != state) {
				return errors.New("invalid code")
			}
			select {
			case codes <- parts[0]:
				return nil
			default:
				return errors.New("code already submitted")
			}
		}, Wait: func(ctx context.Context) (*coreauth.Auth, error) {
			var code string
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case code = <-codes:
			}
			bundle, err := svc.ExchangeRemoteCodeForTokens(ctx, code, state, pkce)
			if err != nil {
				return nil, err
			}
			storage := svc.CreateTokenStorage(bundle)
			if storage == nil || storage.AccessToken == "" || storage.Email == "" {
				return nil, errors.New("invalid account")
			}
			metadata := map[string]any{"email": storage.Email, "account_uuid": storage.AccountUUID, "organization_uuid": storage.OrganizationUUID, "organization_name": storage.OrganizationName, claude.ClaudeDeviceIDsMetadataKey: storage.DeviceIDs}
			return &coreauth.Auth{Provider: "claude", Storage: storage, Metadata: metadata}, nil
		}}, nil
	}
	return nil, errors.New("unsupported provider")
}
