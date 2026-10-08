# Pi Durable and conversation streaming

Enterprise follows the WovenMatter-first policy: develop and prove agent behavior
in WovenMatter, then port it here with source provenance, Enterprise adaptations,
and explicit acceptance evidence. See [AGENTS.md](../../AGENTS.md).

This port starts from [WovenMatter PR #105](https://github.com/wovenmatter/wovenmatter/pull/105)
for the durable agent and [PR #110](https://github.com/wovenmatter/wovenmatter/pull/110)
for streaming, at merged source commit
`5542b83ab2e11cc3c24037552883e2c6814bd596`. The TypeScript runtime embeds the
upstream JavaScript module graph; the Swift persistence and transcript behavior
is reimplemented in SQLite, HTTP and React.

## Behavior and parity

| WovenMatter behavior | Enterprise implementation and proof |
| --- | --- |
| Durable native session, admitted inputs, steering, stop and reopen | Embedded DefaultAgentEngine and Pi Durable 1.1.0 retain native history under the existing isolated session. Deterministic engine tests exercise real requests, input receipts, tool use, cancellation, deduplication and reopening. |
| Native subagents and defaults | Copied subagent orchestration and context ownership; per-conversation Code Mode, concurrency 2–24 and composer thinking controls. Child runs inherit Enterprise's authorized route and filesystem boundary. Settings apply on the next idle turn. |
| Provider context and compaction | Copied native context, compaction registry, provider continuation and archive contracts, adapted to the scoped Enterprise gateway. External endpoints require HTTPS; the exact runtime-owned loopback relay is allowed only with Enterprise-issued route metadata. Provider-specific tests are separate from live-provider acceptance. |
| SDK lifecycle | Immutable approved generations contain the engine and complete locked dependency closure. An owner can select an approved generation for an idle conversation, preserving native history. |
| Chronological commentary and work | Stable native message/tool/thought identities, final snapshot corrections, contiguous work groups, standalone subagent/proposal rows and a final response outside completed work. Failures remain visible when completed work folds. |
| Task progress | Only native execution checklists feed the badge above the composer. Proposals remain transcript content. Checklist replace, merge and clear operations retain their native meaning. |
| Large output and reconnect | Compact summaries refresh independently of full detail. Full text is paged lazily; framed replacements become visible atomically. Scrolling up or opening work pauses follow; Latest reply resumes it. |
| Native history | Original native captures and presentation events are retained independently of the UI projection. Authorized users can search, open individual captures and export NDJSON. |

Pi Durable is the only harness for project and asset conversations. Creation
asks for access only, and model selection lives beside the composer so it can
change between turns in the same workspace and durable native history. The composer has no tool or permission selector: Read-only versus Full access is fixed Enterprise sandbox authorization chosen at launch, separate from Pi native full-access tools. Omitted models resolve through the user's persisted
default model, then the first authorized catalog model. When no model is
available, the session opens with an unselected model and message admission is
blocked until a valid model is chosen.

Enterprise authorization remains authoritative for project, asset, file, model
and connection access. The agent receives an ephemeral scoped gateway capability,
not host provider credentials. Subagents cannot broaden the route or permissions
of the parent run. Anthropic runs through the official Claude Agent SDK inside Pi, including native compaction and continuation. Its API key and endpoint come from the scoped central gateway; SDK sign-in and desktop account discovery are not used. The central inference pool supplies session affinity; it does not expose a strict upstream account pin. Enterprise preserves the authorized pool/model/session boundary and does not present pool affinity as an individual provider-account guarantee.

## Maintaining and adopting SDK updates

The lockfile makes a reviewed build reproducible; it does not freeze sessions to
one SDK release forever. Maintainers update and validate the runtime in this
repository, then publish complete approved generations. Sessions never install
unreviewed registry updates during a run.

The supervisor reads its catalog from `<journalRoot>/approved-sdk` (or the
configured `sdkCatalogRoot`). Project runtimes receive the catalog read-only at
`/opt/runtime/approved-sdk`. Publish only to that operator-owned directory,
never to a project or agent-writable directory. Existing project containers
created before this feature need the normal idle runtime rollout to acquire
the new mount; retain their volumes, placements and session files.

From a reviewed checkout with the supported Node/npm toolchain:

```sh
node platform/tools/pi-sdk-catalog.mjs build \
  --catalog "$APPROVED_SDK_CATALOG" \
  --id "$REVIEWED_GENERATION_ID" \
  --label "Reviewed Pi Durable update" \
  --source-commit "$(git rev-parse HEAD)" \
  --default

node platform/tools/pi-sdk-catalog.mjs verify \
  --catalog "$APPROVED_SDK_CATALOG" --id "$REVIEWED_GENERATION_ID"
```

The publisher uses the committed lockfile, validates the complete file graph,
imports the embedded runtime without calling a provider, and atomically publishes
the generation. Generation IDs are immutable. The loader checks catalog
approval, complete hashes, platform, dependency metadata and the generation
protocol on every load; paths, symlinks, missing files and modified bytes are
rejected. The current adapter accepts reviewed stable Pi 1.x generations,
including later minor releases; incompatible major changes require an adapter
review.

Setting the catalog default affects new conversations. In an existing Pi
conversation, open Settings, choose Check for updates, select an available
version and Apply version. This requires an idle conversation and owner/editor
authority. Activation durably fences input and stops the retained worker and its
background processes before clearing the fence. Native history is preserved.
If stopping fails, the fence remains for normal recovery; the UI must not imply
that an old worker is running the new version. Selecting a previous approved
generation uses the same workflow for rollback.

Keep prior generations while any conversation still selects them. A catalog
entry or settings value alone is not deployment proof: validate the actual
selected runtime bytes and provider-free execution before offering an update.

## Streaming storage and validation

Native capture, projected activity and the durable runtime cursor commit in one
SQLite transaction. The summary feed pages 200 rows, using revision plus ordinal
for updates; rows sharing one settlement revision cannot be skipped. Details
page 32,768 Unicode code points at a fixed revision. An obsolete revision is
reported explicitly rather than joining text from different snapshots. Full
response Copy fetches the complete selected revision.

Every summary, detail, archive and export request repeats current conversation
authorization. Export rechecks it between pages. The API grants no direct filesystem access or access to another session's archive. Existing
transcript records continue to render through the legacy read path.

Run the repository checks, rendered browser suite and dependency audit.
Native runtime fixtures must use disposable workspaces and synthetic provider
responses. The isolated CI container job proves namespace/security boundaries;
do not install its host policies on a shared deployment host. Human acceptance
still covers real provider entitlement, native continuation/compaction with the
configured connections, concurrent subagents, steering/cancellation, SDK update
and rollback, and the private deployed build.


A session Stop retains Enterprise's immediate capability withdrawal and complete
namespace teardown, including detached processes. A replacement namespace is
admitted only after the prior owner has closed; its startup removes only empty
Pi UUID owner-lock directories through a pinned, no-symlink directory lookup.
The durable journal is retained. This adapts WovenMatter's heartbeat lock to
Enterprise's forced namespace termination without shortening its ownership lease.
