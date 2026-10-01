# Architecture

One Fastify coordinator owns authentication, current membership checks, durable jobs, threads, file metadata and reports. SQLite runs in a dedicated worker with WAL and atomic batches. Multiple API replicas over one state directory are unsupported.

| Area           | Source under platform/                               | Responsibility                                                                                |
| -------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Coordinator    | apps/api/src/app.ts, main.ts                         | API assembly, startup/recovery, host placement and egress                                     |
| Identity       | apps/api/src/auth, organizations, context.ts         | Platform accounts, scoped memberships, sessions and authorization                             |
| Projects       | apps/api/src/projects, jobs                          | Placement, persistent provisioning, deletion/trash/restore/purge                              |
| Files          | apps/api/src/files                                   | Live shares, explicit grants, safe descriptor access, stable versions                         |
| Threads        | apps/api/src/conversations                           | Durable input order, native steering, comments, leases and revocation                         |
| Reports        | apps/api/src/library/reports.ts                      | Strict data contract, safe HTML/SVG and per-resource visibility                               |
| Inference      | apps/api/src/inference, egress                       | Organization provider connections, run/project capabilities and public-network enforcement    |
| Runtime        | packages/runtime/src                                 | Persistent project supervisor, per-process namespaces, native adapters and transport receipts |
| Host transport | deploy/client.ts, supervisor-server.ts, placement.ts | Unix/mTLS authentication, constrained paths, shared-storage probes                            |
| Browser        | apps/web/src                                         | Accessible organization, project, library, thread and recovery workflows                      |

Every operation authenticates current authority on the server. Thread authority is fixed at creation and intentionally inherited by invited participants, but direct file/library permissions remain independent. API mutation requires exact Origin plus CSRF. Secure cookies retain the host-only prefix; all visible routes and assets live under `/enterprise`.

The trusted host supervisor alone has Docker authority. Each persistent project container contains a trusted launcher. Untrusted thread and scheduled processes receive their own mount, PID, user and network namespaces, dropped capabilities, mandatory AppArmor and seccomp. Workspace binds enforce read/full access; stricter library share mounts remain read-only. Open file descriptors pin sources and native directories against pathname swaps. A per-process Unix relay reaches only the scoped inference/egress gateway. The control socket, other sessions, host and private networks remain unavailable.

Native input admission, acknowledgment and completion are distinct. The API persists input before dispatch, records uncertain delivery across lost receipts, and never silently queues a future turn as active steering. Claude results are joined to consumed input UUIDs; Pi retains subscriptions across preflight and continuations. Recovery terminates orphan processes while preserving project containers, files and durable native history.

Reports render a bounded, strict JSON schema into fixed templates. They never execute arbitrary HTML, JavaScript or generated server code. Every page and image repeats visibility and current source authorization. Full backup covers SQLite, files/versions, native state, runtime definitions and private inference state; restore authenticates the archive before writing into a new destination.
