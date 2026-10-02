package codex

import "net/http"

// SetRemoteHTTPClient supplies the transport for an embedded remote-login flow.
func (a *CodexAuth) SetRemoteHTTPClient(client *http.Client) { a.httpClient = client }
