# Project workspaces

An Enterprise project is one persistent container, execution host and access boundary.
Its managed workspace is `/workspace/.WovenMatter`. The sidebar follows WovenMatter
main `1f168813174ec9449f29bf0e41cd1c1550083e8a` (workspace redesign #119), with
Dark from `codex/dark-theme` / #122 at `a65b4d8f5a39021e4309b3d13b263ffd00dc68ca`.

## Folders and conversations

New folder creates a blank direct-child directory in `.WovenMatter`. No project
scaffolding or instruction files are installed. Pin/unpin, move up/down within the
pinned or ordinary group, and display-only rename organize the shared sidebar.
The directory and execution owner never follow a renamed label. `scratch`, dot
names, separators and control characters are reserved or rejected during creation.

All Workspaces shows every conversation visible to the caller in that project.
Its plus starts an unfiled draft. Before the first accepted message, the composer
can switch between a named folder and All Workspaces without resetting text,
model, thinking or access. A named folder uses its captured root. An unfiled chat
reserves `.WovenMatter/scratch/<date>-<first-words>-<chat-id>` durably before
creation. The first accepted message locks the root. Retry, resume, rename and
restart reuse it. Two unfiled conversations never intentionally share scratch.

Conversation actions include pin, rename, bounded complete JSON exports and
Trash/restore. Trashing a chat stops its retained namespace and keeps its working
files. The full-run export includes complete activity content, native records,
input receipts and source references, with current authorization on every page.

Reference locations describe files/directories inside this same project on its
execution owner. They are data supplied to the agent, not injected instruction
files or new filesystem permissions. Existing explicitly granted library shares
remain governed by their Enterprise ACLs. `.WovenMatter` cannot be a share alias.

Remove folder only hides the sidebar entry and retains files and chat roots.
Deleting the directory is an explicit separate choice. It stops affected native
namespaces, stages only the registered managed directory under private storage,
and removes its contents after identity checks. Failed removal stays visible as
pending; retry preserves its destructive intent and canonical staging journal.
A deleted/replaced directory cannot become the root of an existing chat.

## Enterprise adaptations

WovenMatter's remote `projects.mjs`, data-model guide and sidebar are the behavioral
reference. Enterprise has only Pi Durable; its plus launches Pi directly instead
of offering other harnesses. The project already fixes the execution host and
container, so folders cannot link arbitrary host paths or change execution owner.
The `.WovenMatter` spelling is the Enterprise managed root requested for this port;
WovenMatter's remote container uses `/home/.woven-matter`.

The existing private storage wrapper, mounted project root, file version store,
per-user grants, scoped library mounts and supervisor placement stay platform
contracts. They are not a user-visible project template. Agents start in their
selected managed directory and retain native read-only/full-access enforcement.
The API verifies its own filesystem identities; the execution owner independently
captures and persists its local cwd identity in its private runtime journal.
Identities from one host are never compared with another host's mount numbers.
Directory descriptors pin the cwd through native launch; runtime-owned mounts
are applied last and mount evidence is checked before Pi starts. Native session
storage remains private to the execution owner: the API supplies the exact logical
session path without creating directories. After placement/thread checks, the
supervisor creates the namespace with no-follow descriptor lookups; the project
daemon assigns only the final native leaf to the agent UID.

This actively tested platform uses fresh deployment state. The port includes no
old-layout migration/resume bridge, virtual-folder binding, archived old sessions,
old Pi SDK compatibility or additional legacy regression suite.

## Appearance

Green, Cognac and Dark are authenticated user preferences persisted in SQLite.
Dark copies the shared WovenMatter palette: charcoal workspace `#1B1D1A`, forest
rail `#242A24`, surface `#2A302A`, cream foreground `#E5E9E0`, muted `#AAB4A8`,
green accent `#8BBC9E` and Cognac accent `#D7A477`. Native browser color-scheme,
forms, dialogs, menus and app-owned content use the selected appearance. Authored
HTML/reports and document bytes keep their own presentation.
