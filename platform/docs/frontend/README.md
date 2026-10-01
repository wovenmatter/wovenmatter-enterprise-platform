# Workspace frontend

React 19, TypeScript, React Router, and Vite. Feature modules are loaded on demand. All data comes from the session-protected platform API; no demo records, fabricated usage, canned responses, or browser-stored inference credentials are included.

## Design reference

WovenMatter is the current design reference. The UI uses the WovenMatter cube, system typography, Lucide icons, Green and Cognac account themes, quiet controls, rounded panels, and segmented selectors.

Tokens: foreground `#0A1F16`, secondary `#5C6F64`, primary action `#004225`; 256px desktop sidebar, 13px interface base, 22px page headings. Cognac retains dark green text and primary actions, with `#F7F6F3` workspace, white sidebar, and translucent brown hover/selection backgrounds. Dropdowns use native customizable selects in supporting browsers; browsers without `appearance: base-select` retain their accessible native picker.

Owners start in Administration, whose sidebar lists all organizations. Organization navigation contains Projects, Library, and administrator-only Organization settings. Members and Connections are nested under those settings. Library defaults to Files and switches to Published Outputs; switching preserves the current file folder. The footer opens account-wide personal settings for display name, theme, profile, password reset, and accessible organizations/projects. Organization routes use `/organizations/:orgId/...`; legacy project links resolve the project before selecting its organization.

## Run locally

Preferred integrated development/acceptance: build from repository root with `npm run build` and serve the platform API at its configured public origin. The API serves the built web assets and API from the same origin, preserving cookie and CSRF checks.

For local development, run `bash platform/dev-launch.sh` for the API and `npm run dev:web` in a second terminal. Both run in the foreground on loopback (API 4160, Vite 5173). Open `http://localhost:5173/enterprise`; Vite proxies `/enterprise/api` and `/enterprise/reports` to the API while preserving Host/Origin. `platform/dev.env.example` documents generic settings. No mail provider or supervisor is configured by default. Provider inference and persistent workspace runtime acceptance require the full deployment stack. Stop each process with Ctrl-C; never reuse a running installation's state directory.

## State and security boundaries

- Session credentials are HttpOnly cookies. The CSRF token stays in module memory. Account keys and OAuth callback URLs are sent once and never saved in localStorage or application logs.
- Forms retain errors and do not report success until the backend confirms it. Invitations show the one-time activation link separately from the actual email delivery state.
- File uploads preserve directory-relative paths, split large batches, enforce the advertised per-file bound, and report partial-success errors. Controls use the current folder's effective access, including read-only shares and empty granted folders.
- Conversation SSE notifications trigger coalesced canonical reads. Slow reads are allowed to complete even when events arrive faster than network latency; one dirty follow-up catches newer state. The transcript merges by durable message ID with canonical revisions winning.
- An uncertain message submission keeps its request ID and content in tab-scoped sessionStorage, keyed by authenticated user and conversation. Reopening a conversation restores a safe explicit retry. Definitive receipt clears it. No automatic replay is performed on navigation or recovery.
- Markdown uses a maintained parser, disallows raw HTML and executable link protocols, and suppresses images to avoid remote tracking. Exact source-version links are explicit protected file URLs.
- File names, saved versions, and citations open a protected source viewer. Native PDF and raster-image previews use MIME-constrained local Blob URLs with a 20 MiB cap; UTF-8 text is escaped with a 2 MiB cap. HTML and SVG remain source text, never active documents. Office files and oversized documents retain their original download. This does not introduce the deferred extraction/OCR pipeline.
- Live asset publication and share creation require backend success. Static links retain their revision, live links follow the current revision, and revocation uses the backend capability lifecycle.

## Acceptance evidence

`platform/tests/ui-state.test.ts` covers slow-read coalescing, rolling history updates, uncertain request identity, terminal status rendering, and untrusted Markdown links. Integrated browser tests are maintained in `platform/e2e` and exercise synthetic local accounts only. Live provider authentication must be completed by the user, never automated by the build agent.

Unit/build validation alone is not browser or live-provider acceptance. Run the integrated browser suite after UI refactors; keep generated screenshots and traces outside tracked source.
