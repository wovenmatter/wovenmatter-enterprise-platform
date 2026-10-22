import { occursOnDay } from "../calendar-occurrence";
import { useWorkspace } from "../workspace";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Database, Mic, Type, ChevronLeft, ChevronRight, FileText, History, NotebookPen, Plus, Redo2, Save, Trash2, Undo2 } from "lucide-react";
import { api, date, errorMessage, send, useResource, type List, type Project, type WorkspaceFolder } from "../api";
import { agents, agentName } from "../agents";
import { Icon, Menu, MenuItem, SearchField, Switch } from "../components/controls";
import { AsyncForm, Confirm, Empty, ErrorNotice, Field, Loading, Modal, PageHeader } from "../components/ui";
import { workspaceChanged, useWorkspaceChanges } from "../workspace-events";
const RichText = lazy(() => import("../components/RichText").then(m => ({ default: m.RichText })));
export type ContentRecord = {
  id: string; projectId: string; kind: "note" | "artifact" | "event" | "task" | "library" | "database";
  title: string; body: string; folderId: string | null; data: Record<string, unknown>;
  revision: number; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string;
};
const contentBase = (projectId: string) => `/enterprise/api/projects/${projectId}/workspace-content`;
export function useContent(projectId: string, kind?: string) {
  const resource = useResource<List<ContentRecord>>(contentBase(projectId) + (kind ? `?kind=${kind}` : ""));
  useWorkspaceChanges(resource.reload);
  return resource;
}

export function NotesPage({ project, kind = "note" }: { project: Project; kind?: "note" | "artifact" }) {
  const resource = useContent(project.id, kind);
  const [query, setQuery] = useSearchParams();
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<ContentRecord>();
  const selected = resource.data?.items.find(item => item.id === query.get("item"));
  const label = kind === "note" ? "note" : "artifact";
  async function create() {
    try {
      const record = await send<ContentRecord>(contentBase(project.id), { kind, title: `Untitled ${label}`, body: "", data: { format: kind === "note" ? "markdown" : "html" } });
      resource.reload(); setQuery({ item: record.id }); workspaceChanged();
    } catch (e) { setError(errorMessage(e)); }
  }
  return <section className="desktop-content-page notes-page">
    <PageHeader title={kind === "note" ? "Notes" : "Artifacts"} actions={<button className="primary" onClick={() => void create()}><Icon icon={Plus} size={14} />New {label}</button>} />
    <ErrorNotice message={resource.error || error} onRetry={resource.reload} />
    <div className="document-layout">
      <aside className="document-list" aria-label={kind === "note" ? "Workspace notes" : "Workspace artifacts"}>
        <SearchField label={`Search ${label}s`} placeholder={`Search ${label}s…`} value={search} onChange={setSearch} />
        {resource.loading && !resource.data ? <Loading /> : null}
        {resource.data?.items.filter(item => item.title.toLowerCase().includes(search.toLowerCase())).map(item => <div className="document-row" key={item.id}>
          <button className={`nav-link ${selected?.id === item.id ? "active" : ""}`} onClick={() => setQuery({ item: item.id })}><Icon icon={kind === "note" ? NotebookPen : FileText} size={14} /><span><strong>{item.title}</strong><small>{date(item.updatedAt)}</small></span></button>
          <button className="icon-button" aria-label={`Delete ${item.title}`} onClick={() => setRemoving(item)}><Icon icon={Trash2} size={13} /></button>
        </div>)}
      </aside>
      {selected ? <DocumentEditor key={selected.id} record={selected} onSaved={() => { resource.reload(); workspaceChanged(); }} /> : <Empty title={`Choose a ${label}`} action={<button className="secondary" onClick={() => void create()}>New {label}</button>}>Shared with every member of this workspace.</Empty>}
    </div>
    {removing ? <Confirm title={`Delete ${label}?`} onClose={() => setRemoving(undefined)} onConfirm={async () => { await api(`${contentBase(project.id)}/${removing.id}?revision=${removing.revision}`, { method: "DELETE" }); setRemoving(undefined); resource.reload(); workspaceChanged(); if (selected?.id === removing.id) setQuery({}); }}>Delete “{removing.title}” from this workspace.</Confirm> : null}
  </section>;
}

