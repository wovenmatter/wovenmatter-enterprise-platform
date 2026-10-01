# Central inference API

All browser endpoints below begin `/enterprise/api/organizations/:orgId/inference` and require an organization admin/owner, except GET models also permits organization members. All mutations require normal session Origin/CSRF checks. List fields camelCase; never return upstream secrets/configs/raw proxy errors. No employee-owned connections.

- `GET /accounts` → `{configured:boolean,items:[{id,type:'subscription'|'api_key',provider:'openai'|'anthropic'|'xai'|'openrouter'|'custom',label,status,enabled,available?,priority?,successes?,failures?,nextRetryAt?,lastRefreshAt?,createdAt?}],notice:string}`. No proxy returns configured:false, empty items.
- `POST /accounts` `{provider,label,apiKey,baseUrl?,models?:string[]}` → account. Providers openai/anthropic/xai/openrouter/custom. `baseUrl` only used for custom; public HTTPS custom origins are allowed; private origins require deployment approval. `models` optional; saving verifies the key with the provider and discovers models automatically. Optional supplied selections must exist in the discovered catalog. Server URL/key fields write-only; never retained in frontend state after save.
- `POST /discover` `{provider,apiKey,baseUrl?}` → `{items:[{id,name,provider}]}`. Resolves/pins destination DNS, blocks private targets unless operator-approved, never redirects or echoes the key.
- `PATCH /accounts/:accountId` `{enabled?:boolean,priority?:integer(-1000..1000),label?:string}` → `{ok:true}`. Higher priority preferred; same priority round robin. Subscription labels come from provider identity, API labels editable.
- `DELETE /accounts/:accountId` → `{ok:true}`.
- `POST /accounts/:accountId/refresh` → `{ok:true}`. Subscription only. Upstream refresh failures remain failures, never simulated.
- `POST /oauth` `{provider:'openai'|'anthropic'|'xai',acceptedRisk?:boolean}` → `{id,url,userCode?,expiresAt}`. Frontend offers user link/open action; never automated by build/test agents. Anthropic requires explicit acceptedRisk true after displaying notice.
- `GET /oauth/:sessionId` → `{status:'pending'|'complete'|'error'|'cancelled',message?}`. Poll only while pending. Completion means the proxy exchange/persistence finished.
- `POST /oauth/:sessionId/callback` `{redirectUrl:string}` → `{status:'pending'}`. User pastes the callback URL for remote/headless OAuth. Callback must have same state and code; backend parses but never visits URL. Do not log callback URL/code or put it in app URL/history.
- `DELETE /oauth/:sessionId` → `{status:'cancelled'}`.
- `GET /models` → `{items:[{id,name,provider}]}`. Real proxy catalog only; empty if unconfigured.
- `GET /usage` → `{items:[{provider,successes,failures}],observedAt?}`. Aggregate counts observed by proxy. Not billing, remaining balance or fabricated percentages.

Claude notice: “Using a Claude subscription through this third-party proxy may result in Anthropic restricting, suspending, or terminating your account. Continued access is not guaranteed.”

Internal-only InferenceService: constructor(ctx,{registry,canUseRun,runtimeApiOrigin?,customProviderOrigins?,fetcher?}); await initialize(); issueGateway({orgId,projectId,userId,runId,model,harness}) returns {baseUrl,token}; revokeGateway(runId); validateSelection(orgId,model,harness,connectionId?); models(orgId). Selected connections currently pooled through admin priorities; request an available model without connectionId. A separate account selector cannot silently be ignored.
