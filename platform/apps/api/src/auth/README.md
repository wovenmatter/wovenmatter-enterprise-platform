# Foundation API and security model

`createDatabase(filename)` starts a dedicated Node SQLite worker. All queries, migrations, transactions and result materialization run on that worker. WAL, foreign keys, FULL synchronous durability and a busy timeout are enabled. RPC admission is bounded at 2048 pending operations; overload rejects with `code: database_busy`, `statusCode: 503`. `batch` executes an immediate transaction, and `expectChanges` fences concurrent updates. Main application code must never open the control database synchronously or mount it into agent containers.

`createContext(db, config)` provides live authorization checks. User objects are refreshed before organization/project authorization, project membership is explicit for members, and project/member read-only ceilings intersect. Owners administer every organization; admins administer their own. Every mutation of access calls the optional `onAccessChanged` hook so running work can stop promptly. Consumers must also recheck authorization during long-running work and before execution.

## Sessions

`POST /api/login {email,password}` and `POST /api/activate {token,password,name?}` require the exact configured Origin. They return `{user,csrfToken}` and an HttpOnly SameSite=Lax cookie. Passwords use asynchronous scrypt (N=32768, r=8, p=1, 32-byte random salt, 64-byte output); passwords are 12–1024 characters. Authentication attempts are bounded per remote IP; do not enable arbitrary forwarded IP trust.

Cookies last 12 hours. HTTPS uses the `__Host-wme_session` cookie name, with Secure and Path=/ and no Domain, so generated-app subdomains cannot set a portal cookie. Local HTTP uses `wme_session`. Only the SHA-256 identity of the opaque 256-bit bearer cookie is stored in SQLite. `GET /api/session` returns `{user:null,csrfToken:null}` when signed out. Browser mutations require an existing session, exact Origin and `x-csrf-token`. Login and activation create fresh sessions; logout and account removal revoke sessions. Secrets must not be logged.

Only explicitly tagged internal inference or isolated content routes bypass browser CSRF. Those routes must perform their own bearer or scoped-content authorization. Route handlers cannot opt out using a client header or a path prefix.

`ctx.getSessionId(request)` exposes the hashed database reference for content grants; it is not a bearer cookie. `ctx.isSessionActive(id,userId)` checks expiry and enabled status. Never put a portal bearer cookie on a generated-app origin.

## Accounts and projects

All response fields are camelCase. List endpoints return `{items:[...]}`. There is one organization per ordinary account; owners have no organization.

- Organization creation is owner-only: `POST /api/organizations {name}`.
- Organization admins invite using `POST /api/organizations/:orgId/invitations {email,name,role:'admin'|'member'}`. The `/members` POST alias accepts the same body. Result: `202 {user,invitation:{id,expiresAt},activationUrl,jobId}`. A durable `invitation.deliver` job contains the email and activation URL; GET job metadata never exposes that payload. The authorized invitation create/reissue response includes the activation URL once, so the administrator can copy and deliver it manually. Email delivery requires configured SMTP. Invitation expiry is seven days. Activation consumes the invitation transactionally and enables the account. Reinvitation invalidates previous unaccepted invitations; removing the member invalidates invitations and sessions.
- Member PATCH accepts `name`, `role`, and `enabled`. DELETE disables the account, removes explicit project memberships, and revokes sessions. An administrator cannot remove their own admin access through this endpoint. Owners cannot be created by invitation.
- `POST /api/organizations/:orgId/projects {name,description?,access?:'read'|'write'}` returns `202 {...Project,jobId}` with status `provisioning`. No release snapshot is required. Terminal setup failures set `needs_attention`. An administrator may call `POST /api/projects/:projectId/retry` to safely retry idempotent provisioning; the equivalent `/api/jobs/:jobId/retry` only permits that job type. Unsafe mail delivery is not automatically replayed. Project members POST accepts `{userId,access}`; PATCH accepts `{access}`.
- Project DELETE immediately changes status to `deleting`, revokes ordinary access, and queues cleanup. Control records and source files remain as tombstones for backup/restore; deletion immediately revokes project access and stops project runs and linked live assets. Physical data purging is a separate retention operation.

## Jobs and bootstrap

`createJobWorker(ctx, handlers)` accepts handlers shaped `{replaySafe,run({job,ctx,signal})}` and returns `start()`, `stop()` and `runOnce()`. Supported initial types are `project.provision`, `project.remove`, and `invitation.deliver`. The application supplies actual runtime/storage/mail handlers. Missing handlers become `needs_attention`; they never report success. Handler errors never expose credentials in job metadata.

Claims use lease tokens, periodic renewal, and fenced completion. Interrupted non-idempotent jobs become `needs_attention` instead of automatically replaying. Only handlers explicitly marked `replaySafe` retry up to the bounded attempt count. Handlers must obey cancellation and impose I/O timeouts. The mail handler must check that an invitation remains valid before sending; SMTP delivery has uncertain outcomes and is not safe to replay automatically.

Bootstrap has no default credentials. Run the compiled `cli.js bootstrap-owner` with `WME_OWNER_EMAIL`, `WME_OWNER_NAME`, and `WME_STATE_DIR`, supplying the password through `--password-stdin` or a mounted file named by `WME_BOOTSTRAP_PASSWORD_FILE`. The `WME_BOOTSTRAP_PASSWORD` environment fallback is available for local development; prefer stdin or mounted secrets so container configuration does not retain the password. It writes `WME_STATE_DIR/control/platform.sqlite` and refuses to replace an existing owner. It never prints the password. The API uses the same database path.

## Personal profile and password reset

- `GET /api/me` returns the current user and accessible organizations/projects. `PATCH /api/me` accepts only the user's own display name and Green/Cognac theme; email and privilege fields are not editable.
- `POST /api/password-reset/request {email}` returns the same generic 202 response whether the enabled, activated account exists or has exhausted its per-account quota. It requires the configured Origin and has IP/email rate limits. Tokens and mail outbox jobs are inserted atomically, with a transaction-time maximum of five reset requests per user per hour.
- `POST /api/organizations/:orgId/members/:userId/password-reset` requires owner or same-organization administrator access, rejects pending/disabled users, enforces the same shared quota, and returns no credential or reset URL. Its response indicates queuing, not SMTP delivery.
- `POST /api/password-reset/confirm {token,password}` consumes a hashed, one-hour, single-use token transactionally, invalidates all outstanding reset links, replaces the password, revokes old sessions, and creates a new session. Origin validation is required; possession of the reset token authorizes this unauthenticated flow.
- The `password_reset.deliver` job uses configured SMTP, checks token validity, and is not replayed automatically after an uncertain delivery. The protected outbox contains the reset URL for delivery; public job metadata omits payloads. No default password is introduced.
- Migration `foundation-v3-user-profile-reset` adds a Green default theme to existing accounts and the reset-token table without changing existing passwords.
