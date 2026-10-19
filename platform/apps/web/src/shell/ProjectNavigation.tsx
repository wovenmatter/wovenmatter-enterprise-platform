import piLogo from "../assets/pi-durable.svg";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Files,
  Folder,
  FolderOpen,
  MessageSquare,
  Pin,
  Plus,
  Settings,
  SquarePen,
  Trash2,
  Users,
} from "lucide-react";
import {
  send,
  useResource,
  errorMessage,
  type List,
  type Project,
  type User,
  type Conversation,
  type WorkspaceFolder,
} from "../api";
import { AsyncForm, Field, Modal, ErrorNotice } from "../components/ui";
import {
  DisclosureChevron,
  Icon,
  Menu,
  MenuItem,
  MenuLink,
  MenuSeparator,
  SearchField,
} from "../components/controls";
import { workspaceChanged, useWorkspaceChanges } from "../workspace-events";

/** WovenMatter DashboardDisclosureHeading: title, then a trailing chevron. */
function RailSection({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details open className={`rail-section ${className}`}>
      <summary className="disclosure-heading">
        <span>{title}</span>
        <DisclosureChevron />
      </summary>
      {children}
    </details>
  );
}
/** Separate 24 × 28 new-chat action at the far right of a rail row. */
function NewChat({ label, to }: { label: string; to: string }) {
  return (
    <Link className="rail-action" aria-label={label} title={label} to={to}>
      <Icon icon={Plus} size={12} />
    </Link>
  );
}

/** DashboardFolderHoverCard at native 24e503f, DashboardSharedViews.swift:989.
 * Counts include only conversations already authorized by the project API.
 */
function FolderRailLink({ folder, workspace, count, to, selected }: {
  folder: WorkspaceFolder; workspace: string; count: number; to: string; selected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLAnchorElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  function close() {
    clearTimeout(timer.current);
    setOpen(false);
  }
  function show() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 500);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    const node = card.current, trigger = anchor.current;
    if (!open || !node || !trigger) return;
    node.showPopover?.();
    const bounds = trigger.closest(".rail-row")?.getBoundingClientRect() ?? trigger.getBoundingClientRect();
    const fitsRight = bounds.right + 8 + node.offsetWidth <= innerWidth - 8;
    const fitsLeft = bounds.left - 8 - node.offsetWidth >= 8;
    const left = fitsRight ? bounds.right + 8 : fitsLeft ? bounds.left - 8 - node.offsetWidth : 8;
    const top = fitsRight || fitsLeft ? bounds.top : bounds.bottom + 4 + node.offsetHeight <= innerHeight - 8 ? bounds.bottom + 4 : bounds.top - 4 - node.offsetHeight;
    node.style.left = `${left}px`;
    node.style.top = `${Math.max(8, Math.min(top, innerHeight - node.offsetHeight - 8))}px`;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && node.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);
  const summary = `${count} ${count === 1 ? "conversation" : "conversations"}`;
  return <>
    <Link ref={anchor} className={`nav-link ${selected ? "active" : ""}`} to={to}
      aria-label={folder.name}
      aria-description={[workspace, summary, `Root folder: ${folder.rootPath}`, ...folder.referencePaths.map((path) => `Additional folder: ${path}`), folder.pinned ? "Pinned" : ""].filter(Boolean).join(", ")}
      aria-describedby={open ? id : undefined}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") show(); }}
      onPointerLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !card.current?.contains(event.relatedTarget)) close(); }}
      onPointerDown={close} onFocus={show} onBlur={close} onClick={close}
      onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <Icon icon={Folder} size={13} />
      <span className="rail-title">{folder.name}{folder.removalPending ? " · Removal pending" : ""}</span>
      {folder.pinned ? <Icon icon={Pin} size={11} className="rail-pin" /> : null}
      <span className="rail-count" aria-hidden="true">{count}</span>
    </Link>
    {open ? <div ref={card} id={id} role="tooltip" popover="manual" className="popup folder-hover-card"
      onPointerLeave={close}>
      <strong>{folder.name}</strong>
      <span className="folder-hover-workspace">{workspace}</span>
      <small>{summary}</small>
      <div className="folder-hover-paths">
        <strong>Root folder</strong><span>{folder.rootPath}</span>
        {folder.referencePaths.length ? <><strong>Additional folders</strong>{folder.referencePaths.map((path) => <span key={path}>{path}</span>)}</> : null}
      </div>
    </div> : null}
  </>;
}

