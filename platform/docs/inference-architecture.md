# Central inference

WovenMatter Enterprise Platform owns organization authorization, UI, admin audit records, provider connection metadata and run-scoped inference grants. A separately pinned CLIProxyAPI v8 process per organization owns upstream OAuth access/refresh tokens, API keys, credential refresh, cooldowns, account priority and account selection. Do not combine organizations into one proxy pool.

The Go source pin is `acdace936fa7df2905500c7f5e0a97d683138dea`, MIT. References checked against that revision: `docs/management-api-v8.md`, `internal/api/server_management_v8.go`, `internal/api/handlers/management/auth_files.go`, `auth_files_fields.go`, `auth_files_refresh.go`, `api_key_usage.go`, `oauth_callback.go`, `config.example.yaml`, `sdk/cliproxy/auth/selector.go`, and `sdk/cliproxy/session/identity.go`. Old SDK examples targeting v6 are not used.

## Deployment contract

`ProxyRegistry.resolve(orgId)` returns `{baseUrl,managementKey,clientKey}` for an existing organization service; `ensure(orgId)` provisions or starts that service and returns it. Only the privileged host supervisor performs container operations. Ordinary API handlers cannot supply paths, images or commands. Organization IDs must map to distinct private origins, secret sets and credential directories. The API does not receive a Docker socket.

The API must reach private proxy management and inference; project networks must not. The registry is operator-owned, with restrictive directories/files. Credential directories/configs are writable by the proxy and absent from project mounts. Config preserves existing accounts on restart. Upstream credential refresh is exclusively proxy-owned. The bundled proxy control panel and discovery broadcast are disabled. HTTP request logging/debug are disabled; diagnostics must not expose bodies/keys.

Bootstrap configuration uses v8 `server`, `management`, `access.api-keys`, `oauth.auth-dir`, `routing`, and `observability` fields. Management and client keys are different high-entropy random credentials. Round-robin routing with session affinity keeps requests consistent within a conversation; account priority determines preference on fresh or failed bindings. Extra retry rounds are disabled. Restart is not a credential reset.

## Administration

Only current organization admins/platform owners can create or remove connections, initiate subscriptions, submit callbacks, refresh, or view account/usage details. Subscription choices OpenAI, Claude, Grok do not discriminate by consumer/business plan. Claude starts require the explicit account-restriction notice acknowledgement. OAuth state belongs to an organization, initiating admin and expiring server-side session. Callback URLs are parsed, never fetched; supplied state must match. A callback acceptance is pending until proxy reports persistence complete.

API keys are write-only inputs, verified by model discovery before proxy configuration. Discovery resolves destination addresses before connecting and pins that address with TLS hostname verification. It rejects redirects, credentials/query strings in URLs and private-address destinations, unless deployment configuration explicitly approves an origin. OpenRouter and custom compatible models are discovered automatically. DNS rebinding after configuration is additionally addressed by host proxy egress policy: deny private/loopback/link-local/metadata network destinations unless explicitly required. Selection UI uses real returned models.

The application database stores account metadata, OAuth session state, and hashes of internal run tokens. It does not store upstream API keys/access tokens/refresh tokens. Admin responses use explicit safe DTOs. In particular, CLIProxyAPI `/observability/usage/api-keys` map keys contain actual upstream API keys, and `/credentials` can contain account identifiers, filesystem paths and token claims; these endpoints are never passed through to a browser. Refresh responses can contain a complete credential and are discarded.

## Runtime gateway

`issueGateway({orgId,projectId,userId,runId,model,harness,conversationId?})` issues a random capability token with at most 24h lifetime, storing only its hash. The gateway URL is `/enterprise/api/runtime/inference/:projectId`. Runtime receives this internal token, never proxy management/client credentials or upstream subscriptions.

Supported endpoints: GET `/v1/models`; POST `/v1/responses`, `/v1/responses/compact`, `/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`. Everything else is absent. Models sent on inference calls must equal the model bound to the run token. Current active-run, user, project and conversation access is checked before each request and every second during streaming. Cancellation or access removal aborts the upstream stream. The runtime service must also stop local processes and revoke mounts; aborting inference alone does not revoke filesystem authority.

Caller cookies, authorization headers and arbitrary routing overrides are never forwarded. The API supplies the private proxy client key and a server-owned conversation affinity header. A bounded Anthropic beta feature header may pass through. Gateway upstream HTTP failures are reduced to a generic status without copying potentially sensitive bodies. There is no automatic application retry after unknown side effects. Each organization has its own pool; selecting individual connection IDs is rejected instead of silently ignored. Admin account priority supports preferred/backup selection.

## Validation and limits

Tests use actual SQLite worker connections and deterministic proxy HTTP response fixtures. They exercise org/admin isolation, per-run/model scoping, revocation, callback state binding, API shape, config updates, secret redaction, DNS restrictions and failure propagation. Fixtures are not live provider acceptance. Real account sign-in and native provider execution must be completed by the user using their own accounts; the implementation agent must not operate authentication UI.

Usage currently exposes proxy-observed request successes/failures and subscription availability/cooldown timestamps. It does not fabricate billing totals, token costs or percentage remaining. Provider-specific quota observations may be absent or stale. A connection that cannot be confirmed is marked as requiring attention; failures are never reported as successful model runs.

The baseline does not include an OCR or document-indexing pipeline.
