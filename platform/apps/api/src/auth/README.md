# Accounts and authorization

All application endpoints and links begin with `/enterprise`; API routes begin with `/enterprise/api`. Accounts are invitation-only, with one platform identity and any number of organization memberships. Each membership has role `admin` or `member` and `libraryAccess: read|write`. Ordinary members default to read-only library access. Legacy account role/home-organization columns are compatibility metadata, never authorization for another organization. The platform owner administers all organizations and alone creates them and selects workspace hosts. Billing is external.

Authorization rereads the enabled account and current membership server-side for every operation. Workspace membership is explicit for ordinary members and grants full shared access; organization admins and the owner have access to their workspaces. Only admins create projects and manage project membership. Library full access grants library management/share/copy/move operations without granting organization administration. Every audit operation supplies its actual organization explicitly.

`POST /organizations/:orgId/invitations` (and the `/members` alias) accepts `{email,name,role,libraryAccess?}`. A new account receives a seven-day single-use activation link and optional durable mail job. An already activated account receives the additional membership without a password or activation link. Organization admins cannot renew a pending identity from another organization; the platform owner may enroll it across organizations while rotating earlier activation links. Activation atomically consumes the hashed token, sets an asynchronous scrypt password and enables the account. No public registration or default password exists.

Member PATCH manages the scoped role/library access; DELETE removes that organization's membership, its project/thread memberships and scoped grants/invitations. The platform account, other organizations and browser sessions remain, with current authorization denying removed access. Administrators cannot remove their own last applicable admin authority through this endpoint. An owner cannot be created by invitation.

The platform owner alone uses `GET/POST /accounts`, `PATCH /accounts/:userId`, `POST /accounts/:userId/invitations`, and `GET /platform/settings`. Accounts may exist without any organization. Creation accepts `{email,name?,orgId?,role?:"admin"|"member"}` and safely reuses an activated account without replacing credentials. Pending invitation renewal invalidates earlier tokens. Disabled platform accounts lose sessions and reset/activation tokens globally. The owner cannot be disabled, demoted, deleted, or duplicated, including at the database boundary.

## Sessions and reset

`POST /login`, `/activate` and `/password-reset/confirm` require the exact configured Origin. Authenticated browser mutations also require `x-csrf-token`. Sessions last12 hours and use random256-bit bearer cookies; only their hashes are stored. HTTPS uses `__Host-wme_session`, HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain. Path=/ is required by the host cookie prefix; application endpoints remain under `/enterprise`. Local HTTP uses `wme_session` scoped to `/enterprise`. Browser JavaScript never receives upstream credentials. Do not enable arbitrary forwarded-IP trust.

`GET /session` returns `{user,csrfToken}` or null fields. `/me` reads accessible organizations/projects and permits only personal name/theme updates. Organization responses derive role/library access from that membership. Login, logout and reset follow protected session handling; reset revokes all prior sessions.

`POST /password-reset/request {email}` returns a generic202 whether the account exists or is limited. `POST /organizations/:orgId/members/:userId/password-reset` allows a current scoped admin to queue the same flow without revealing a token or reset URL. Tokens expire after one hour, are single-use, and have transaction-time per-account and IP limits. Mail jobs check current validity and are never automatically replayed after an uncertain SMTP result. Tests never contact real recipients.

## Durable operations and setup

SQLite runs in a dedicated worker with WAL, foreign keys and FULL synchronous durability. `batch` uses immediate transactions and `expectChanges` fences concurrent updates. The bounded RPC queue returns503 under overload. Agents never mount the control database.

Jobs use lease tokens, renewal and fenced completion. Project provisioning starts the persistent runtime before reporting ready; missing runtime support fails explicitly. Deletion immediately denies ordinary access and stops the runtime, retaining data for30 days. Admin-only deleted-project endpoints restore pinned placement, recover ordinary files to the organization library, or purge after expiry. Mail delivery and uncertain native operations are not replay-safe.

Bootstrap a fresh database through the compiled `cli.js bootstrap-owner`, with private `WME_OWNER_EMAIL`, `WME_OWNER_NAME`, `WME_STATE_DIR`, and password stdin or mounted secret file. No source state is imported and no identity belongs in public configuration. Bootstrap refuses to replace an existing owner. Schema upgrades preserve safe development databases; they are not a production import procedure.

Workspace access is binary: every current member has full shared access to workspace chats, files, notes and assets. Legacy read grants and chat modes migrate to write. Organization library grants and explicit library-share policies retain their independent read/write restrictions.

For independent deployments sharing a hostname (even on different ports), set a distinct `WME_SESSION_COOKIE_NAME`, such as `wme_pr3_dev_session`. The validated lowercase name receives the `__Host-` prefix automatically on HTTPS, retaining Secure, HttpOnly, Path=/ and no Domain. Each instance reads, rotates and clears only its own cookie. The default remains `wme_session`.
