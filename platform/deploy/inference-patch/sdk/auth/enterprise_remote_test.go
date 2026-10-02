package auth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	log "github.com/sirupsen/logrus"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
)

type remoteRoundTrip func(*http.Request) (*http.Response, error)

func (f remoteRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestEnterpriseRemoteProviderTransports(t *testing.T) {
	var logs bytes.Buffer
	old := log.StandardLogger().Out
	log.SetOutput(&logs)
	defer log.SetOutput(old)
	defer func() {
		for _, secret := range []string{"private-token", "private-refresh", "private-device", "private-verifier", "DISPLAY-CODE", "manual-code"} {
			if strings.Contains(logs.String(), secret) {
				t.Error("provider secret logged")
			}
		}
	}()

	for _, provider := range []string{"codex", "claude", "xai"} {
		t.Run(provider, func(t *testing.T) {
			var calls atomic.Int32
			verifier := ""
			state := ""
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/accounts/deviceauth/usercode":
					io.WriteString(w, `{"device_auth_id":"private-device","user_code":"DISPLAY-CODE","interval":"1","expires_in":60}`)
				case "/api/accounts/deviceauth/token":
					var b map[string]string
					json.NewDecoder(r.Body).Decode(&b)
					if b["device_auth_id"] != "private-device" || b["user_code"] != "DISPLAY-CODE" {
						t.Error("device request lost binding")
					}
					io.WriteString(w, `{"authorization_code":"private-grant","code_verifier":"private-verifier","code_challenge":"challenge"}`)
				case "/oauth/token":
					r.ParseForm()
					if r.Form.Get("code") != "private-grant" || r.Form.Get("code_verifier") != "private-verifier" || r.Form.Get("redirect_uri") != "https://auth.openai.com/deviceauth/callback" {
						t.Error("wrong device exchange")
					}
					claims := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"fixture@example.test","https://api.openai.com/auth":{"chatgpt_account_id":"fixture"}}`))
					json.NewEncoder(w).Encode(map[string]any{"access_token": "private-token", "refresh_token": "private-refresh", "id_token": "e30." + claims + ".x", "expires_in": 3600})
				case "/.well-known/openid-configuration":
					io.WriteString(w, `{"device_authorization_endpoint":"https://auth.x.ai/device","token_endpoint":"https://auth.x.ai/token"}`)
				case "/device":
					io.WriteString(w, `{"device_code":"private-device","user_code":"DISPLAY-CODE","verification_uri":"https://accounts.x.ai/oauth2/device","interval":1,"expires_in":60}`)
				case "/token":
					r.ParseForm()
					if r.Form.Get("device_code") != "private-device" {
						t.Error("wrong device")
					}
					io.WriteString(w, `{"access_token":"private-token","refresh_token":"private-refresh","expires_in":3600}`)
				case "/v1/oauth/token":
					var b map[string]string
					json.NewDecoder(r.Body).Decode(&b)
					if b["code"] != "manual-code" || b["state"] != state || b["code_verifier"] == "" || b["redirect_uri"] != ClaudeRemoteRedirect {
						t.Error("manual exchange lost binding")
					}
					verifier = b["code_verifier"]
					io.WriteString(w, `{"access_token":"private-token","refresh_token":"private-refresh","expires_in":3600,"account":{"email_address":"fixture@example.test","uuid":"fixture-account"},"organization":{"uuid":"fixture-org"}}`)
				case "/api/oauth/profile":
					io.WriteString(w, `{"account":{"email":"fixture@example.test","uuid":"fixture-account"},"organization":{"uuid":"fixture-org"}}`)
				case "/api/oauth/claude_cli/roles":
					io.WriteString(w, `{}`)
				default:
					t.Errorf("unexpected provider path %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			local, _ := url.Parse(server.URL)
			client := &http.Client{Transport: remoteRoundTrip(func(r *http.Request) (*http.Response, error) {
				if !strings.HasSuffix(r.URL.Host, "openai.com") && !strings.HasSuffix(r.URL.Host, "x.ai") && !strings.HasSuffix(r.URL.Host, "claude.com") && !strings.HasSuffix(r.URL.Host, "anthropic.com") {
					t.Fatal("unexpected host")
				}
				clone := r.Clone(r.Context())
				copyURL := *r.URL
				copyURL.Scheme = local.Scheme
				copyURL.Host = local.Host
				clone.URL = &copyURL
				return http.DefaultTransport.RoundTrip(clone)
			})}
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			flow, err := StartRemoteLoginWithClient(ctx, &config.Config{}, provider, client)
			if err != nil {
				t.Fatal(err)
			}
			encoded, _ := json.Marshal(flow.Instructions)
			if strings.Contains(string(encoded), "private-") {
				t.Fatal("private device secret in instructions")
			}
			if provider == "claude" {
				if flow.Instructions.Flow != "manual_code" || strings.Contains(flow.Instructions.URL, "localhost") {
					t.Fatal("not remote")
				}
				u, _ := url.Parse(flow.Instructions.URL)
				state = u.Query().Get("state")
				if u.Query().Get("redirect_uri") != ClaudeRemoteRedirect || u.Query().Get("code_challenge") == "" {
					t.Fatal("missing remote PKCE")
				}
				if flow.Submit("manual-code#wrong") == nil {
					t.Fatal("accepted wrong state")
				}
				if err = flow.Submit("manual-code#" + state); err != nil {
					t.Fatal(err)
				}
			} else if flow.Instructions.Flow != "device" || flow.Instructions.UserCode != "DISPLAY-CODE" {
				t.Fatal("missing device instructions")
			}
			record, err := flow.Wait(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if record == nil || record.Storage == nil {
				t.Fatal("no credential record")
			}
			if provider == "claude" && verifier == "" {
				t.Fatal("no private verifier")
			}
			if calls.Load() < 2 {
				t.Fatal("protocol not exercised")
			}
		})
	}
}
func TestEnterpriseRemoteCancellationBeforePolling(t *testing.T) {
	client := &http.Client{Transport: remoteRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/api/accounts/deviceauth/usercode" {
			t.Fatal("cancelled attempt polled")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"device_auth_id":"private","user_code":"code","interval":30}`)), Header: http.Header{}}, nil
	})}
	flow, err := StartRemoteLoginWithClient(context.Background(), &config.Config{}, "codex", client)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = flow.Wait(ctx); err == nil {
		t.Fatal("cancel ignored")
	}
}

