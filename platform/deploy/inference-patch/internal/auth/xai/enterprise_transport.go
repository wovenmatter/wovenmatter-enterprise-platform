package xai

import "net/http"

// SetRemoteHTTPClient supplies the transport for an embedded remote-login flow.
func (a *XAIAuth) SetRemoteHTTPClient(client *http.Client) { a.httpClient = client }
