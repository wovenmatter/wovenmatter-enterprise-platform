import { createPortal } from "react-dom";
import { WorkspaceDetails } from "./WorkspaceDetails";
import { SidebarControls } from "./SidebarControls";
import { focusSidebarControl, useSidebar } from "./sidebar-preferences";
import codexLogo from "../assets/codex.png";
import claudeLogo from "../assets/claude.svg";
import grokLogo from "../assets/grok.svg";
import opencodeLogo from "../assets/opencode.svg";
import { agents } from "../agents";
import piLogo from "../assets/pi-durable.svg";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CalendarDays,
  CalendarClock,
  LibraryBig,
  Database,
  BarChart3,
  FileText,
  Files,
  Folder,
  FolderOpen,
  MessageSquare,
  Pin,
  Plus,
  Settings,
  SquarePen,
  Trash2,
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
  ContextMenu,
  Icon,
  Menu,
  MenuItem,
  MenuLink,
  MenuSeparator,
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
  const sidebar = useSidebar();
  return (
    <Link className="rail-action" aria-label={label} title={label} to={to} onClick={event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      sidebar.rememberChatTrigger(event.currentTarget);
      if (label.startsWith("New chat in ")) sidebar.selectFolder();
      sidebar.setDrawer(null);
    }}>
      <Icon icon={Plus} size={12} />
    </Link>
  );
}

/** DashboardFolderHoverCard at native 24e503f, DashboardSharedViews.swift:989.
 * Counts include only conversations already authorized by the project API.
 */
