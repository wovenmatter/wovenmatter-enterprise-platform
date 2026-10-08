# Threads and native execution

All routes below begin with `/enterprise/api`. `POST /projects/:projectId/conversations` accepts `{title,mode:"read"|"write",model,harness?,connectionId?}`. Model availability is checked centrally. Supported harnesses are Codex, Claude, Grok and Pi; the authoritative catalog determines an omitted harness. Settings require an idle thread. The creation mode never changes, including through PATCH or database updates.

Threads are private to their creator. Any participant can add a currently eligible same-project user with `POST /conversations/:id/members {userId}`. `/eligible-members` includes current explicit project members, organization admins and the owner. There is no individual thread-member removal. Loss of project or organization access revokes thread access and active authority. Only the creator changes settings or deletes the thread; every participant may message, steer and cancel.

A read-only project member can create only a read-only thread. When invited to a full thread, that participant intentionally directs full agent authority inside that thread. This does not permit direct file writes, library administration or access to another private thread. Share-specific read-only mounts remain strict. Runtime and inference validate current project/thread access rather than borrowing a creator identity.

## Messages and receipts

`POST /conversations/:id/messages {content,requestId,kind?:"message"|"comment"}` durably admits a request before dispatch. IDs use8–100 URL-safe characters. Same-user, same-content retries return the original receipt; conflicting reuse returns409. Messages retain author identity and a server-assigned sequence. The most recent200 messages are available through `/messages?before=<messageId>`.

An ordinary message starts an idle agent or steers its active native execution. During preparation it joins the initial snapshot or waits for the live steering channel; it never silently becomes a later run. At most50 undelivered inputs are admitted. A Comment neither starts nor steers; it appears in subsequent agent context. One database lease permits one active execution per thread; different threads share a project workspace concurrently.

Delivery is `pending`, `accepted`, `rejected`, `uncertain`, or `comment`. Dispatch alone is not acceptance. Native receipts confirm initial input and ordered steering; loss of transport after possible delivery remains uncertain. Rejected and uncertain inputs are not automatically replayed. Native provider limitations produce explicit constraint errors. Codex uses turn/steer with expected turn identity, Grok uses native interjection, Claude tracks consumed input UUIDs, and Pi uses its streaming steering/preflight contract. Synthetic protocol tests do not establish live provider-account compatibility.

`GET /conversations/:id/runs` returns recent durable runs. `/cancel {runId?}` revokes inference and stops the execution process and descendants. If termination cannot be confirmed, the run stays cancelling and retains its lease while cleanup retries. Gateway failure cannot skip the stop attempt. Runtime errors expose safe codes and messages, never raw credentials.

## Recovery, events and sources

SSE `/conversations/:id/events?after=<cursor>` also accepts Last-Event-ID. Events have durable IDs and include input delivery, run state, assistant deltas, tools, citations and membership changes. Clients replay by cursor and refresh canonical state. Authorization is rechecked each second and access revocation closes the stream. Slow consumers disconnect safely. HTTP shutdown closes streams before database shutdown.

API recovery stops only uncertain thread processes, leaving persistent project containers running. Unknown dispatched work becomes interrupted and is not repeated. A deliberate new message may resume the latest durable native identity matching harness/model/mode, including an interrupted session. Native history lives outside shared workspace files in the current thread's private mount. Files, installed tools and schedule definitions survive project restarts; process memory does not.

Before dispatch, current authorized file IDs, paths and immutable versions form a bounded source manifest. `GET /conversations/:id/runs/:runId/sources` reports availability at dispatch. Explicit citations are accepted only against that manifest and remain subject to current download ACLs. Availability is not proof the model read a file or verified a page. Generated reports read current authorized sources independently on each page load.

Global/organization capacity defaults to8/4 active executions, configurable1–64. Atomic database admission prevents oversubscription across dispatch connections. Saturated organizations do not block other organizations. Capacity waiting does not impose a project-wide queue, change thread mode, or turn active steering into a new queued turn. Uncertain stopping leases continue consuming capacity until acknowledged.
