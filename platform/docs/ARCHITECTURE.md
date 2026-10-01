# Architecture

The browser talks to one Fastify API coordinator. SQLite operations run in a
dedicated worker with WAL and atomic batches. The coordinator owns accounts,
permissions, durable jobs, conversations, file metadata, and published assets.
There is one coordinator per state directory; horizontal API replicas are not supported.

## Code map

| Area | Source | Responsibility |
| --- | --- | --- |
| API assembly | `apps/api/src/app.ts`, `main.ts` | Routes, lifecycle, supervisor admission, HTTP boundaries |
| Authentication | `apps/api/src/auth/` | Sessions, CSRF, activation and password reset |
| Foundation | `apps/api/src/context.ts`, `db/`, `organizations/`, `projects/`, `jobs/` | Current authorization, persistence, membership and durable jobs |
| Files | `apps/api/src/files/` | `storage.ts`: locking/reconciliation/versions; `access.ts`: authorization; `sharing.ts`: grants/shares/mounts; `service.ts`: file operations; `paths.ts`: safe filesystem access |
| Conversations | `apps/api/src/conversations/` | Durable admission, ordered dispatch, cancellation, recovery and events |
| Inference | `apps/api/src/inference/`, `egress/` | Organization accounts, scoped run grants, provider proxy and bounded public HTTP/S access |
| Library | `apps/api/src/library/` | `index.ts`: administration/publication; `lifecycle.ts`: source checks and recovery; `serving.ts`: isolated content; `runtime.ts`: container operations |
| Browser | `apps/web/src/` | `App.tsx`: session; `shell/`: navigation/routing; `features/`: workflows; `components/`: shared UI |
| Agents | `packages/runtime/`, `runtime/` | Native adapters, validated events, isolated execution and runner image |
| Operations | `deploy/`, `scripts/` | Trusted supervisor, configuration, backup/restore and explicit candidate acceptance |

Paths in this table are relative to `platform/`. Each API domain keeps its request
and response contract beside the implementation. Shared context and database types
are defined in source rather than duplicated in documentation.

## Behavior that refactors must preserve

- Every request and dispatch uses current organization/project/file permissions.
  Conversation sharing never grants project or filesystem access. Revocation stops
  affected streams and executions.
- Browser mutations require the exact portal Origin and CSRF token. Sessions use
  HttpOnly cookies; provider credentials never reach ordinary employees or agent mounts.
- Admission is durable before dispatch. A request identity is reused for explicit
  retry after an uncertain response. Unknown model side effects are never replayed automatically.
- File operations serialize through one per-context lock. Native edits reconcile
  into stable identities and immutable versions; path and inode checks remain at
  the filesystem boundary.
- Agents and live applications use private per-execution networks and bounded
  resources. Only the supervisor has Docker authority. Upstream credentials stay
  in private organization inference services.
- Published content has a separate origin and its own access lifecycle. Recovery
  confirms storage/source identity before reconnecting to an existing runtime.
- Full backups include files, versions, sessions, library data and private state,
  not just SQLite. Restore and production cutover are explicit operational steps.

See [development and validation](DEVELOPMENT.md), the [product scope](BUILD-SPEC.md),
and [deployment procedures](../deploy/README.md).