func TestEnterpriseRemoteProviderBackoffDenialAndExpiry(t *testing.T) {
	for _, provider := range []string{"codex", "xai"} {
		t.Run(provider, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				polls := 0
				started := time.Now()
				var previous time.Time
				client := &http.Client{Transport: remoteRoundTrip(func(r *http.Request) (*http.Response, error) {
					body := `{}`
					status := 200
					switch r.URL.Path {
					case "/api/accounts/deviceauth/usercode":
						body = `{"device_auth_id":"private","user_code":"display","interval":1,"expires_in":30}`
					case "/.well-known/openid-configuration":
						body = `{"device_authorization_endpoint":"https://auth.x.ai/device","token_endpoint":"https://auth.x.ai/token"}`
					case "/device":
						body = `{"device_code":"private","user_code":"display","verification_uri":"https://accounts.x.ai/oauth2/device","interval":5,"expires_in":30}`
					case "/api/accounts/deviceauth/token", "/token":
						polls++
						minimum := time.Second
						if provider == "xai" {
							minimum = 5 * time.Second
						}
						if polls == 1 {
							if time.Since(started) < minimum {
								t.Error("polled before provider interval")
							}
							body = `{"error":"slow_down"}`
							previous = time.Now()
						} else {
							if time.Since(previous) < minimum+5*time.Second {
								t.Error("ignored backoff")
							}
							body = `{"error":"access_denied","error_description":"PRIVATE-DIAGNOSTIC"}`
						}
						status = 400
					default:
						t.Fatalf("unexpected endpoint %s", r.URL.Path)
					}
					return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
				})}
				flow, err := StartRemoteLoginWithClient(context.Background(), &config.Config{}, provider, client)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = flow.Wait(context.Background()); !errors.Is(err, ErrRemoteDenied) {
					t.Fatalf("denial not classified: %v", err)
				}
				if polls != 2 {
					t.Fatal("unexpected poll count")
				}
			})
		})
	}
	synctest.Test(t, func(t *testing.T) {
		calls := 0
		client := &http.Client{Transport: remoteRoundTrip(func(r *http.Request) (*http.Response, error) {
			calls++
			body := `{"device_auth_id":"private","user_code":"display","interval":5,"expires_in":2}`
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
		})}
		flow, err := StartRemoteLoginWithClient(context.Background(), &config.Config{}, "codex", client)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithDeadline(context.Background(), flow.Instructions.ExpiresAt)
		defer cancel()
		if _, err = flow.Wait(ctx); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("expiry not enforced")
		}
		if calls != 1 {
			t.Fatal("polled beyond expiry")
		}
	})
}
