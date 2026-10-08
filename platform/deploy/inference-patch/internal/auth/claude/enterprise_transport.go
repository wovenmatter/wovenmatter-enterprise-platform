package claude

import "net/http"

// SetRemoteHTTPClient supplies the transport for an embedded remote-login flow.
func (a *ClaudeAuth) SetRemoteHTTPClient(client *http.Client) { a.httpClient = client }
