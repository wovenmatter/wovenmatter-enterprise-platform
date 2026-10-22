import { lazy, Suspense, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { MessageSquare, NotebookPen, X } from "lucide-react";
import { send, useResource, type Conversation, type List, type Project } from "../api";
import { DisclosureChevron, Icon, Menu, MenuItem, SearchField } from "../components/controls";
import { ErrorNotice, Loading } from "../components/ui";
import { workspaceChanged, useWorkspaceChanges } from "../workspace-events";
import type { ContentRecord } from "../features/workspace-content";
const DocumentEditor = lazy(() => import("../features/workspace-content").then(module => ({ default: module.DocumentEditor })));

export function WorkspaceDetails({ project, chats, folderName }: { project: Project; chats: Conversation[]; folderName?: string }) {
  const notes = useResource<List<ContentRecord>>(`/enterprise/api/projects/${project.id}/workspace-content?kind=note`);
  useWorkspaceChanges(notes.reload);
  const [tab, setTab] = useState("chats");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useSearchParams();
  const folder = query.get("folder");
  const scopedChats = chats.filter(item => !folder || folder === "all" || item.folderId === folder);
  const scopedNotes = notes.data?.items.filter(item => !folder || folder === "all" || item.folderId === folder) ?? [];
  const visibleChats = scopedChats.filter(item => item.title.toLowerCase().includes(search.toLowerCase()));
  const visibleNotes = scopedNotes.filter(item => item.title.toLowerCase().includes(search.toLowerCase()));
  async function createNote() {
    try {
      const note = await send<ContentRecord>(`/enterprise/api/projects/${project.id}/workspace-content`, {
        kind: "note", title: "Untitled note", body: "", folderId: folder && folder !== "all" ? folder : null, data: { format: "markdown" },
      });
      const next = new URLSearchParams(query); next.set("note", note.id); setQuery(next); setTab("notes"); workspaceChanged();
    } catch (error) { setError((error as Error).message); }
  }
  const rows = tab === "chats" ? visibleChats : visibleNotes;
  const pinned = (item: Conversation | ContentRecord) => "data" in item ? Boolean(item.data.pinned) : item.pinned;
  return <aside className="workspace-detail-rail" aria-label="Workspace content">
    <header className="workspace-detail-heading"><div><strong>{folderName ?? "All Workspaces"}</strong><small>{scopedChats.length} {scopedChats.length === 1 ? "chat" : "chats"} · {scopedNotes.length} {scopedNotes.length === 1 ? "note" : "notes"}</small></div></header>
    <div className="workspace-detail-actions">
      <button className="nav-link" onClick={() => { const next = new URLSearchParams(query); next.set("new", "1"); setQuery(next); }}><Icon icon={MessageSquare} size={13} />New chat</button>
      <button className="nav-link" onClick={() => void createNote()}><Icon icon={NotebookPen} size={13} />New note</button>
    </div>
    <div className="tabs segmented" role="tablist" aria-label="Workspace content type">
      <button role="tab" className={tab === "chats" ? "active" : ""} aria-selected={tab === "chats"} onClick={() => setTab("chats")}>Chats</button>
      <button role="tab" className={tab === "notes" ? "active" : ""} aria-selected={tab === "notes"} onClick={() => setTab("notes")}>Notes</button>
    </div>
    <SearchField label={`Search ${tab}`} placeholder={`Search ${tab}…`} value={search} onChange={setSearch} />
    <ErrorNotice message={error || notes.error} />
    <div className="workspace-detail-list">
      {[true, false].map(isPinned => <details open className="rail-section" key={String(isPinned)}>
        <summary className="disclosure-heading"><span>{isPinned ? `Pinned ${tab}` : tab === "chats" ? "Chats" : "Notes"}</span><DisclosureChevron /></summary>
        {rows.filter(item => Boolean(pinned(item)) === isPinned).map(item => <div className="rail-row" key={item.id}>
          {tab === "chats" ? <Link className={`nav-link ${query.get("conversation") === item.id ? "active" : ""}`} to={`?${new URLSearchParams({ ...(folder ? { folder } : {}), conversation: item.id, ...(query.get("note") ? { note: query.get("note")! } : {}) })}`}><Icon icon={MessageSquare} size={13} /><span>{item.title}</span></Link> : <button className={`nav-link ${query.get("note") === item.id ? "active" : ""}`} onClick={() => { const next = new URLSearchParams(query); next.set("note", item.id); setQuery(next); }}><Icon icon={NotebookPen} size={13} /><span>{item.title}</span></button>}
          <Menu label={`Content actions for ${item.title}`} className="rail-action" iconSize={12}><MenuItem onSelect={async () => {
            try {
              if ("data" in item) await send(`/enterprise/api/projects/${project.id}/workspace-content/${item.id}`, { expectedRevision: item.revision, data: { ...item.data, pinned: !pinned(item) } }, "PATCH");
              else await send(`/enterprise/api/conversations/${item.id}/organization`, { pinned: !pinned(item) }, "PATCH");
              workspaceChanged();
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
    <header className="thread-header"><h2>Note</h2><button className="icon-button" aria-label="Close note" onClick={onClose}><Icon icon={X} size={14} /></button></header>
    <ErrorNotice message={note.error} />
    {note.data ? <Suspense fallback={<Loading />}><DocumentEditor key={noteId} record={note.data} onSaved={() => { note.reload(); workspaceChanged(); }} /></Suspense> : note.loading ? <Loading /> : null}
  </section>;
}