export function DocumentEditor({ record, onSaved }: { record: ContentRecord; onSaved: () => void }) {
  const { user } = useWorkspace();
  const draftKey = `wme:note-draft:v1:${user.id}:${record.projectId}:${record.id}`;
  const [recovered] = useState<{title:string;body:string;format:string;revision:number} | null>(() => {
    try { const draft = JSON.parse(sessionStorage.getItem(draftKey) ?? "null"); return draft && typeof draft.body === "string" && typeof draft.title === "string" && typeof draft.format === "string" && Number.isInteger(draft.revision) ? draft : null; } catch { return null; }
  });
  const [title, setTitle] = useState(recovered?.title ?? record.title);
  const [body, setBody] = useState(recovered?.body ?? record.body);
  const [format, setFormat] = useState(recovered?.format ?? String(record.data.format ?? "markdown"));
  const [revision, setRevision] = useState(recovered?.revision ?? record.revision);
  const [savedBody, setSavedBody] = useState(record.body);
  const [savedTitle, setSavedTitle] = useState(record.title);
  const [savedFormat, setSavedFormat] = useState(String(record.data.format ?? "markdown"));
  const [preview, setPreview] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const lastEdit = useRef(0);
  const [databaseOpen, setDatabaseOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const recognition = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => recognition.current?.stop(), []);
  const Speech = (window as unknown as { SpeechRecognition?: new () => SpeechInput; webkitSpeechRecognition?: new () => SpeechInput }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechInput }).webkitSpeechRecognition;

  const [history, setHistory] = useState(false);
  const [countCharacters, setCountCharacters] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(recovered ? "Recovered unsaved changes" : "");
  const [undo, setUndo] = useState<string[]>([]);
  const [redo, setRedo] = useState<string[]>([]);
  const changed = body !== savedBody || title !== savedTitle || format !== savedFormat;
  const versions = useResource<List<ContentRecord>>(history ? `${contentBase(record.projectId)}/${record.id}/versions` : null);
  useEffect(() => {
    try { if (changed) sessionStorage.setItem(draftKey, JSON.stringify({title,body,format,revision})); else sessionStorage.removeItem(draftKey); }
    catch { setError("Your browser could not retain this draft. Save before leaving the note."); }
  }, [draftKey, title, body, format, revision, changed]);
  // A refreshed server revision must not replace unsaved work.
  useEffect(() => {
    if (record.revision > revision && !changed) { setBody(record.body); setTitle(record.title); setRevision(record.revision); setSavedBody(record.body); setSavedTitle(record.title); setFormat(String(record.data.format ?? "markdown")); setSavedFormat(String(record.data.format ?? "markdown")); }
  }, [record, revision, changed]);
  useEffect(() => {
    if (!changed) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [changed]);
  async function save() {
    if (busy || !changed || !title.trim()) return;
    setBusy(true); setError("");
    try { const result = await send<ContentRecord>(`${contentBase(record.projectId)}/${record.id}`, { expectedRevision: revision, title, body, data: { ...record.data, format } }, "PATCH"); setRevision(result.revision); setSavedBody(body); setSavedTitle(title); setSavedFormat(format); setNotice("Saved"); onSaved(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  function change(value: string, force = false) {
    const now = Date.now();
    if (force || now - lastEdit.current > 700) setUndo(stack => [...stack.slice(-49), body]);
    lastEdit.current = now; setRedo([]); setBody(value); setNotice("");
  }
  function insert(before: string, after = "", fallback = "text") {
    const input = editor.current; const start = input?.selectionStart ?? body.length, end = input?.selectionEnd ?? body.length;
    const selection = body.slice(start, end) || fallback;
    change(body.slice(0, start) + before + selection + after + body.slice(end), true);
    setPreview(false); requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + before.length, start + before.length + selection.length); });
  }
  function replaceSelection(text: string) {
    const input = editor.current, start = input?.selectionStart ?? body.length, end = input?.selectionEnd ?? body.length;
    change(body.slice(0, start) + text + body.slice(end), true);
    setPreview(false); requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + text.length, start + text.length); });
  }
  function dictate() {
    if (listening) { recognition.current?.stop(); return; }
    if (!Speech) return;
    const session = new Speech(); recognition.current = session; session.continuous = false; session.interimResults = false;
    session.onresult = event => { const text = event.results[0]?.[0]?.transcript; if (text) replaceSelection(text); };
    session.onerror = event => { setError(`Dictation: ${event.error}`); setListening(false); };
    session.onend = () => setListening(false);
    setListening(true); session.start();
  }
  return <article className="document-editor">
    <header className="document-toolbar">
      <input className="document-title" aria-label="Document title" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} />
      <div className="row-actions">
        <button className="icon-button" aria-label="Undo" disabled={!undo.length} onClick={() => { setRedo(stack => [...stack, body]); setBody(undo.at(-1)!); setUndo(stack => stack.slice(0, -1)); }}><Icon icon={Undo2} size={14} /></button>
        <button className="icon-button" aria-label="Redo" disabled={!redo.length} onClick={() => { setUndo(stack => [...stack, body]); setBody(redo.at(-1)!); setRedo(stack => stack.slice(0, -1)); }}><Icon icon={Redo2} size={14} /></button>
        <button className="icon-button" aria-label="Version history" onClick={() => setHistory(true)}><Icon icon={History} size={14} /></button>
        <button className="icon-button" aria-label="Insert database query" onClick={() => setDatabaseOpen(true)}><Icon icon={Database} size={14} /></button>
        <Menu label="Format note" icon={Type} iconSize={14}>
          <MenuItem onSelect={() => insert(format === "html" ? "<strong>" : "**", format === "html" ? "</strong>" : "**")}>Bold</MenuItem>
          <MenuItem onSelect={() => insert(format === "html" ? "<em>" : "_", format === "html" ? "</em>" : "_")}>Italic</MenuItem>
          <MenuItem onSelect={() => insert(format === "html" ? "<h2>" : "## ", format === "html" ? "</h2>" : "", "Heading")}>Heading</MenuItem>
          <MenuItem onSelect={() => insert(format === "html" ? "<ul><li>" : "- ", format === "html" ? "</li></ul>" : "", "List item")}>Bullet list</MenuItem>
          <MenuItem onSelect={() => insert(format === "html" ? '<label><input type="checkbox"> ' : "- [ ] ", format === "html" ? "</label>" : "", "Task")}>Task list</MenuItem>
          <MenuItem onSelect={() => insert(format === "html" ? '<a href="https://">' : "[", format === "html" ? "</a>" : "](https://)", "Link label")}>Link</MenuItem>
        </Menu>
        <button className={`icon-button ${listening ? "active" : ""}`} aria-label={Speech ? listening ? "Stop dictation" : "Start dictation" : "Dictation unavailable in this browser"} title={Speech ? "Dictate note" : "Dictation unavailable in this browser"} disabled={!Speech} onClick={dictate}><Icon icon={Mic} size={14} /></button>
        <select aria-label="Document format" value={format} onChange={event => setFormat(event.target.value)}><option value="markdown">Markdown</option><option value="text">Text</option>{record.kind === "artifact" ? <><option value="html">HTML</option><option value="csv">CSV</option></> : null}</select>
        <button className="secondary" onClick={() => setPreview(value => !value)}>{preview ? "Edit" : "Preview"}</button>
        <button className="primary" disabled={busy || !changed || !title.trim()} onClick={() => void save()}><Icon icon={Save} size={13} />{busy ? "Saving…" : "Save"}</button>
      </div>
    </header>
    <ErrorNotice message={error} />
    {preview ? <div className="document-preview">{format === "html" ? <iframe title="Artifact preview" sandbox="" referrerPolicy="no-referrer" srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';">${body}`} /> : format === "markdown" ? <Suspense fallback={<Loading />}><RichText>{body}</RichText></Suspense> : <pre>{body}</pre>}</div> : <textarea ref={editor} className="document-body" aria-label="Document body" value={body} onChange={event => change(event.target.value)} placeholder="Start writing…" spellCheck={format !== "html"} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); void save(); } }} />}
    <footer className="document-footer"><span role="status">{changed ? notice || "Unsaved changes · draft retained" : notice || `Version ${revision}`}</span>{changed ? <button className="text-button" onClick={() => { setBody(record.body); setTitle(record.title); setFormat(String(record.data.format ?? "markdown")); setRevision(record.revision); setSavedBody(record.body); setSavedTitle(record.title); setSavedFormat(String(record.data.format ?? "markdown")); setNotice(""); setError(""); }}>Discard draft</button> : null}<button className="text-button" onClick={() => setCountCharacters(value => !value)}>{countCharacters ? `${body.length} characters` : `${body.trim() ? body.trim().split(/\s+/).length : 0} words`}</button></footer>
    {databaseOpen ? <InsertDatabase projectId={record.projectId} onClose={() => setDatabaseOpen(false)} onInsert={text => { replaceSelection(`\n${text}\n`); setDatabaseOpen(false); }} /> : null}
    {history ? <Modal title="Version history" onClose={() => setHistory(false)}><ErrorNotice message={versions.error} />{versions.loading ? <Loading /> : versions.data?.items.map(version => <div className="setting-row" key={version.revision}><div><strong>Version {version.revision}</strong><small>{date(version.updatedAt ?? version.createdAt)}</small></div><button className="secondary" disabled={version.revision === revision || changed} title={changed ? "Save your changes before restoring a version" : undefined} onClick={async () => { try { const result = await send<ContentRecord>(`${contentBase(record.projectId)}/${record.id}/restore`, { expectedRevision: revision, revision: version.revision }); setBody(result.body); setTitle(result.title); setRevision(result.revision); setSavedBody(result.body); setSavedTitle(result.title); setFormat(String(result.data.format ?? "markdown")); setSavedFormat(String(result.data.format ?? "markdown")); onSaved(); setHistory(false); } catch (e) { setError(errorMessage(e)); } }}>Restore</button></div>)}</Modal> : null}
  </article>;
}

type SpeechInput = { continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; onresult: (event: { results: { [index: number]: { [index: number]: { transcript: string } } } }) => void; onerror: (event: { error: string }) => void; onend: () => void };
function InsertDatabase({ projectId, onClose, onInsert }: { projectId: string; onClose: () => void; onInsert: (text: string) => void }) {
  const [databases, setDatabases] = useState<{ id: string; name: string }[]>([]), [error, setError] = useState("");
  useEffect(() => { let active = true; void send<{ databases: { id: string; name: string }[] }>(`/enterprise/api/projects/${projectId}/databases`, { action: "list" }).then(result => { if (active) setDatabases(result.databases); }).catch(e => { if (active) setError(errorMessage(e)); }); return () => { active = false; }; }, [projectId]);
  return <Modal title="Insert database query" onClose={onClose}><ErrorNotice message={error} /><AsyncForm submitLabel="Insert results" onCancel={onClose} onSubmit={async form => { const result = await send<{ query: { columns: string[]; rows: string[][] } }>(`/enterprise/api/projects/${projectId}/databases`, { action: "query", databaseID: form.get("databaseID"), sql: form.get("sql") }); const escape = (cell: string) => String(cell ?? "").replaceAll("|", "\\|").replaceAll("\n", " "); onInsert([`| ${result.query.columns.map(escape).join(" | ")} |`, `| ${result.query.columns.map(() => "---").join(" | ")} |`, ...result.query.rows.map(row => `| ${row.map(escape).join(" | ")} |`)].join("\n")); }}><Field label="Database"><select name="databaseID" required defaultValue=""><option value="" disabled>Select a database</option>{databases.map(database => <option value={database.id} key={database.id}>{database.name}</option>)}</select></Field><Field label="Query"><textarea name="sql" rows={4} required defaultValue="SELECT name FROM sqlite_master WHERE type = 'table'" /></Field></AsyncForm></Modal>;
}

const calendarColors = ["#004225", "#4169e1", "#800080", "#9a5a2a", "#0d8f5a", "#ef4444", "#ec4899", "#f97316", "#eab308", "#000000"];
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export function CalendarPage({ project, tasksOnly = false }: { project: Project; tasksOnly?: boolean }) {
  const resource = useContent(project.id);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(() => dayKey(new Date()));
  const [editing, setEditing] = useState<ContentRecord | "event" | "task">();
  const [removing, setRemoving] = useState<ContentRecord>();
  const [error, setError] = useState("");
  const [enabledOverrides, setEnabledOverrides] = useState<Record<string, boolean>>({});
  const items = resource.data?.items.filter(item => tasksOnly ? item.kind === "task" : item.kind === "event" || item.kind === "task" && item.data.showsOnCalendar !== false) ?? [];
  const selected = tasksOnly ? items : items.filter(item => occursOnDay(item.data, selectedDay));
  const first = new Date(month); first.setDate(1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, index) => { const cell = new Date(first); cell.setDate(first.getDate() + index); return cell; });
  async function toggle(record: ContentRecord, enabled: boolean) {
    setEnabledOverrides(previous => ({ ...previous, [record.id]: enabled }));
    try { await send(`${contentBase(project.id)}/${record.id}`, { expectedRevision: record.revision, data: { ...record.data, enabled } }, "PATCH"); resource.reload(); }
    catch (e) { setEnabledOverrides(previous => ({ ...previous, [record.id]: record.data.enabled !== false })); setError(errorMessage(e)); }
  }
  return <section className="desktop-content-page calendar-page">
    <PageHeader title={tasksOnly ? "Scheduled Tasks" : "Calendar"} actions={<button className="primary" onClick={() => setEditing(tasksOnly ? "task" : "event")}><Icon icon={Plus} size={14} />{tasksOnly ? "New task" : "New event"}</button>} />
    <ErrorNotice message={resource.error || error} onRetry={resource.reload} />
    <div className={tasksOnly ? "" : "calendar-layout"}>
      {!tasksOnly ? <div className="calendar-month"><div className="calendar-month-heading"><h2>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2><div className="row-actions"><button className="icon-button" aria-label="Previous month" onClick={() => setMonth(value => new Date(value.getFullYear(), value.getMonth() - 1, 1))}><Icon icon={ChevronLeft} size={16} /></button><button className="text-button" onClick={() => { const today = new Date(); setMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setSelectedDay(dayKey(today)); }}>Today</button><button className="icon-button" aria-label="Next month" onClick={() => setMonth(value => new Date(value.getFullYear(), value.getMonth() + 1, 1))}><Icon icon={ChevronRight} size={16} /></button></div></div>
        <div className="calendar-grid" role="grid" aria-label="Calendar month">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => <div className="calendar-weekday" key={day}>{day}</div>)}{cells.map(cell => { const key = dayKey(cell); const events = items.filter(item => occursOnDay(item.data, key)); return <button role="gridcell" aria-selected={key === selectedDay} aria-label={`${cell.toLocaleDateString(undefined, { dateStyle: "full" })}, ${events.length} events`} className={`calendar-day ${cell.getMonth() !== month.getMonth() ? "outside" : ""} ${key === selectedDay ? "selected" : ""} ${key === dayKey(new Date()) ? "today" : ""}`} key={key} onClick={() => setSelectedDay(key)}><span>{cell.getDate()}</span><div className="calendar-dots">{events.slice(0, 4).map(item => <i key={item.id} style={{ backgroundColor: String(item.data.color ?? (item.kind === "task" ? "#4169e1" : "#004225")) }} />)}</div></button>; })}</div>
      </div> : null}
      <div className="calendar-agenda">{!tasksOnly ? <h2>{new Date(`${selectedDay}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</h2> : null}
        {resource.loading && !resource.data ? <Loading /> : null}
        {selected.map(item => <div key={item.id}><article className="agenda-row"><span className="event-color" style={{ backgroundColor: String(item.data.color ?? (item.kind === "task" ? "#4169e1" : "#004225")) }} /><button className="agenda-title" onClick={() => setEditing(item)}><strong>{item.title}</strong><small>{item.data.allDay ? "All day" : date(String(item.data.startsAt))}{item.data.recurrence ? ` · Every ${(item.data.recurrence as { interval: number }).interval || 1} ${(item.data.recurrence as { unit: string }).unit}` : ""}</small>{item.kind === "task" ? <small>{agentName(String(item.data.harness))} · {String(item.data.sessionMode ?? "new")} chat</small> : null}</button>{item.kind === "task" ? <Switch checked={enabledOverrides[item.id] ?? item.data.enabled !== false} onChange={event => void toggle(item, event.target.checked)}>Enable {item.title}</Switch> : null}<button className="icon-button" aria-label={`Delete ${item.title}`} onClick={() => setRemoving(item)}><Icon icon={Trash2} size={13} /></button></article>{item.kind === "task" ? <TaskHistory projectId={project.id} recordId={item.id} /> : null}</div>)}
        {!selected.length && resource.data ? <Empty title={tasksOnly ? "No scheduled tasks" : "Nothing scheduled"}>{tasksOnly ? "Schedule an agent to work at a specific time or on a recurring schedule." : "Add an event or a scheduled task."}</Empty> : null}
        {!tasksOnly ? <><div className="row-actions"><button className="secondary" onClick={() => setEditing("event")}>Add event</button><button className="secondary" onClick={() => setEditing("task")}>Add task</button></div><div className="calendar-legend">{[["#004225", "Events"], ["#4169e1", "Scheduled tasks"], ["#800080", "Recurring events"], ["#9a5a2a", "Recurring tasks"]].map(([color, label]) => <span key={label}><i style={{ backgroundColor: color }} />{label}</span>)}</div></> : null}
      </div>
    </div>
    {editing ? <ScheduleEditor project={project} record={typeof editing === "string" ? undefined : editing} kind={typeof editing === "string" ? editing : editing.kind as "event" | "task"} day={selectedDay} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); resource.reload(); workspaceChanged(); }} /> : null}
    {removing ? <Confirm title={`Delete ${removing.kind}?`} onClose={() => setRemoving(undefined)} onConfirm={async () => { await api(`${contentBase(project.id)}/${removing.id}?revision=${removing.revision}`, { method: "DELETE" }); setRemoving(undefined); resource.reload(); }}>Delete “{removing.title}” and its future recurrences.</Confirm> : null}
  </section>;
}
function TaskHistory({ projectId, recordId }: { projectId: string; recordId: string }) {
  const { orgBase } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const runs = useResource<{items:{id:string;occurrence:string;conversationId:string|null;status:string;error:string|null}[];state:{nextAt:string|null;lastStatus:string|null;lastError:string|null}|null}>(expanded ? `${contentBase(projectId)}/${recordId}/runs` : null, 5000);
  return <details className="task-history" onToggle={event=>setExpanded(event.currentTarget.open)}><summary>Run history</summary>{expanded ? <><ErrorNotice message={runs.error} />{runs.loading && !runs.data ? <Loading /> : null}{runs.data?.state?.nextAt ? <p className="muted">Next run: {date(runs.data.state.nextAt)}</p> : null}{runs.data?.state?.lastError ? <ErrorNotice message={runs.data.state.lastError} /> : null}{runs.data?.items.map(run=><div className="setting-row" key={run.id}><span>{date(run.occurrence)}<small>{run.status}{run.error ? ` · ${run.error}` : ""}</small></span>{run.conversationId ? <Link className="text-button" to={`${orgBase}/workspaces/${projectId}?conversation=${encodeURIComponent(run.conversationId)}`}>Open chat</Link> : null}</div>)}{runs.data && !runs.data.items.length ? <p className="muted">No runs yet.</p> : null}</> : null}</details>;
}

function localTime(iso?: unknown, fallback = "") { if (!iso) return fallback; const value = new Date(String(iso)); if (!Number.isFinite(value.getTime())) return fallback; return `${dayKey(value)}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`; }
function ScheduleEditor({ project, record, kind, day, onClose, onSaved }: { project: Project; record?: ContentRecord; kind: "event" | "task"; day: string; onClose: () => void; onSaved: () => void }) {
  const folders = useResource<List<WorkspaceFolder>>(`/enterprise/api/projects/${project.id}/folders`);
  const recurrence = record?.data.recurrence as { unit: string; interval: number } | undefined;
  return <Modal title={`${record ? "Edit" : "New"} ${kind}`} onClose={onClose}><AsyncForm submitLabel={record ? "Save changes" : `Create ${kind}`} onCancel={onClose} onSubmit={async form => {
    const unit = String(form.get("recurrence")); const data = { ...record?.data, startsAt: new Date(String(form.get("startsAt"))).toISOString(), endsAt: form.get("endsAt") ? new Date(String(form.get("endsAt"))).toISOString() : undefined, allDay: form.get("allDay") === "on", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, recurrence: unit ? { unit, interval: Number(form.get("interval")) || 1 } : undefined, color: form.get("color"), ...(kind === "task" ? { prompt: form.get("prompt"), harness: form.get("harness"), model: form.get("model") || undefined, folderId: form.get("folderId") || null, sessionMode: form.get("sessionMode"), enabled: form.get("enabled") === "on", showsOnCalendar: form.get("showsOnCalendar") === "on" } : {}) };
    await send(contentBase(project.id) + (record ? `/${record.id}` : ""), { ...(record ? { expectedRevision: record.revision } : { kind }), title: form.get("title"), body: form.get("body") ?? "", folderId: form.get("folderId") || null, data }, record ? "PATCH" : "POST"); onSaved();
  }}><Field label="Title"><input name="title" defaultValue={record?.title} required autoFocus maxLength={200} /></Field>
    <div className="form-columns"><Field label="Starts"><input name="startsAt" type="datetime-local" defaultValue={localTime(record?.data.startsAt, `${day}T09:00`)} required /></Field>{kind === "event" ? <Field label="Ends"><input name="endsAt" type="datetime-local" defaultValue={localTime(record?.data.endsAt)} /></Field> : null}</div>
    {kind === "event" ? <Switch name="allDay" defaultChecked={Boolean(record?.data.allDay)}>All day</Switch> : null}
    <div className="form-columns"><Field label="Repeat"><select name="recurrence" defaultValue={recurrence?.unit ?? ""}><option value="">Does not repeat</option><option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option></select></Field><Field label="Every"><input name="interval" type="number" min={1} max={365} defaultValue={recurrence?.interval ?? 1} /></Field><Field label="Color"><select name="color" defaultValue={String(record?.data.color ?? (kind === "task" ? "#4169e1" : "#004225"))}>{calendarColors.map((color, index) => <option value={color} key={color}>{["British Racing Green", "Royal blue", "Purple", "Cognac", "Green", "Red", "Pink", "Orange", "Yellow", "Black"][index]}</option>)}</select></Field></div>
    {kind === "task" ? <>
      <Field label="Prompt"><textarea name="prompt" defaultValue={String(record?.data.prompt ?? "")} rows={4} required /></Field>
      <div className="form-columns"><Field label="Agent"><select name="harness" defaultValue={String(record?.data.harness ?? "pi")}>{agents.map(agent => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></Field><Field label="Model" hint="Leave empty to use the workspace default."><input name="model" defaultValue={String(record?.data.model ?? "")} /></Field></div>
      <div className="form-columns"><Field label="Folder"><select name="folderId" defaultValue={record?.folderId ?? ""}><option value="">Workspace root</option>{folders.data?.items.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field><Field label="Conversation"><select name="sessionMode" defaultValue={String(record?.data.sessionMode ?? "new")}><option value="new">New chat each time</option><option value="same">Reuse the same chat</option></select></Field></div>
      <Switch name="enabled" defaultChecked={record?.data.enabled !== false}>Enabled</Switch><Switch name="showsOnCalendar" defaultChecked={record?.data.showsOnCalendar !== false}>Show on calendar</Switch>
    </> : <Field label="Notes"><textarea name="body" rows={3} defaultValue={record?.body} /></Field>}
  </AsyncForm></Modal>;
}

export function UsagePage({ project }: { project: Project }) {
  const usage = useResource<{ items: { harness: string; model: string; runs: number; completed: number; failed: number; inputTokens: number | null; outputTokens: number | null; cost: number | null; totalTokens?: number | null; measuredRuns?: number }[]; totals: { runs: number; completed: number; failed: number } }>(`/enterprise/api/projects/${project.id}/usage`);
  return <section className="desktop-content-page usage-page"><PageHeader title="Usage" description="Agent activity in this workspace." /><ErrorNotice message={usage.error} onRetry={usage.reload} />{usage.loading ? <Loading /> : null}{usage.data ? <><div className="usage-totals">{Object.entries(usage.data.totals).map(([label, value]) => <div key={label}><span className="capitalize">{label}</span><strong>{value}</strong></div>)}</div><div className="table-wrap"><table><thead><tr><th>Agent / model</th><th>Runs</th><th>Completed</th><th>Failed</th><th>Total tokens</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th></tr></thead><tbody>{usage.data.items.map((item, index) => <tr key={index}><td><strong>{agentName(item.harness)}</strong><small>{item.model || "Default model"}</small></td><td>{item.runs}</td><td>{item.completed}</td><td>{item.failed}</td><td>{item.totalTokens?.toLocaleString() ?? "Unavailable"}</td><td>{item.inputTokens?.toLocaleString() ?? "Unavailable"}</td><td>{item.outputTokens?.toLocaleString() ?? "Unavailable"}</td><td>{item.cost === null ? "Unavailable" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(item.cost)}</td></tr>)}</tbody></table></div>{!usage.data.items.length ? <Empty title="No activity yet">Usage appears when an agent runs.</Empty> : null}</> : null}</section>;
}
