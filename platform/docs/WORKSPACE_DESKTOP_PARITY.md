# Workspace desktop parity

Reviewed desktop main **75f6903a7aed988dd61d6084d23f51642e678435** on 2026-10-26. The application/runtime implementation is unchanged from **07e7bdaa6cbca9eb9bf4994d3a1fde1bfc28b43f**; the intervening commits change CI/release instructions and documentation. Source paths below are relative to wovenmatter. Enterprise retains its persistent project Docker container, mounted files/private native history, supervisor, tenant authorization and managed inference pool.

| Desktop control / owning source | Enterprise result | Evidence / deliberate adaptation |
|---|---|---|
| Settings landing · SettingsView.swift | General, Background execution, Dictation, five harnesses, Workspace, Usage | Nested routes, existing distinct harness glyphs, Back restores chat selection; desktop/mobile browser flows |
| General · release updates | Managed application release | Cloud updates are operator actions; no Mac updater control |
| General · saved Keychain credentials | Existing organization Connections | Server-only secrets/admin role; browser never receives manager keys; no account login/recovery performed |
| General · harness setup | Workspace runtime inventory + Connections | Included image versions, organization accounts; no device installer |
| General · theme | Green/Cognac/Dark | Existing account preference, immediate selection |
| General · sidebar layout | Existing account/browser sidebar variants | Immediate, persistence/storage-error handling |
| General · Notes/History/Calendar/Library/Usage defaults | Private user defaults | New chats snapshot once; per-agent org/workspace values take priority; existing chats unchanged |
| General · Sessions/Timers/Browser/Executor defaults | Current typed tool groups | Executor off by default; persisted old choices normalized with new safe defaults |
| General · calendar access | Private full/read-only agent policy | Rechecked for each mutation; human calendar editor retains its existing authority |
| General · maximum managed sessions | Private 1–16 coordinator limit | Default 4; existing execution capacity still applies; creation/consent tests |
| General · Executor service | Operator-approved V2 origin, org-admin configuration | Existing upstream broker; manager material stays server-side; no host installation/deployment |
| General · Executor default app profiles | Org-admin defaults, explicit per-chat grants | Agents cannot select profiles or approve themselves |
| General · outside-agent MCP access | Explicit user/project read-only grants, off by default | Selected read scopes, 1–168 hour expiry, hashed bearer, one-time token display and revoke; existing HTTPS listener, host/origin checks, no cookie/CORS expansion |
| General · dictation language | Automatic or saved language tag | Browser speech language; private per-user value |
| General · automatic titles | First-message fallback plus optional model generation | Opt-in authorized OpenAI model/thinking; asynchronous, short bounded naming request, capacity gate, durable no-replay receipt |
| General · title model/thinking/refresh | Authorized org catalog and capability levels | Empty/incomplete/uncertain result keeps fallback; custom/manual title fences even identical text; title usage retained separately |
| General · awake on external power | Cloud execution owner | Browser closure does not stop container; no physical power control |
| General · awake on battery | Cloud execution owner | Battery condition does not apply |
| General · closed lid on external power/battery/helper approval | Cloud execution owner | No Mac helper, Login Items or system power authority |
| General · product/device analytics | Existing platform operational usage | Desktop device telemetry collection is not introduced; no inactive analytics toggle |
| Every harness · Accounts | Existing org Connections | Pi, Codex, Claude Code, Grok Build, OpenCode; server credentials and existing consent/cleanup boundary |
| Every harness · account/workspace scope | Org-shared defaults + project overrides | Org configuration authority required; revision conflicts reject stale saves; inherited values visible |
| Every harness · default model | Authorized model catalog | Native model IDs retained; no active account switch |
| Every harness · thinking level | Selected model capabilities | Invalid levels rejected; clearing follows provider default |
| Native harnesses · permissions | Existing native permission mapping | Confirmed per-chat approvals remain authoritative; container/library limits unchanged |
| Every harness · MCP tool defaults | Typed scoped tool settings | Creation snapshot; current controls rechecked for every broker operation |
| Pi · code mode On/Only/Off | Existing Pi options | New-chat default plus existing per-chat between-turn controls |
| Pi · concurrent subagents 2–24 | Existing Pi child cap | Parent excluded; new-chat snapshot |
| Pi · provider/search key accounts | Exa, Brave, Firecrawl | Org-admin keys private on coordinator, status-only browser response; deterministic request/redaction tests |
| Pi · search provider | Exa/Brave/Firecrawl contracts | Brave context search; Exa/Firecrawl page read; no invented Brave read |
| Pi · visible models/order | Search, provider filter, enabled-only and reorder | Catalog is already the org-approved pool; lab/subscription facets unavailable in Enterprise metadata are not fabricated |
| Pi · default/fallback models/order | Explicit default and ordered fallback controls | Admission-only availability fallback; active work never silently moves accounts |
| Pi · catalog refresh | Refresh options | Separate loads, retry/error state; no hidden credential action |
| Pi · custom local image icon | Established Pi glyph retained | Local file/icon personalization omitted; distinct harness recognition preserved |
| Dictation · record/stop | Explicit microphone controls | Browser recognition start/stop, reviewable composer draft; no auto-send |
| Dictation · transcription | Browser/vendor recognition | Cloud receives completed text only; Apple on-device processing is not claimed |
| Dictation · history list/search | User-private persistent paged history | No seeded production sample records or silent retention truncation |
| Dictation · detail/copy/delete | Current owner's text | Synthetic speech → persistence → navigation browser test |
| Usage · provider account limits | Existing managed connection usage | Unknown/unexposed limits stay unavailable; org credentials do not enter settings |
| Usage · independent loading | Existing parallel account/usage resources | Settings routes lazy; fetch/poll listeners cleaned up on route exit |
| Usage · measured totals | Native input/output/cache/total tokens and actual cost | Date/model/harness filters; no estimated price or fabricated usage |
| Usage · naming requests | Separate title_generation group | Retained actual title response tokens; unknown measurements remain unknown |
| Workspace · local root selection | Persistent cloud project root | No host path picker; folders/workspace mapping retain current authorization |
| Workspace · runtime inventory/install/update | Five image-contained harnesses, approved SDK catalog | Image update is operator-maintained; per-chat SDK generation remains pinned |
| Workspace · default agent | Existing org/project inheritance | Old persisted project defaults retained |
| Workspace · members/connections/files | Existing routes and permissions | Universal header, admin/org routing and shared/read-only library preserved |
| Background · owner/status/refresh | Current persistent container/supervisor status | Observed/disconnected state and scoped active/queued runs |
| Background · stop active work | Existing current-run/thread Stop | Stops namespace/descendants, pauses unattended goal/timers, revokes app work; siblings remain |
| Background · host server Start/Stop/Restart | Operator deployment lifecycle | No host-wide server authority exposed to workspace agents/users |
| Background · coordination consent | Current-project human approval | Pending is not approval; new grant gets new epoch; stale sends denied |
| Background · scheduled work | Existing calendar/scheduler plus chat timers | Current authorization/serial admission; no burst/replay after uncertainty |
| Chat · composer/harness/model/thinking/tools | Existing controls plus new typed groups | Full baseline interaction/viewport/focus suite |
| Chat · attachments/private history/streaming | Existing immutable attachment and canonical replay | Existing large-file/native history/current-run broker tests |
| Chat · draft preservation | Welcome drafts keyed by user/project/harness | Settings navigation preserves dictated draft |
| Chat · interactive HTML | Durable explicit visual tool + chat replay | Opaque sandbox, no parent/same-origin/cookie/filesystem authority, source-checked resize, zoom/link confirmation |
| Performance · browser viewer | Lazy frontend page; lazy server Chromium | Viewer attaches to existing native environment and never creates/replays an agent turn |
| Performance · Executor | Lazy server SDK/service connection | No heavy app client loaded into browser; no service request before configuration/use |

