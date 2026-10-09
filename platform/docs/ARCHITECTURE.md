# Architecture

## WovenMatter-first parity

Enterprise agent features are built and proven in WovenMatter first, then
ported here with an explicit source PR/commit and a parity acceptance matrix.
Ports may adapt storage, API and React surfaces to Enterprise boundaries, but
must preserve the reviewed behavior: authority checks, durable input admission,
native session identity, cancellation fences, archive completeness, and
provider-free deterministic validation. New Enterprise-only shortcuts are not a
substitute for upstream parity evidence.

One Fastify coordinator owns authentication, current membership checks, durable jobs, threads, file metadata and assets. SQLite runs in a dedicated worker with WAL and atomic batches. Multiple API replicas over one state directory are unsupported.

| Area           | Source under platform/                               | Responsibility                                                                                |
| -------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Coordinator    | apps/api/src/app.ts, main.ts                         | API assembly, startup/recovery, host placement and egress                                     |
| Identity       | apps/api/src/auth, organizations, context.ts         | Platform accounts, scoped memberships, sessions and authorization                             |
| Projects       | apps/api/src/projects, jobs                          | Placement, persistent provisioning, deletion/trash/restore/purge                              |
| Files          | apps/api/src/files                                   | Live shares, explicit grants, safe descriptor access, stable versions                         |
| Threads        | apps/api/src/conversations                           | Durable input order, native steering, comments, leases and revocation                         |
| Assets         | apps/api/src/library/assets.ts + reports.ts          | Strict data contract, safe HTML/SVG and per-resource visibility                               |
| Inference      | apps/api/src/inference, egress                       | Organization provider connections, run/project capabilities and public-network enforcement    |
| Runtime        | packages/runtime/src                                 | Persistent project supervisor, per-process namespaces, native adapters and transport receipts |
| Host transport | deploy/client.ts, supervisor-server.ts, placement.ts | Unix/mTLS authentication, constrained paths, shared-storage probes                            |
| Browser        | apps/web/src                                         | Accessible organization, project, library, thread and recovery workflows                      |

Every operation authenticates current authority on the server. Thread authority is fixed at creation and intentionally inherited by invited participants, but direct file/library permissions remain independent. API mutation requires exact Origin plus CSRF. Secure cookies retain the host-only prefix; all visible routes and assets live under `/enterprise`.

The trusted host supervisor alone has Docker authority. Each persistent project container contains a trusted launcher. Untrusted thread and scheduled processes receive their own mount, PID, user and network namespaces, dropped capabilities, mandatory AppArmor and seccomp. Workspace binds enforce read/full access; stricter library share mounts remain read-only. Open file descriptors pin sources and native directories against pathname swaps. A per-process Unix relay reaches only the scoped inference/egress gateway. The control socket, other sessions, host and private networks remain unavailable.

Native input admission, acknowledgment and completion are distinct. The API persists input before dispatch, records uncertain delivery across lost receipts, and never silently queues a future turn as active steering. Claude results are joined to consumed input UUIDs; Pi retains subscriptions across preflight and continuations. Recovery terminates orphan processes while preserving project containers, files and durable native history.

Asset drafts, private previews and immutable publication versions render a bounded, strict JSON schema into fixed templates. They never execute arbitrary HTML, JavaScript or generated server code. Every page and image repeats visibility and current source authorization. Full backup covers SQLite, files/versions, native state, runtime definitions and private inference state; restore authenticates the archive before writing into a new destination.

Assets are prepared through a dedicated conversation, associated lazily with that asset. It never imports an existing private thread. A project asset uses its project's persistent container and shared files, alongside ordinary sessions. An organization asset has explicit asset ownership, its own durable filesystem/native history, and a separate container started only for an admitted prompt. Organization ownership does not make private work files or conversation history part of the shared library. Selected organization sources mount read-only; project assets inherit current project shares and their stricter modes.

Standalone compute rests after `WME_ASSET_IDLE_SECONDS` (300 by default, supported range 30–86400) without queued or live work. API disconnects do not cancel it. Durable admission leases serialize with conditional idle release at the supervisor; delayed cleanup cannot stop a newer admission. Files and history survive idle or container restart, while process memory and background processes do not. A new explicit message resumes work; interrupted prompts are never automatically replayed. Stop fences the asset's thread, including retained children, even before first compute. It does not stop a linked project's container or sibling sessions.

An active run receives only its own asset draft capability through the existing session broker. `wme-asset context` reads the current revision and authorized source manifest; `wme-asset save FILE.json` validates bounded content and performs a revision-and-authority checked save. It cannot publish or choose another asset. Generated `workspace:` data/image references become immutable private output snapshots. These references survive idle, subsequent file edits and publication-version restore; other assets and raw library routes cannot read them. Existing project/library file references continue to read current authorized data on every render. This distinguishes generated output versions from live source references. Publishing remains an explicit editor action, separate from agent work.

See the [Pi Durable port guide](PI_DURABLE_PORT.md) for WovenMatter provenance, behavioral parity, approved SDK publication and conversation adoption.
