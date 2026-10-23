import { lazy, Suspense, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FileText, MessageSquare, SquarePen, X } from "lucide-react";
import { send, useResource, type Conversation, type List, type Project } from "../api";
import { DisclosureChevron, Icon, Menu, MenuItem, SearchField } from "../components/controls";
import { ErrorNotice, Loading } from "../components/ui";
import { workspaceChanged, useWorkspaceChanges } from "../workspace-events";
import { SidebarControls } from "./SidebarControls";
import { focusSidebarControl, useSidebar } from "./sidebar-preferences";
import type { ContentRecord } from "../features/workspace-content";
const DocumentEditor = lazy(() => import("../features/workspace-content").then(module => ({ default: module.DocumentEditor })));

export function WorkspaceDetails({ project, chats, folderName, query, base, error: chatsError }: { project: Project; chats: Conversation[]; folderName?: string; query: URLSearchParams; base: string; error?: string }) {
  const notes = useResource<List<ContentRecord>>(`/enterprise/api/projects/${project.id}/workspace-content?kind=note`);
  useWorkspaceChanges(notes.reload);
  const [error, setError] = useState("");
  const sidebar = useSidebar();
  const { tab, search } = sidebar.contentState;
  const setTab = (tab: "chats" | "notes") => sidebar.updateContentState({ tab });
  const setSearch = (search: string) => sidebar.updateContentState({ search });
  const navigate = useNavigate();
  const folder = query.get("folder");
  const scopedChats = chats.filter(item => !folder || folder === "all" || item.folderId === folder);
  const scopedNotes = notes.data?.items.filter(item => !folder || folder === "all" || item.folderId === folder) ?? [];
  const visibleChats = scopedChats.filter(item => item.title.toLowerCase().includes(search.toLowerCase()));
  const visibleNotes = scopedNotes.filter(item => item.title.toLowerCase().includes(search.toLowerCase()));
  function selectionQuery(key: string, value: string) {
    const next = new URLSearchParams(query);
    next.delete("trash"); next.delete("new"); next.set(key, value);
    return `${base}?${next}`;
  }
  async function createNote() {
    const startedAt = window.location.href;
    try {
      const note = await send<ContentRecord>(`/enterprise/api/projects/${project.id}/workspace-content`, {
        kind: "note", title: "Untitled note", body: "", folderId: folder && folder !== "all" ? folder : null, data: { format: "markdown" },
      });
      if (window.location.href === startedAt) { navigate(selectionQuery("note", note.id)); setTab("notes"); sidebar.setDrawer(null); }
      setError(""); workspaceChanged();
    } catch (error) { setError((error as Error).message); }
  }
  const rows = tab === "chats" ? visibleChats : visibleNotes;
  const pinned = (item: Conversation | ContentRecord) => "data" in item ? Boolean(item.data.pinned) : item.pinned;
  // Compact Adaptive uses one drawer page at a time, so keep creation actions
  // reachable when navigation is behind the Back control.
  const showQuickActions = sidebar.preferences.style !== "adaptive" || sidebar.compactAdaptive;
  return <aside className="workspace-detail-rail" aria-label="Workspace content">
    <header className="workspace-detail-heading"><SidebarControls page="content" placement="leading" onBack={() => {
      sidebar.showNavigation(); navigate(`${base}?${query}`);
      focusSidebarControl(".sidebar [data-folder-selection].active, .sidebar [data-folder-selection]");
    }} /><div><strong title={folderName ?? "All Workspaces"}>{folderName ?? "All Workspaces"}</strong><small>{scopedChats.length} {scopedChats.length === 1 ? "chat" : "chats"} · {scopedNotes.length} {scopedNotes.length === 1 ? "note" : "notes"}</small></div><SidebarControls page="content" /></header>
    {showQuickActions ? <div className="workspace-detail-actions">
      <Link className="nav-link" to={selectionQuery("new", "1")} onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { sidebar.rememberChatTrigger(event.currentTarget); sidebar.setDrawer(null); } }}><Icon icon={SquarePen} size={13} />New chat</Link>
      <button className="nav-link" onClick={() => void createNote()}><Icon icon={FileText} size={13} />New note</button>
    </div> : null}
    <div className="tabs segmented" role="tablist" aria-label="Workspace content type" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "chats" : event.key === "End" ? "notes" : tab === "chats" ? "notes" : "chats";
      setTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
    }}>
      <button role="tab" data-tab="chats" tabIndex={tab === "chats" ? 0 : -1} className={tab === "chats" ? "active" : ""} aria-selected={tab === "chats"} onClick={() => setTab("chats")}>Chats</button>
      <button role="tab" data-tab="notes" tabIndex={tab === "notes" ? 0 : -1} className={tab === "notes" ? "active" : ""} aria-selected={tab === "notes"} onClick={() => setTab("notes")}>Notes</button>
    </div>
    <SearchField label={`Search ${tab}`} placeholder={`Search ${tab}…`} value={search} onChange={setSearch} />
    <ErrorNotice message={error || chatsError || notes.error} />
    <div className="workspace-detail-list">
      {[true, false].map(isPinned => <details open className="rail-section" key={String(isPinned)}>
        <summary className="disclosure-heading"><span>{isPinned ? `Pinned ${tab}` : tab === "chats" ? "Recents" : "Notes"}</span><DisclosureChevron /></summary>
        {rows.filter(item => Boolean(pinned(item)) === isPinned).map(item => <div className="rail-row" key={item.id}>
          <Link className={`nav-link ${query.get(tab === "chats" ? "conversation" : "note") === item.id ? "active" : ""}`} aria-current={query.get(tab === "chats" ? "conversation" : "note") === item.id ? "page" : undefined} to={selectionQuery(tab === "chats" ? "conversation" : "note", item.id)} onClick={() => sidebar.setDrawer(null)}><Icon icon={tab === "chats" ? MessageSquare : FileText} size={13} /><span>{item.title}</span></Link>
          <Menu label={`Content actions for ${item.title}`} className="rail-action" iconSize={12}><MenuItem onSelect={async () => {
            try {
              if ("data" in item) await send(`/enterprise/api/projects/${project.id}/workspace-content/${item.id}`, { expectedRevision: item.revision, data: { ...item.data, pinned: !pinned(item) } }, "PATCH");
              else await send(`/enterprise/api/conversations/${item.id}/organization`, { pinned: !pinned(item) }, "PATCH");
              setError(""); workspaceChanged();
            } catch (error) { setError((error as Error).message); }
          }}>{isPinned ? "Unpin" : "Pin"}</MenuItem></Menu>
        </div>)}
        {!rows.some(item => Boolean(pinned(item)) === isPinned) ? <p className="rail-empty">{isPinned ? `No pinned ${tab}.` : `No ${tab} in this folder.`}</p> : null}
      </details>)}
    </div>
  </aside>;
}

export function WorkspaceNotePanel({ projectId, noteId, onClose }: { projectId: string; noteId: string; onClose: () => void }) {
  const note = useResource<ContentRecord>(`/enterprise/api/projects/${projectId}/workspace-content/${noteId}`);
  useWorkspaceChanges(note.reload);
  return <section className="workspace-note-panel" aria-label="Open note">
    <header className="thread-header"><h2>Note</h2><button className="icon-button" aria-label="Close note" onClick={onClose}><Icon icon={X} size={14} weight="control" /></button></header>
    <ErrorNotice message={note.error} />
    {note.data ? <Suspense fallback={<Loading />}><DocumentEditor key={noteId} record={note.data} onSaved={() => { note.reload(); workspaceChanged(); }} /></Suspense> : note.loading ? <Loading /> : null}
  </section>;
}
