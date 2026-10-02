# Central inference API

All browser endpoints below begin `/enterprise/api/organizations/:orgId/inference` and require an organization admin/owner, except GET models also permits organization members. All mutations require normal session Origin/CSRF checks. List fields camelCase; never return upstream secrets/configs/raw proxy errors. No employee-owned connections.

- `GET /accounts` → `{configured:boolean,items:[{id,type:'subscription'|'api_key',provider:'openai'|'anthropic'|'xai'|'openrouter'|'custom',label,status,enabled,available?,priority?,successes?,failures?,nextRetryAt?,lastRefreshAt?,createdAt?}],notice:string}`. No proxy returns configured:false, empty items.
- `POST /accounts` `{provider,label,apiKey,baseUrl?,models?:string[]}` → account. Providers openai/anthropic/xai/openrouter/custom. `baseUrl` only used for custom; public HTTPS custom origins are allowed; private origins require deployment approval. `models` optional; saving verifies the key with the provider and discovers models automatically. Optional supplied selections must exist in the discovered catalog. Server URL/key fields write-only; never retained in frontend state after save.
- `POST /discover` `{provider,apiKey,baseUrl?}` → `{items:[{id,name,provider}]}`. Resolves/pins destination DNS, blocks private targets unless operator-approved, never redirects or echoes the key.
- `PATCH /accounts/:accountId` `{enabled?:boolean,priority?:integer(-1000..1000),label?:string}` → `{ok:true}`. Higher priority preferred; same priority round robin. Subscription labels come from provider identity, API labels editable.
- `DELETE /accounts/:accountId` → `{ok:true}`.
- `POST /accounts/:accountId/refresh` → `{ok:true}`. Subscription only. Upstream refresh failures remain failures, never simulated.
- `POST /oauth` `{provider:'openai'|'anthropic'|'xai',acceptedRisk?:boolean}` → a sign-in DTO. Reuses the initiating admin's pending attempt for that provider rather than starting another grant. Anthropic requires explicit notice acknowledgement.
- `GET /oauth` → `{items:SignIn[]}` for this initiating admin/organization. Navigation/reload reconnects by ID.
- `GET /oauth/:sessionId` → `SignIn`. The browser observes state; provider polling belongs to the inference process and continues without the browser.
- `POST /oauth/:sessionId/code` `{code:string}` → `{status:'pending'}`. Anthropic manual-code flow only; enter the code shown on the provider page. Never put the code in a URL, log or app history. Device flows have no callback/code input in the application.
- `DELETE /oauth/:sessionId` requests cancellation. Durable cancellation intent fences an in-flight save; cancellation is confirmed only after the exact attempt-owned credential is removed. Transient transport failures retain cancellation intent across restarts, with bounded cleanup requests and capped backoff until confirmed. An unconfirmed cancellation temporarily fences that organization's inference gateway and is never listed as a saved connection.

`SignIn` includes `{id,provider,status,message,expiresAt,flow:'device'|'manual_code'|null,interval,url?,userCode?}`. Status is starting, pending, cancelling, complete, cancelled, denied, expired, error or interrupted. Link and display code are returned only while starting/pending, to the initiating current admin. Never return device-auth IDs, PKCE verifier, tokens or upstream bodies. `interval` describes provider polling, not browser status polling. A completed state means credential persistence finished.

OpenAI and Grok use device authorization. The human opens the HTTPS verification link and enters the displayed code there. OpenAI device login is beta and may require personal/workspace security settings to enable it. Anthropic uses its provider-hosted code page with private server-owned PKCE and a manual code handoff; it is not advertised as a device protocol. No localhost listener, remote-browser callback or SSH helper is needed. The deadline is provider-derived with local upper bounds (OpenAI 15 minutes, Grok 30 minutes), or a five-minute local bound for Anthropic. The same deadline drives server and UI.

- `GET /models` → `{items:[{id,name,provider}]}`. Real proxy catalog only; empty if unconfigured.
- `GET /usage` → `{items:[{provider,successes,failures}],observedAt?}`. Aggregate counts observed by proxy. Not billing, remaining balance or fabricated percentages.

Claude notice: “Using a Claude subscription through this third-party proxy may result in Anthropic restricting, suspending, or terminating your account. Continued access is not guaranteed.”

Internal-only InferenceService: constructor(ctx,{registry,canUseRun,runtimeApiOrigin?,customProviderOrigins?,fetcher?}); await initialize(); issueGateway({orgId,projectId,userId,runId,model,harness}) returns {baseUrl,token}; revokeGateway(runId); validateSelection(orgId,model,harness,connectionId?); models(orgId). Selected connections currently pooled through admin priorities; request an available model without connectionId. A separate account selector cannot silently be ignored.