| MCP family / desktop owning source | Cloud mapping and authority | Acceptance |
|---|---|---|
| Notes/artifacts/versions · WovenMCPCatalog.swift | Typed broker to current project content service | Read/write/revision conflicts; current-run group/membership |
| History · WorkspaceAgentTools | Current authorized workspace chats, bounded messages/chunks/native history | Attached private sources retain current immutable authority |
| Calendar/tasks | Existing scoped events/tasks and schedule admission | Read-only agent preference and scheduled share revocation |
| Library | Current authorized library resources | Read-only imported shares remain read-only |
| Databases | Managed project databases through Notes authority | Existing SQLite parser/storage limits |
| Usage | Actual scoped aggregate | Tenant/filter/unknown measurement tests |
| Search/read | Server-key Exa/Brave/Firecrawl | Fixed provider origins, redirects rejected, keys redacted |
| HTML | Persistent conversation page/activity | Broker UUID idempotence; real API publication/reload; no network/resources except inlined data images |
| Sessions list/status/folders/harnesses | Current project catalog/status | No cross-project or asset-chat coordination |
| Sessions create | Existing ConversationService admission, inherited permissions/tools | Explicit delegation instruction; managed cap; durable receipt prevents uncertain replay |
| Sessions manage/send/release/notifications | Human-approved current epoch; completion comments | Fresh membership before admission; group revocation; no silent unattended wake |
| Goals | One persistent goal per chat | Explicit intent; same execution owner; fresh membership, checkpoint and budget gates; missing usage/failure blocks continuation |
| Timers | Same-chat future instructions | Revision-fenced edits; missed intervals skip bursts; durable admission, pause on Stop/disable |
| Browser | Chromium inside retained agent namespace | Existing UID/bwrap/seccomp/AppArmor/netnamespace; forced authenticated proxy, no CDP port; URL/file/redirect/private checks |
| Browser human viewer | API → supervisor → retained worker IPC | Current membership/group; enable works without new native turn; disable/Stop denies immediately |
| Browser retry/cancel | Request UUID receipts and fresh screenshot frame IDs | Interrupted operations require state inspection; no automatic input replay |
| Executor configure/inventory/defaults | Operator origin allowlist + org admin service key | Fixed-origin/redirect rejection; service manager app excluded; secrets never in runtime |
| Executor search/skills/execute/status/cancel | Selected per-chat app profiles and upstream V2 managed MCP | Real synthetic HTTP/OAuth-machine-grant/MCP integration; no actual account UI operated |
| Executor approvals/input/revocation | Native confirmed Full Access or human response | Pending approval is not approval; schema validation; fresh membership after connection before dispatch; no uncertain replay |
| Outside-agent access | Stateless read-only MCP on existing application HTTPS | Real HTTP initialize/list/call; selected scopes, no mutations/native private history, expiry/revoke/current membership and tenant checks before returning data |\n| Physical computer/device/remote machine control | Excluded by user scope | No device/host grants |

Harness shared/project settings use explicit atomic Save because several clients can edit the same revision. General toggles/selections apply immediately; compound forms display errors and retain edits. This deliberate cloud coordination choice does not alter existing chats. Refresh/navigation loads confirmed values.

HTML uses a stricter cloud resource policy than desktop's nonpersistent WebKit store: no external network or external images. Images must be inlined data URLs. Ordinary Markdown remains non-executable. A published page is limited to 2 MiB.

The browser runs Chromium with no zygote/single-process inside the existing nested agent boundary, avoiding new AppArmor host policy grants for Chromium's seqpacket zygote IPC. It receives no host browser/profile or network authority. The human and agent share only that chat's isolated browser.

Validation uses synthetic pre-established sessions, deterministic provider responses and disposable containers. No real account authentication/recovery or paid provider calls are performed. Actual shared-preview signed-in browser testing requires an already-authenticated user session; none was available.
