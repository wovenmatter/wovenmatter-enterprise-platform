import piLogo from "../assets/pi-durable.svg";
import { useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Folder,
  FolderOpen,
  Plus,
  Search,
  Settings,
  Users,
  Files,
  ArrowLeft,
  Pin,
  Ellipsis,
  Trash2,
  MessageSquare,
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
import { workspaceChanged, useWorkspaceChanges } from "../workspace-events";
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
      <div className="rail-section-heading">
        <Link to={`${base}/projects`}>Projects</Link>
        {isAdmin ? (
          <Link
            className="icon-button"
            aria-label="New project"
            to={`${base}/projects?new=1`}
          >
            <Plus size={16} />
          </Link>
        ) : null}
      </div>
      <ErrorNotice message={projects.error} />
      {projects.data?.items.map((p) => (
        <Link className="nav-link" key={p.id} to={`${base}/projects/${p.id}`}>
          <Folder size={17} />
          <span>{p.name}</span>
        </Link>
      ))}
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
    base = `/organizations/${orgId}/projects/${projectId}`;
  const [search, setSearch] = useState(""),
    [error, setError] = useState("");
  const [modal, setModal] = useState<{
    kind: "create" | "rename" | "references" | "remove";
    folder?: WorkspaceFolder;
  } | null>(null);
  const [renameChat, setRenameChat] = useState<Conversation | null>(null);
  const writable = project?.access === "write";
  const url = (values: Record<string, string>) =>
    `${base}?${new URLSearchParams(values)}`;
  const scoped =
    chats.data?.items.filter(
      (c) =>
        (selected === "all" || c.folderId === selected) &&
        c.title.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
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
    return (
      <div className="workspace-rail-row" key={c.id}>
        <Link
          className={`nav-link conversation-link ${conversation === c.id ? "selected" : ""}`}
          aria-current={conversation === c.id ? "page" : undefined}
          to={url({ folder: selected, conversation: c.id })}
          title={c.title}
        >
          <MessageSquare size={15} />
          <span>{c.title}</span>
          {c.activeRun ? (
            <span className="working-dot" aria-label="Working" />
          ) : null}
          {c.pinned ? <Pin size={12} /> : null}
        </Link>
        <details
          className="rail-menu"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("button,a"))
              e.currentTarget.removeAttribute("open");
          }}
        >
          <summary aria-label={`Actions for ${c.title}`}>
            <Ellipsis size={15} />
          </summary>
          <div>
            {mine ? (
              <>
                <button
                  onClick={() =>
                    void mutation(
                      `/enterprise/api/conversations/${c.id}/organization`,
                      { pinned: !c.pinned },
                    )
                  }
                >
                  {c.pinned ? "Unpin" : "Pin"}
                </button>
                <button onClick={() => setRenameChat(c)}>Rename</button>
                <button
                  className="danger"
                  disabled={c.effectiveMode === "read" && c.mode === "write"}
                  onClick={async () => {
                    const navigationTarget = window.location.href;
                    if (
                      await mutation(
                        `/enterprise/api/conversations/${c.id}`,
                        undefined,
                        "DELETE",
                      )
                    ) {
                      if (
                        conversation === c.id &&
                        window.location.href === navigationTarget
                      )
                        navigate(url({ folder: selected }));
                    }
                  }}
                >
                  Move to Trash
                </button>
              </>
            ) : null}
            <a href={`/enterprise/api/conversations/${c.id}/export`} download>
              Export messages
            </a>
            <a
              href={`/enterprise/api/conversations/${c.id}/export?full=1`}
              download
            >
              Export full run
            </a>
          </div>
        </details>
      </div>
    );
  }
  return (
    <div className="project-navigation workspace-navigation">
      <Link
        className="nav-link project-back"
        to={`/organizations/${orgId}/projects`}
      >
        <ArrowLeft size={15} />
        <span>{project?.name ?? "Project workspace"}</span>
      </Link>
      <Link
        className="nav-link new-conversation"
        to={url({ folder: selected, new: "1" })}
      >
        <Plus size={18} />
        New conversation
      </Link>
      <label className="rail-search">
        <Search size={15} />
        <input
          type="search"
          aria-label="Search conversations"
          placeholder="Search conversations…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <details open className="rail-disclosure">
        <summary>Agent</summary>
        <div className="workspace-rail-row">
          <Link
            className="nav-link"
            to={
              scoped[0]
                ? url({ folder: selected, conversation: scoped[0].id })
                : url({ folder: selected })
            }
          >
            <img className="agent-logo" src={piLogo} alt="" />
            <span>Pi Durable</span>
          </Link>
          <Link
            className="icon-button"
            aria-label="New chat with Pi Durable"
            to={url({ folder: selected, new: "1" })}
          >
            <Plus size={15} />
          </Link>
        </div>
      </details>
      <details open className="rail-disclosure">
        <summary>Folders</summary>
        {writable ? (
          <button
            className="nav-link"
            aria-label="New workspace folder"
            onClick={() => setModal({ kind: "create" })}
          >
            <Plus size={16} />
            New folder
          </button>
        ) : null}
        <div className="workspace-rail-row">
          <Link
            className={`nav-link project-tool ${selected === "all" && !query.has("trash") ? "active" : ""}`}
            to={url({ folder: "all" })}
          >
            <FolderOpen size={16} />
            <span>All Workspaces</span>
          </Link>
          <Link
            className="icon-button"
            aria-label="New chat in All Workspaces"
            to={url({ folder: "all", new: "1" })}
          >
            <Plus size={15} />
          </Link>
        </div>
        {folders.data?.items.map((f, index, all) => (
          <div className="workspace-rail-row" key={f.id}>
            <Link
              className={`nav-link project-tool ${selected === f.id ? "active" : ""}`}
              to={url({ folder: f.id })}
              title={f.rootPath}
            >
              <Folder size={16} />
              <span>
                {f.name}
                {f.removalPending ? " · Removal pending" : ""}
              </span>
              {f.pinned ? <Pin size={12} /> : null}
              <small>
                {chats.data?.items.filter((c) => c.folderId === f.id).length ??
                  0}
              </small>
            </Link>
            <Link
              className="icon-button"
              aria-label={`New chat in ${f.name}`}
              to={url({ folder: f.id, new: "1" })}
            >
              <Plus size={15} />
            </Link>
            {writable ? (
              <details
                className="rail-menu"
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("button,a"))
                    e.currentTarget.removeAttribute("open");
                }}
              >
                <summary aria-label={`Actions for folder ${f.name}`}>
                  <Ellipsis size={15} />
                </summary>
                <div>
                  <button
                    onClick={() =>
                      void mutation(
                        `/enterprise/api/projects/${projectId}/folders/${f.id}`,
                        { pinned: !f.pinned },
                      )
                    }
                  >
                    {f.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    disabled={
                      index === 0 || all[index - 1]?.pinned !== f.pinned
                    }
                    onClick={() =>
                      void mutation(
                        `/enterprise/api/projects/${projectId}/folders/${f.id}`,
                        { direction: "up" },
                      )
                    }
                  >
                    Move up
                  </button>
                  <button
                    disabled={
                      index === all.length - 1 ||
                      all[index + 1]?.pinned !== f.pinned
                    }
                    onClick={() =>
                      void mutation(
                        `/enterprise/api/projects/${projectId}/folders/${f.id}`,
                        { direction: "down" },
                      )
                    }
                  >
                    Move down
                  </button>
                  <button
                    onClick={() => setModal({ kind: "rename", folder: f })}
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => setModal({ kind: "references", folder: f })}
                  >
                    Reference locations
                  </button>
                  <button
                    className="danger"
                    onClick={() => setModal({ kind: "remove", folder: f })}
                  >
                    Remove folder
                  </button>
                </div>
              </details>
            ) : null}
          </div>
        ))}
        <Link
          className={`nav-link project-tool ${query.has("trash") ? "active" : ""}`}
          to={url({ trash: "1" })}
        >
          <Trash2 size={16} />
          Trash
        </Link>
      </details>
      <ErrorNotice message={error || folders.error || chats.error} />
      {scoped.some((c) => c.pinned) ? (
        <details open className="rail-disclosure">
          <summary>Pinned chats</summary>
          {scoped.filter((c) => c.pinned).map(chatRow)}
        </details>
      ) : null}
      <details open className="rail-disclosure">
        <summary>Recents</summary>
        {scoped.filter((c) => !c.pinned).map(chatRow)}
        {!scoped.length ? (
          <p className="rail-empty">No conversations yet.</p>
        ) : null}
      </details>
      <nav aria-label="Project navigation" className="workspace-tools">
        <NavLink className="nav-link project-tool" to={`${base}/files`}>
          <Files size={16} />
          Files
        </NavLink>
        <NavLink className="nav-link project-tool" to={`${base}/members`}>
          <Users size={16} />
          Members
        </NavLink>
        {isAdmin ? (
          <NavLink className="nav-link project-tool" to={`${base}/settings`}>
            <Settings size={16} />
            Project settings
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
                <Field label="Also delete the directory and all its contents">
                  <input
                    type="checkbox"
                    name="deleteDirectory"
                    defaultChecked={modal.folder?.removalPending}
                    disabled={modal.folder?.removalPending}
                  />
                </Field>
                <p className="muted">{modal.folder?.rootPath}</p>
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