function FolderRailRow({ folder, workspace, count, to, selected, onSelect, actions, children }: {
  folder: WorkspaceFolder; workspace: string; count: number; to: string; selected: boolean; onSelect: () => void;
  actions: ReactNode; children: ReactNode;
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
  function deferClose() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 300);
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
  return <ContextMenu label={`Actions for folder ${folder.name}`} trigger={anchor} actions={actions} onOpen={close}>
    {attributes => <>
    <Link ref={anchor} {...attributes} className={`nav-link ${selected ? "active" : ""}`} to={to}
      aria-label={folder.name}
      data-folder-selection="true"
      aria-description={[workspace, summary, `Root folder: ${folder.rootPath}`, ...folder.referencePaths.map((path) => `Additional folder: ${path}`), folder.pinned ? "Pinned" : ""].filter(Boolean).join(", ")}
      aria-describedby={open ? id : undefined}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") show(); }}
      onPointerLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !card.current?.contains(event.relatedTarget)) deferClose(); }}
      onPointerDown={close} onFocus={show} onBlur={close} onClick={event => { close(); if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) onSelect(); }}
      onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <Icon icon={Folder} size={13} />
      <span className="rail-title">{folder.name}{folder.removalPending ? " · Removal pending" : ""}</span>
      {folder.pinned ? <Icon icon={Pin} size={11} className="rail-pin" /> : null}
      <span className="rail-count" aria-hidden="true">{count}</span>
    </Link>
    {children}
    {open ? <div ref={card} id={id} role="tooltip" popover="manual" className="popup folder-hover-card"
      onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={deferClose}>
      <strong>{folder.name}</strong>
      <span className="folder-hover-workspace">{workspace}</span>
      <small>{summary}</small>
      <div className="folder-hover-paths">
        <strong>Root folder</strong><span>{folder.rootPath}</span>
        {folder.referencePaths.length ? <><strong>Additional folders</strong>{folder.referencePaths.map((path) => <span key={path}>{path}</span>)}</> : null}
      </div>
    </div> : null}
    </>}
  </ContextMenu>;
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
    active = location.pathname.match(/\/workspaces\/([^/]+)/)?.[1],
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
          to={`${base}/workspaces`}
        >
          <Icon icon={FolderOpen} size={13} />
          <span>Back to organization</span>
        </NavLink>
        {isAdmin ? (
          <Link
            className="rail-action"
            aria-label="New workspace"
            title="New workspace"
            to={`${base}/workspaces?new=1`}
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
            to={`${base}/workspaces/${p.id}`}
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
  const sidebar = useSidebar();
  const location = useLocation();
  const query = new URLSearchParams(sidebar.workspaceSearch),
    selected = query.get("folder") ?? "all",
    conversation = query.get("conversation"),
    trash = query.has("trash"),
    base = `/organizations/${orgId}/workspaces/${projectId}`;
  const [error, setError] = useState("");
  const [modal, setModal] = useState<{
    kind: "create" | "rename" | "references" | "remove";
    folder?: WorkspaceFolder;
  } | null>(null);
  const folderModalTrigger = useRef<HTMLElement | null>(null);
  function openFolderModal(next: NonNullable<typeof modal>) {
    folderModalTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setModal(next);
  }
  useLayoutEffect(() => {
    if (modal) return;
    const trigger = folderModalTrigger.current;
    folderModalTrigger.current = null;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, [modal]);
  const [renameChat, setRenameChat] = useState<Conversation | null>(null);
  const writable = Boolean(project);
  const onWorkspace = location.pathname.endsWith(projectId);
  const url = (values: Record<string, string>) => {
    const next = new URLSearchParams(query);
    next.delete("new"); next.delete("trash");
    if (values.agent) next.delete("conversation");
    for (const [key, value] of Object.entries(values)) next.set(key, value);
    return `${base}?${next}`;
  };
  function selectFolder() {
    sidebar.selectFolder();
    if (sidebar.preferences.style !== "split") focusSidebarControl(".sidebar-content-slot .sidebar-back");
  }
  const allChats = chats.data?.items ?? [];
  // Recents covers every project conversation this user is authorized to
  // list, as native Recents is global; the folder selection scopes new chats.
  const recents = [...allChats]
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const count = (folderId: string) =>
    allChats.filter((c) => c.folderId === folderId).length;
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
    const mine = true;
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
  return <>
    <div className="project-navigation workspace-navigation">
      <div className="workspace-rail-title"><SidebarControls page="navigation" placement="leading" /><strong>{project?.name ?? "Workspace"}</strong><SidebarControls page="navigation" /></div>
      <div className="rail-group">
        <Link className="nav-link" to={`/organizations/${orgId}/workspaces`}>
          <Icon icon={ArrowLeft} size={13} weight="control" />
          <span>Back to organization</span>
        </Link>
        <Link
          className="nav-link"
          to={url({ folder: selected, new: "1" })}
          onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) sidebar.rememberChatTrigger(event.currentTarget); }}
        >
          <Icon icon={SquarePen} size={13} />
          <span>New chat</span>
        </Link>
      </div>
      <nav aria-label="Workspace navigation" className="workspace-tools">
        <Menu label="Create note or artifact" triggerText="New note" icon={FileText} iconSize={13} iconWeight="normal" className="rail-menu" align="start">
          <MenuItem onSelect={async () => { try { const record = await send<{id:string}>(`/enterprise/api/projects/${projectId}/workspace-content`, {kind:"note",title:"Untitled note",body:"",folderId:selected === "all" ? null : selected,data:{format:"markdown"}}); const next = new URLSearchParams(query); next.set("note", record.id); next.delete("new"); next.delete("trash"); navigate(`${base}?${next}`); sidebar.setDrawer(null); workspaceChanged(); } catch(e) { setError(errorMessage(e)); } }}>New note</MenuItem>
          <MenuItem onSelect={() => navigate(`${base}/artifacts`)}>New artifact…</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => navigate(`${base}/notes`)}>Browse notes</MenuItem>
          <MenuItem onSelect={() => navigate(`${base}/artifacts`)}>Browse artifacts</MenuItem>
        </Menu>
        {[
          { path: "calendar", label: "Calendar", icon: CalendarDays },
          { path: "tasks", label: "Scheduled Tasks", icon: CalendarClock },
          { path: "library", label: "Library", icon: LibraryBig },
          { path: "databases", label: "Databases", icon: Database },
          { path: "files", label: "Workspace Files", icon: Files },
          { path: "usage", label: "Usage", icon: BarChart3 },
          { path: "settings", label: "Settings", icon: Settings },
        ].map(item => <NavLink key={item.path} className="nav-link" to={`${base}/${item.path}`}><Icon icon={item.icon} size={13} /><span>{item.label}</span></NavLink>)}
      </nav>
      <div className="rail-row all-workspaces">
        <Link
          className={`nav-link ${onWorkspace && selected === "all" && !trash ? "active" : ""}`}
          to={url({ folder: "all" })}
          data-folder-selection="true"
          onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) selectFolder(); }}
        >
          <Icon icon={FolderOpen} size={13} />
          <span className="rail-title">All Workspaces</span>
        </Link>
        <NewChat
          label="New chat in All Workspaces"
          to={url({ folder: "all", new: "1" })}
        />
      </div>
      <RailSection title="Agents">
        {agents.map(agent => <div className="rail-row" key={agent.id}>
          <Link className={`nav-link ${query.get("agent") === agent.id ? "active" : ""}`} to={url({ folder: selected, agent: agent.id })} title={agent.detail}>
            {agent.id === "pi" ? <img className="agent-logo" src={piLogo} alt="" /> : <img className={`agent-logo agent-${agent.id}`} src={{ codex: codexLogo, claude_code: claudeLogo, grok_build: grokLogo, opencode: opencodeLogo }[agent.id]} alt="" />}
            <span className="rail-title">{agent.name}</span>
          </Link>
          <NewChat label={`New chat with ${agent.name}`} to={url({ folder: selected, new: "1", agent: agent.id })} />
        </div>)}
      </RailSection>
      <RailSection title="Folders">
        {writable ? (
          <button
            type="button"
            className="nav-link"
            aria-label="New workspace folder"
            onClick={() => openFolderModal({ kind: "create" })}
          >
            <Icon icon={Plus} size={13} />
            <span>New folder</span>
          </button>
        ) : null}
        {folders.data?.items.map((f, index, all) => (
          <FolderRailRow key={f.id} folder={f} workspace={project?.name ?? "Workspace"}
            count={count(f.id)} selected={onWorkspace && selected === f.id && !trash}
            to={url({ folder: f.id })} onSelect={selectFolder}
            actions={writable ? <>
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
                <MenuItem onSelect={() => openFolderModal({ kind: "rename", folder: f })}>
                  Rename
                </MenuItem>
                <MenuItem
                  onSelect={() => openFolderModal({ kind: "references", folder: f })}
                >
                  Reference locations…
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  onSelect={() => openFolderModal({ kind: "remove", folder: f })}
                >
                  Remove folder…
                </MenuItem>
            </> : null}>
            <NewChat
              label={`New chat in ${f.name}`}
              to={url({ folder: f.id, new: "1" })}
            />
          </FolderRailRow>
        ))}
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
        {/* Polling retains authorized empty results too, so the rail does not jump. */}
        {!recents.length && chats.data ? (
          <p className="rail-empty">
            No conversations yet.
          </p>
        ) : null}
      </RailSection>
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
                label="Workspace paths, one per line"
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
    {project && sidebar.contentTarget ? createPortal(<WorkspaceDetails project={project} chats={allChats} folderName={folders.data?.items.find(folder => folder.id === selected)?.name} query={query} base={base} error={chats.error} />, sidebar.contentTarget) : null}
  </>;
}
