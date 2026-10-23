# WovenMatter style parity

The web UI follows the WovenMatter desktop design language. This matrix records
the native source, how each audited mismatch is resolved, and every deliberate
Enterprise difference. Keep it current when a shared token or control changes.

## Provenance

| Item | Reference |
| --- | --- |
| Native source | WovenMatter `main` at `24e503f89cfdbfc89df80bfef68d82f38baf2a35` (merge of PR #132) |
| Native files | `docs/STYLE_GUIDE.md`; `app/App/Views/DashboardColors.swift`, `DashboardStyle.swift`, `DashboardDesign.swift`, `DashboardSharedViews.swift`, `DashboardSidebar.swift`, `SettingsComponents.swift`, `SettingsGeneralView.swift`, `SettingsConnectionsView.swift`, `DashboardComposer.swift`, `DashboardConversation.swift`, `ConversationResponse.swift`, `ConversationMarkdown.swift`, `ConversationWorkTranscript.swift`, `ConversationTasksBadge.swift` |
| Installed reference | Woven Matter desktop v0.3.0 build 547 (Dark, Split Sidebar), inspected by the maintainer |
| Enterprise base | `main` at `2d6764756d6cd280f9e533a14650977239e606d4` |
| Enterprise files | `platform/apps/web/src/styles.css` (single token and component stylesheet), `components/controls.tsx` (icon roles, menu, picker, switch, search field), `components/ui.tsx` (notices, cards, destination rows, dialogs, forms, status) |

Native point values are mapped to CSS pixels; this does not claim physical display equivalence. Browser font rasterization differs from macOS;
geometry, tokens, hierarchy and interaction states are the parity target.

## Tokens

| Native | CSS custom property |
| --- | --- |
| `DashboardColors.foreground` / `mutedForeground` | `--ink`, `--muted` |
| `primary` (dynamic) / `primaryFill` / `primaryForeground` | `--primary`, `--primary-fill` (`#004225` in every theme), `--primary-foreground` |
| `background`, `success`, `warning`, `danger` | `--surface`, `--success`, `--warning`, `--danger` |
| Palette `workspace`, `themeAccent`, `themeWhisper/Soft/Strong/Ring`, `border`, `input` | `--workspace`, `--accent`, `--whisper`, `--soft`, `--strong`, `--ring`, `--line`, `--input` |
| Rail fill, rim, inner light, edge, hover rim/inner, reduced fill | `--rail-fill`, `--rail-rim`, `--rail-inner`, `--rail-edge`, `--rail-hover-rim`, `--rail-hover-inner`, `--rail-reduced` |
| `DashboardMetrics` radii and row height | `--surface-radius` 12, `--card-radius` 14, `--control-radius` 10, `--composer-radius` 18, `--row-radius` 8, `--segment-radius` 6, `--row-height` 28 |
| Lucide stroke roles (s15/s175/s20/s25) | `Icon weight="normal" / "control" / "search" / "send"` |

## Audit resolution matrix

| ID | Resolution |
| --- | --- |
| P1-01 | Tables use `--muted` headers and `--line` dividers in every theme; Markdown tables use foreground-alpha borders. No literal table colors remain. |
| P1-02 | Asset status strip uses whisper fill, `--line` border and the shared `Status` dot for ready, working, loading and error. Authored preview content is untouched. |
| P1-03 | One neutral `:focus-visible` outline (foreground at 45–50%) for every interactive class; text fields show a neutral border. No accent-colored rings; keyboard navigation unchanged. |
| P1-04 | Sidebar disclosures are `details/summary` headings: title, then a trailing 12-point chevron (right closed, down open), 26 high, 10 semibold, 12 inset, whole header toggles, no UA marker. |
| P1-05 | Shared `Menu`: top-layer popup, one interactive popup open at a time, Escape/Tab/outside dismissal, focus returns to the trigger, arrow/Home/End navigation, focus recovery to an enabled neighbor or popup surface when canonical updates disable/remove a focused item, inert disabled items, viewport-clamped and flipped near edges. Used by rail, thread and file actions. |
| P1-06 | Completed work, groups, items and archive records use one trailing chevron that rotates from right to down with state; group icons reflect running, failed, thought or tool work. |
| P2-01 | Folder, Pi Durable and All Workspaces new-chat actions are separate 24 × 28 links, 12-point plus, 8 radius, quiet whisper/soft states, always the far-right element. Folder actions menu uses the same frame before it. |
| P2-02 | Rail order: Projects back, New conversation, search, All Workspaces, owning project workspace disclosure containing Agents and Folders (8 inset, New folder first, pinned folders first), Trash, Recents, project tools. Recents lists every project conversation the API already authorizes for this user. Selecting a folder scopes new chats and lists that folder's conversations in the main pane. Native-style 260-wide hover cards show the owning project, authorized conversation count, root and reference paths; they do not cover the adjacent new-chat action. |
| P2-03 | Rail background: workspace plus theme fill, 1-point rim, inset light and 0.5 edge, hover rim with 0.22 s transition, 12 radius; reduced-transparency fill only on request. |
| P2-04 | All rails share `nav-link`: 28 high, 13 regular/medium selected, 13 glyph in 15 frame, 10 monospaced counts, 11 pin, foreground for text, metadata and icons. |
| P2-05 | Shared `SearchField`: 34 high, 13 text, 12 inset, 8 gap, 14 search glyph, whisper, 10-point Clear when populated; Escape clears a populated field. |
| P2-06 | Page inputs: 34 high, whisper, 13 text, 12 inset, 10 radius. Dialog inputs use the quiet bordered input. Selects use the 36-high quiet picker trigger. |
| P2-07 | Shared `Switch` (28 × 16, before its label, primary tint, `role="switch"`) for membership enabled, connection enabled and asset source multi-select. |
| P2-08 | Primary hover 90% / press 78%; quiet 50/72/100% soft; settings quiet clear/72/100% soft with 36 minimum height, 12 horizontal inset and 10 radius; icon whisper/soft; press scale when motion is allowed; disabled 0.4 and inert. |
| P2-09 | Send is a 36 circle with a 16 arrow at stroke 2.5, `#004225` in all themes with the Dark ring; Stop is a separate 36 circle; disabled 0.4. |
| P2-10 | Composer: folder row above the editor (`DashboardComposer.swift:88–109`), then model/thinking/fixed authority and message/comment/send controls below; 18 radius, 10 × 12 inset, 768 column, 15/20 text growing three to seven lines, focus shadow. Asset-dialog composers retain the same clear editor surface rather than inheriting metadata-field fills. Enter, Shift+Enter, IME, drafts, stop, retry and read-only states are unchanged. |
| P2-11 | Shared `Picker` with visible initial focus, keyboard dismissal even with no enabled options, and closure/inert choices when disabled during a canonical refresh, for model, thinking, folder and send mode: titled popouts (`Model`, `Thinking Level`, `Folder`, `Send As`), full labels, checked selection in readable primary, disambiguation for repeated model labels, unavailable options disabled, long unbroken model identifiers wrapped in popouts. Model change still clears thinking. |
| P2-12 | Markdown: 15 body, 680 prose, headings 22/19/17/15.5, 2-point quote bar at foreground 16%, inline code 13.5. |
| P2-13 | Markdown links use `--link` (`--success`); safe URL transform, protected source links and image suppression unchanged. |
| P2-14 | One 28-point copy action per response with status text. Code blocks show a 34-high language header with Copy; tables have Copy (plain text) and Expand (dialog) footers. Block renderer identities survive parent and canonical refreshes, including an expanded table. Copy feedback resets on changed content and ignores stale async completions. No HTML or images are rendered; protected Markdown and retained citation links share the router basename and retain project/version/page parameters. |
| P2-15 | Connections use leading-chevron provider disclosures; OpenAI/Anthropic/Grok have nested subscription/API groups, while OpenRouter API accounts sit directly beneath the provider at the same 24-point content indentation as nested credential bodies; rows keep status, priority, retry time, Manage, Refresh and Remove. |
| P2-16 | Settings pages use 16-inset, 14-radius `Card` groups on the native workspace surface; theme is chosen from previewable Green/Cognac/Dark tiles saved with the profile (explicit save retained). |
| P2-17 | Every Management entry uses `DestinationRow`: 16 icon, title/detail, trailing 11 chevron at 55%. |
| P2-18 | Dialogs set their own surface, border, shadow and scrim; normal 500/24, compact 340/16/14 title, wide 740 (1120 for asset preparation). Native `dialog` focus, Escape and stacking are retained. |
| P2-19 | Scrollbars are hidden for all app-owned scrollers; wheel, touch and keyboard scrolling still work. Text and image previews are focusable for keyboard scrolling. |
| P2-20 | `prefers-reduced-transparency` substitutes opaque rail, picker, task badge and segment fills and removes backdrop blur, independently of reduced motion. |
| P2-21 | Tasks badge attached above the composer: 24 summary, Tasks label, current step, monospaced count, 80 × 3 segments from 560 wide for 2–10 tasks, 320 list, spoken statuses. |
| P2-22 | File actions use the shared ellipsis menu (no second chevron); one primary per view; segmented Files/Assets and asset views; numeric columns right-aligned. |
| P3-01 | `styles.css` rewritten as one token set and one definition per role, followed by explicit responsive and preference states. |
| P3-02 | Dead rules removed (`conversation-list`, `connection-state`, `danger-zone`, override layers); docs updated to this SHA, Assets naming and Dark. |
| P3-03 | `Icon` wrapper supplies role strokes and hides decorative glyphs; local stroke overrides, UA markers, mask chevrons in the rail and Unicode checklist marks removed. Pi Durable badge shown at 15. |
| P3-04 | SDK control is “Pi Durable SDK version”; assistant messages are labeled “Pi Durable”. |
| P3-05 | One semantic notice/status palette (`data-tone`), compact loading/empty, `ErrorNotice` with optional Retry. Connections accounts/models/usage show their own loading/unavailable/confirmed-empty states and retry only that resource; valid populated data remains visible after a failed refresh. |
| P3-06 | Narrow layouts use 40-point rows and actions; coarse pointers get 44-point targets in both axes for icon/new-chat actions and the Markdown utility strips grow to contain them; glyphs stay compact. |
| P3-07 | Policy: generated/published report documents keep their own fixed light design (authored content, A10). App-owned preview chrome (frame, status, actions) follows the theme. |
| P3-08 | Projects, members, files, assets, connections, trash and deleted projects distinguish loading, error (with Retry), confirmed empty and populated states. Connections subresources suppress empty claims during loading/failure, retain stale populated results on transient errors, and clear them on authorization failures. |

## Enterprise adaptations

| ID | Difference | Reason |
| --- | --- | --- |
| A01 | One rail with organization → project → folder ownership and one Pi Durable agent. | Enterprise authorization model; no native multi-agent runtime. |
| A02 | Workspace modes use the native 904px compact boundary, 256px rails, 8px inset/gaps and 360px minimum desktop center. Organization-only navigation retains its mobile menu. Compact Adaptive pages are adjacent unless their combined native drawer width exceeds the viewport, when the stable pages switch with Back. | Native desktop has a 760px minimum window; web supports 390px. See the current source anchors and requested Adaptive default/move-glyph differences in `ORGANIZATION_WORKSPACES_PARITY.md`. |
| A03 | Fixed Full access / Read-only authority badge, never a writable permission picker. | Session authority is immutable server-side. |
| A04 | Central organization accounts with numeric priority and observed usage. | Credentials are organization-owned; only presentation maps to native groups. |
| A05 | Library keeps files, grants, shares, versions and published assets. | Enterprise product scope. |
| A06 | Markdown skips HTML, suppresses images, rejects unsafe links; HTML/SVG files render as source. | Web security and privacy. |
| A07 | Settings cover profile, organizations, projects, members and connections; no device, OS or update settings. | Enterprise scope. |
| A08 | Page selects remain native `select` (customizable in supporting browsers); composer selectors use the shared popout picker. | Native keyboard/form semantics where no headings are needed. |
| A09 | Message metadata (author, time) and the composer status line stay visible. | Shared multi-member conversations and durable delivery state. |
| A10 | Published reports and draft previews keep authored light styling inside a sandboxed frame. | Authored content is never recolored. |
| A11 | Light-theme error, success and warning text use darker ink variants (`--danger-ink`, etc.); fills and dots use the canonical tokens. Markdown links keep the canonical `#0D8F5A` (4.1:1 on white, distinct from body text, underlined on hover). | WCAG text contrast for app-owned notices. |
| A12 | Rail row action menus (ellipsis) appear on row hover or keyboard focus and are always visible on touch; native uses context menus. | Discoverable, keyboard-reachable equivalent of native context menus. |
| A13 | Folder-removal “also delete the directory” and Claude subscription risk acknowledgement stay checkboxes. | Irreversible or consent confirmations, not settings. |
| A14 | Completed tasks in the Tasks list use the muted foreground at full strength. | Native dims completed steps below readable contrast. |

## Whole-guide review and validation scope

The audit ledger contains **36 IDs** (6 P1, 22 P2, 8 P3), despite the handoff's
“35” shorthand. Every ID is retained above. This matrix records code and intended
mapping; it is not a claim of native macOS pixel equivalence or live acceptance.

| Guide area beyond the ledger | Final mapping / applicability |
| --- | --- |
| Settings picker arrows | Keep the native `SettingsMenuPicker` up/down pair (`SettingsComponents.swift:623`); composer/sidebar chevrons remain distinct. |
| Folder hover metadata | `DashboardSharedViews.swift:989–1063`: 260 width, 14 inset, title/workspace/count/root/reference hierarchy and delayed mouse hover; also keyboard-focusable metadata. Enterprise has authorized conversations and no native note records, so no fabricated note counts. |
| Folder composer control | Native `DashboardComposer.swift:88–109` places it above the editor with an 11.5 medium label. The web quiet trigger has a 24-point desktop minimum; browser touch targets expand separately. Locking/ownership still comes from canonical Enterprise data. |
| Compact Markdown utilities | `ConversationMarkdown.swift:143–248` uses plain 11.5 labels within 34-high code and 32-high table strips. The separate `utility-button` fits those strips; standard settings actions use the full native settings quiet metrics. Browser DOM rendering uses this existing native Markdown pattern alongside complete-response copy; native main-response TextKit is platform-specific. |
| SDK/work state | Pi Durable SDK settings remain within conversation settings beneath scope; no local/remote runtime locations are invented. Existing canonical version/update, retained history and work paging remain. |
| Authored content | App chrome follows theme; sandboxed authored HTML, images and report documents keep their content styling. Source HTML/SVG stays escaped. |
| Desktop-only and absent surfaces | Calendar, note editing/microphone, browser-address/tab bars, device pairing, OS settings and multiple agent runtimes have no Enterprise counterparts and are not added. Existing asset/file/version/share/publication controls remain. |

Persistent synthetic browser regressions in `platform/e2e/ui-parity.spec.mjs`
exercise popup focus/navigation/dismissal, canonical focused-action disable/remove transitions (also inside an asset dialog), dynamic all-inert popup recovery, empty popouts, idempotent reused-Page setup with persistent pageerror assertions, independent Connections loading/failure/retry/empty/stale and authorization states,
expanded-table state through popstate, event-triggered canonical refresh and a real local SSE background comment,
exact copied code/table/response text and clipboard completion races, protected
source navigation, full provider hierarchy, quiet/folder geometry and composer
ordering across Green/Cognac/Dark. Their request-intercepted fixture has no real
account or provider access. The existing 23 integrated synthetic workflows remain
in the suite. Screenshots, commands, logs and final validation results are kept
outside Git in the requested implementation evidence, not in this source matrix.

## Sidebar iteration after preview testing

Organization-only narrow navigation places its menu first in the header. Workspace
rails now use in-surface edge controls and the native 904px boundary as recorded
in `ORGANIZATION_WORKSPACES_PARITY.md`. Escape returns
focus to the trigger and the drawer closes after route selection.

An empty or filtered Recents list keeps its canonical empty label during
background polling. Previously that label disappeared on every refresh,
moving the following navigation rows by about 39 pixels. Authorization failures
still clear retained conversation data through the existing resource hook.
Browser regressions cover organization menu and workspace 903/904 boundaries, keyboard return,
empty/filtered/populated polling, stable selection and disclosure state,
retryable failures, and access loss.

The frontend build tool is pinned to Vite 8.3.4 to clear the newly reported
launch-editor security audit gate. Native SDK pins and runtime behavior remain
unchanged; the update is limited to the frontend toolchain and its lock entries.

## Merge-readiness audit

A second full-diff review found and corrected five control regressions: initial
selected/last picker focus could be clipped; asynchronously growing popups could
extend below the viewport; empty pickers referenced a missing listbox; consequential
confirmation checkboxes lost their keyboard outline; and folder metadata closed
while the pointer crossed the row actions and gap toward its scrollable card.

Popup focus now reveals choices through both popup scrollers without moving the
conversation, size changes recalculate placement,
empty pickers retain a named/described listbox, confirmation inputs keep the
shared neutral focus outline, and a cancellable 300 ms hover grace period allows
crossing into metadata. Escape, click, blur and outside scrolling still dismiss
metadata. Browser regressions exercise both initial focus paths at desktop and
390-pixel widths and 240-pixel window heights, catalog polling, empty semantics,
all three checkbox themes,
and pointer travel into scrollable folder metadata.
