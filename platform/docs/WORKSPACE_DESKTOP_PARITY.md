# Workspace desktop parity

Desktop reference: wovenmatter main **07e7bdaa6cbca9eb9bf4994d3a1fde1bfc28b43f** (2026-10-26). This first port establishes settings, typed tools, speech/history, measured usage and durable visual replies. Cloud automation families continue in a dependent change; they are not represented by inactive controls.

| Desktop source / behavior | Enterprise implementation | Acceptance |
|---|---|---|
| SettingsView.swift destinations / harness icons | Nested workspace settings for General, Background execution, Dictation, Pi Durable, Codex, Claude Code, Grok Build, OpenCode, Workspace, Usage. Distinct existing harness logos. | desktop/mobile real API browser flow |
| General appearance / sidebar | Existing account theme API and account-scoped browser sidebar preferences | real API persistence and existing sidebar suite |
| General shared default tools | Private user defaults; per-agent organization/project defaults take priority; captured once at creation | private preferences and snapshot tests |
| General calendar access | Private account read-only/full agent calendar policy; broker checks every mutation; human editor remains available | read-only broker regression |
| General dictation language | Browser language tag/Automatic, saved per user | speech fixture → saved setting |
| General conversation titles | Names first user prompt locally, preserves custom names; no separate billed title model | same durable admission |
| General updater, Keychain, sleep/power/lid | Managed cloud release/server credentials and persistent container; Mac power/Keychain actions omitted | accurate explanatory UI |
| General connected apps, session limits | Cloud automation/service controls continue in dependent port; runtime capacity remains enforced by existing platform policies | no fake controls |
| Harness Accounts | Existing organization inference connections; admin-managed credentials; no secrets in browser/runtime | authorization/secret metadata tests |
| Harness Chat settings scope | Organization-shared defaults, per-workspace per-harness override/inheritance. Existing legacy project settings remain intact. | inheritance, stale revision and upgrade tests |
| Harness model / thinking | Authorized organization model catalog, model-specific thinking, native permission choices | validation and five harness UI flows |
| Pi Code mode / subagents | Existing runtime options, 2–24 child cap, new-chat snapshot | baseline runtime suite and persisted UI |
| Pi models / default / fallback | Searchable visible composer models; default always available; ordered fallbacks only at new admission. Active runs never switch accounts. | validation/new-chat regression |
| Pi web search | Exa/Brave/Firecrawl contracts from default-agent/search.mjs; coordinator stores keys privately and brokers calls | deterministic provider contracts/redaction |
| Workspace software / SDK | Persistent Docker volumes and supervisor retained; included five harnesses; existing per-chat approved SDK generations remain pinned | baseline container/SDK tests |
| Background Server / managed activity | Scoped active/queued runs and scheduled work, status/observed timestamp and existing Stop action. No host-wide stop/start or desktop daemon introduced. | scoped inventory and browser flow |
| Dictation recording/transcription/history | Explicit microphone start/stop; browser speech service; drafts reviewed before send; user-private persistent paged history/copy/delete | synthetic speech, real persistence, navigation |
| Usage accounts / limits | Existing managed connection/account usage. Actual provider-reported workspace tokens, date/agent/model filters; missing prices remain unavailable. No invented account quota. | exact aggregation / unknown data tests |
| Woven MCP notes/history/calendar/library/usage/databases | Typed catalog and stdio facade, same current-run capability broker, repeated membership/group/attachment checks | actual stdio broker acceptance, Pi tool loop, ACP descriptor |
| Woven MCP HTML | Durable page/activity, visible outside collapsed work; reload replays page. Opaque sandbox, parent-source checked resize, bounded zoom and explicit external-link confirmation. | real API publication + browser interaction/reload |
| MCP sessions/goals/timers/browser/executor | Additional cloud-capable families continue in the dependent automation port; current typed catalog does not claim these capabilities. | dependent parity matrix |
| MCP physical computer/devices/remote hosts | Excluded by requested cloud workspace scope | no host-control grants |
| Chat composer/attachments/tool menus/native streaming/history | Retained existing implementation; new welcome draft storage survives settings navigation; existing suites cover source attachments, uncertainty and canonical replay | full regression suite |

Cloud HTML applies a stricter network/resource policy than desktop's isolated nonpersistent WebKit store: scripts cannot contact networks, use workspace/browser cookies, access the parent or read files. Images must be inlined as data URLs. Ordinary Markdown continues to reject executable/raw HTML and tracking images. The visual tool publishes explicit durable pages; it does not make ordinary Markdown executable. The 2 MiB cloud page limit fits existing broker/admission bounds.

Browser speech may use the browser vendor's speech service; the application never promises Apple on-device processing. Only completed text is stored on the server. All automated verification uses synthetic pre-established sessions and deterministic providers, without operating login/authentication UI or calling paid inference.