export function ProjectNavigation({
  orgId,
  user,
  isAdmin,
}: {
  orgId: string;
  user: User;
  isAdmin: boolean;
}) {
  const projects = useResource<List<Project>>(
    `/enterprise/api/organizations/${orgId}/projects`,
    10000,
  );
  useWorkspaceChanges(projects.reload);
  const location = useLocation(),
    active = location.pathname.match(/\/projects\/([^/]+)/)?.[1],
    base = `/organizations/${orgId}`;
  if (active)
    return (
      <WorkspaceRail
        key={active}
        project={projects.data?.items.find((p) => p.id === active)}
        projectId={active}
        orgId={orgId}
        user={user}
        isAdmin={isAdmin}
      />
    );
  return (
    <div className="project-navigation">
      <div className="rail-row">
        <NavLink
          className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
          end
          to={`${base}/projects`}
        >
          <Icon icon={FolderOpen} size={13} />
          <span>Projects</span>
        </NavLink>
        {isAdmin ? (
          <Link
            className="rail-action"
            aria-label="New project"
            title="New project"
            to={`${base}/projects?new=1`}
          >
            <Icon icon={Plus} size={12} />
          </Link>
        ) : null}
      </div>
      <ErrorNotice message={projects.error} onRetry={projects.reload} />
      <div className="rail-children">
        {projects.data?.items.map((p) => (
          <Link
            className="nav-link"
            key={p.id}
            to={`${base}/projects/${p.id}`}
            title={p.name}
          >
            <Icon icon={Folder} size={13} />
            <span>{p.name}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
function WorkspaceRail({
  project,
  projectId,
  orgId,
  user,
  isAdmin,
}: {
  project?: Project;
  projectId: string;
  orgId: string;
  user: User;
  isAdmin: boolean;
}) {
  const folders = useResource<List<WorkspaceFolder>>(
    `/enterprise/api/projects/${projectId}/folders`,
    10000,
  );
  const chats = useResource<List<Conversation>>(
    `/enterprise/api/projects/${projectId}/conversations`,
    10000,
  );
  useWorkspaceChanges(folders.reload);
  useWorkspaceChanges(chats.reload);
  const navigate = useNavigate();
  const location = useLocation(),
    query = new URLSearchParams(location.search),
    selected = query.get("folder") ?? "all",
    conversation = query.get("conversation"),
    trash = query.has("trash"),
    base = `/organizations/${orgId}/projects/${projectId}`;
  const [search, setSearch] = useState(""),
    [error, setError] = useState("");
  const [modal, setModal] = useState<{
    kind: "create" | "rename" | "references" | "remove";
    folder?: WorkspaceFolder;
  } | null>(null);
  const [renameChat, setRenameChat] = useState<Conversation | null>(null);
  const writable = project?.access === "write";
  const onWorkspace = location.pathname.endsWith(projectId);
  const url = (values: Record<string, string>) =>
    `${base}?${new URLSearchParams(values)}`;
  const allChats = chats.data?.items ?? [];
  // Recents covers every project conversation this user is authorized to
  // list, as native Recents is global; the folder selection scopes new chats.
  const recents = allChats
    .filter((c) => c.title.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const count = (folderId: string) =>
    allChats.filter((c) => c.folderId === folderId).length;
  const inSelection = allChats.filter(
    (c) => selected === "all" || c.folderId === selected,
  );
  async function mutation(path: string, body: unknown, method = "PATCH") {
    try {
      await send(path, body, method);
      setError("");
      workspaceChanged();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  }
  function chatRow(c: Conversation) {
    const mine = c.createdBy === user.id;
    const current = conversation === c.id;
    const state = [c.pinned ? "Pinned" : "", c.activeRun ? "Working" : ""]
      .filter(Boolean)
      .join(", ");
    return (
      <div className="rail-row" key={c.id}>
        <Link
          className={`nav-link conversation-link ${current ? "active" : ""}`}
          aria-current={current ? "page" : undefined}
          to={url({ folder: selected, conversation: c.id })}
          title={c.title}
          aria-description={state || undefined}
        >
          <Icon icon={MessageSquare} size={13} />
          <span className="rail-title">{c.title}</span>
          {c.activeRun ? <span className="working-dot" aria-hidden="true" /> : null}
          {c.pinned ? (
            <Icon icon={Pin} size={11} className="rail-pin" />
          ) : null}
        </Link>
        <Menu label={`Actions for ${c.title}`} iconSize={12} className="rail-action">
          {mine ? (
            <>
              <MenuItem
                onSelect={() =>
                  void mutation(
                    `/enterprise/api/conversations/${c.id}/organization`,
                    { pinned: !c.pinned },
                  )
                }
              >
                {c.pinned ? "Unpin" : "Pin"}
              </MenuItem>
              <MenuItem onSelect={() => setRenameChat(c)}>Rename</MenuItem>
            </>
          ) : null}
          <MenuLink href={`/enterprise/api/conversations/${c.id}/export`} download>
            Export messages
          </MenuLink>
          <MenuLink
            href={`/enterprise/api/conversations/${c.id}/export?full=1`}
            download
          >
            Export full run
          </MenuLink>
          {mine ? (
            <>
              <MenuSeparator />
              <MenuItem
                danger
                disabled={c.effectiveMode === "read" && c.mode === "write"}
                onSelect={async () => {
                  const navigationTarget = window.location.href;
                  if (
                    (await mutation(
                      `/enterprise/api/conversations/${c.id}`,
                      undefined,
                      "DELETE",
                    )) &&
                    current &&
                    window.location.href === navigationTarget
                  )
                    navigate(url({ folder: selected }));
                }}
              >
                Move to Trash
              </MenuItem>
            </>
          ) : null}
        </Menu>
      </div>
    );
  }
  return (
    <div className="project-navigation workspace-navigation">
      <div className="rail-group">
        <Link className="nav-link" to={`/organizations/${orgId}/projects`}>
          <Icon icon={ArrowLeft} size={13} weight="control" />
          <span>Projects</span>
        </Link>
        <Link
          className="nav-link"
          to={url({ folder: selected, new: "1" })}
        >
          <Icon icon={SquarePen} size={13} />
          <span>New conversation</span>
        </Link>
      </div>
      <SearchField
        label="Search conversations"
        placeholder="Search conversations…"
        value={search}
        onChange={setSearch}
      />
      <div className="rail-row all-workspaces">
        <Link
          className={`nav-link ${onWorkspace && selected === "all" && !trash ? "active" : ""}`}
          to={url({ folder: "all" })}
        >
          <Icon icon={FolderOpen} size={13} />
          <span className="rail-title">All Workspaces</span>
        </Link>
        <NewChat
          label="New chat in All Workspaces"
          to={url({ folder: "all", new: "1" })}
        />
      </div>
      <RailSection title={project?.name ?? "Project workspace"} className="owning-workspace">
        <div className="rail-children">
          <RailSection title="Agents">
            <div className="rail-row">
              <Link
                className="nav-link"
                to={
                  inSelection[0]
                    ? url({ folder: selected, conversation: inSelection[0].id })
                    : url({ folder: selected })
                }
              >
                <img className="agent-logo" src={piLogo} alt="" />
                <span className="rail-title">Pi Durable</span>
              </Link>
              <NewChat
                label="New chat with Pi Durable"
                to={url({ folder: selected, new: "1" })}
              />
            </div>
          </RailSection>
          <RailSection title="Folders">
            {writable ? (
              <button
                type="button"
                className="nav-link"
                aria-label="New workspace folder"
                onClick={() => setModal({ kind: "create" })}
              >
                <Icon icon={Plus} size={13} />
                <span>New folder</span>
              </button>
            ) : null}
            {folders.data?.items.map((f, index, all) => (
              <div className="rail-row" key={f.id}>
                <FolderRailLink folder={f} workspace={project?.name ?? "Project workspace"}
                  count={count(f.id)} selected={onWorkspace && selected === f.id && !trash}
                  to={url({ folder: f.id })} />
                {writable ? (
                  <Menu
                    label={`Actions for folder ${f.name}`}
                    iconSize={12}
                    className="rail-action"
                  >
                    <MenuItem
                      onSelect={() =>
                        void mutation(
                          `/enterprise/api/projects/${projectId}/folders/${f.id}`,
                          { pinned: !f.pinned },
                        )
                      }
                    >
                      {f.pinned ? "Unpin" : "Pin"}
                    </MenuItem>
                    <MenuItem
                      disabled={index === 0 || all[index - 1]?.pinned !== f.pinned}
                      onSelect={() =>
                        void mutation(
                          `/enterprise/api/projects/${projectId}/folders/${f.id}`,
                          { direction: "up" },
                        )
                      }
                    >
                      Move up
                    </MenuItem>
                    <MenuItem
                      disabled={
                        index === all.length - 1 ||
                        all[index + 1]?.pinned !== f.pinned
                      }
                      onSelect={() =>
                        void mutation(
                          `/enterprise/api/projects/${projectId}/folders/${f.id}`,
                          { direction: "down" },
                        )
                      }
                    >
                      Move down
                    </MenuItem>
                    <MenuItem onSelect={() => setModal({ kind: "rename", folder: f })}>
                      Rename
                    </MenuItem>
                    <MenuItem
                      onSelect={() => setModal({ kind: "references", folder: f })}
                    >
                      Reference locations…
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      danger
                      onSelect={() => setModal({ kind: "remove", folder: f })}
                    >
                      Remove folder…
                    </MenuItem>
                  </Menu>
                ) : null}
                <NewChat
                  label={`New chat in ${f.name}`}
                  to={url({ folder: f.id, new: "1" })}
                />
              </div>
            ))}
          </RailSection>
        </div>
      </RailSection>
      <Link
        className={`nav-link trash-link ${trash ? "active" : ""}`}
        to={url({ trash: "1" })}
      >
        <Icon icon={Trash2} size={13} />
        <span>Trash</span>
      </Link>
      <ErrorNotice message={error || folders.error || chats.error} />
      <RailSection title="Recents" className="recents">
        {recents.map(chatRow)}
        {!recents.length && !chats.loading ? (
          <p className="rail-empty">
            {search.trim() ? "No matching conversations." : "No conversations yet."}
          </p>
        ) : null}
      </RailSection>
      <nav aria-label="Project navigation" className="workspace-tools">
        <NavLink className="nav-link" to={`${base}/files`}>
          <Icon icon={Files} size={13} />
          <span>Files</span>
        </NavLink>
        <NavLink className="nav-link" to={`${base}/members`}>
          <Icon icon={Users} size={13} />
          <span>Members</span>
        </NavLink>
        {isAdmin ? (
          <NavLink className="nav-link" to={`${base}/settings`}>
            <Icon icon={Settings} size={13} />
            <span>Project settings</span>
          </NavLink>
        ) : null}
      </nav>
      {modal ? (
        <Modal
          title={
            modal.kind === "create"
              ? "New folder"
              : modal.kind === "rename"
                ? "Rename folder"
                : modal.kind === "references"
                  ? "Reference locations"
                  : "Remove folder?"
          }
          compact
          onClose={() => setModal(null)}
        >
          <AsyncForm
            danger={modal.kind === "remove"}
            submitLabel={
              modal.kind === "create"
                ? "Create folder"
                : modal.kind === "remove"
                  ? modal.folder?.removalPending
                    ? "Retry directory removal"
                    : "Remove folder"
                  : "Save"
            }
            onCancel={() => setModal(null)}
            onSubmit={async (d) => {
              const path =
                `/enterprise/api/projects/${projectId}/folders` +
                (modal.folder ? `/${modal.folder.id}` : "");
              if (modal.kind === "remove")
                await send(
                  path +
                    (modal.folder?.removalPending ||
                    d.get("deleteDirectory") === "on"
                      ? "?deleteDirectory=1"
                      : ""),
                  undefined,
                  "DELETE",
                );
              else if (modal.kind === "references")
                await send(
                  path,
                  {
                    referencePaths: String(d.get("references"))
                      .split("\n")
                      .map((p) => p.trim())
                      .filter(Boolean),
                  },
                  "PATCH",
                );
              else
                await send(
                  path,
                  { name: d.get("name") },
                  modal.kind === "create" ? "POST" : "PATCH",
                );
              setModal(null);
              workspaceChanged();
            }}
          >
            {modal.kind === "remove" ? (
              <>
                <p>
                  Remove this folder from the sidebar. Its chats and files
                  remain available.
                </p>
                {/* An irreversible opt-in stays an explicit checkbox. */}
                <label className="checkbox">
                  <input
                    type="checkbox"
                    name="deleteDirectory"
                    defaultChecked={modal.folder?.removalPending}
                    disabled={modal.folder?.removalPending}
                  />
                  <span>Also delete the directory and all its contents</span>
                </label>
                <p className="muted path-text">{modal.folder?.rootPath}</p>
              </>
            ) : modal.kind === "references" ? (
              <Field
                label="Project paths, one per line"
                hint="Locations on this container only. Adding a reference does not change access."
              >
                <textarea
                  name="references"
                  rows={4}
                  defaultValue={modal.folder?.referencePaths.join("\n")}
                />
              </Field>
            ) : (
              <Field
                label="Folder name"
                hint={
                  modal.kind === "create"
                    ? "Creates a blank directory inside .WovenMatter."
                    : "Renaming changes the label, leaving its directory in place."
                }
              >
                <input
                  name="name"
                  required
                  autoFocus
                  maxLength={160}
                  defaultValue={modal.folder?.name}
                />
              </Field>
            )}
          </AsyncForm>
        </Modal>
      ) : null}
      {renameChat ? (
        <Modal
          title="Rename conversation"
          compact
          onClose={() => setRenameChat(null)}
        >
          <AsyncForm
            submitLabel="Rename"
            onCancel={() => setRenameChat(null)}
            onSubmit={async (d) => {
              await send(
                `/enterprise/api/conversations/${renameChat.id}/organization`,
                { title: d.get("title") },
                "PATCH",
              );
              setRenameChat(null);
              workspaceChanged();
            }}
          >
            <Field label="Title">
              <input
                name="title"
                defaultValue={renameChat.title}
                required
                autoFocus
                maxLength={200}
              />
            </Field>
          </AsyncForm>
        </Modal>
      ) : null}
    </div>
  );
}
