import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownUp, CalendarDays, Cpu, FileText, Image, Link2, MessageSquare, Plus, Users } from "lucide-react";
import { date, send, useResource, type List, type Project } from "../api";
import { safeContentUrl } from "../conversation-state";
import { Icon, Picker, SearchField } from "../components/controls";
import { AsyncForm, Empty, ErrorNotice, Field, Loading, Modal, PageHeader } from "../components/ui";
import { useWorkspace } from "../workspace";
import { agentName, agents } from "../agents";
import { workspaceChanged, useWorkspaceChanges } from "../workspace-events";
type LibraryItem = { id: string; title: string; type: "link" | "file" | "photo" | "artifact"; url?: string; fileId?: string; versionId?: string; sender: "member" | "agent"; harness?: string; conversationId?: string; conversationTitle?: string; sentAt: string; storage: string; saved: boolean; retentionStatus?: "pending" | "retained" | "unavailable" | null; retentionError?: string | null; downloadUrl?: string | null };
export function WorkspaceLibraryPage({ project }: { project: Project }) {
  const { orgBase } = useWorkspace();
  const resource = useResource<List<LibraryItem>>(`/enterprise/api/projects/${project.id}/workspace-library`);
  useWorkspaceChanges(resource.reload);
  const pending = resource.data?.items.some(item => item.retentionStatus === "pending");
  useEffect(() => { if (!pending) return; const timer = window.setInterval(resource.reload, 3000); return () => clearInterval(timer); }, [pending, resource.reload]);
  const [collection, setCollection] = useState("messages");
  const [kind, setKind] = useState("all");
  const [sender, setSender] = useState("all");
  const [harness, setHarness] = useState("all");
  const [range, setRange] = useState("all");
  const [order, setOrder] = useState("newest");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState("");
  const items = (resource.data?.items ?? []).filter(item => {
    if ((collection === "artifacts") !== (item.type === "artifact")) return false;
    if (!`${item.title} ${item.url ?? ""}`.toLowerCase().includes(search.toLowerCase())) return false;
    return collection === "artifacts" || ((kind === "all" || item.type === kind) && (sender === "all" || item.sender === sender) && (harness === "all" || item.harness === harness) && (range === "all" || new Date(item.sentAt).getTime() >= Date.now() - Number(range) * 86400000));
  }).sort((first, second) => ((Date.parse(first.sentAt) || 0) - (Date.parse(second.sentAt) || 0)) * (order === "oldest" ? 1 : -1));
  const filtered = Boolean(search || kind !== "all" || sender !== "all" || harness !== "all" || range !== "all");
  return <section className="desktop-content-page workspace-library"><PageHeader title="Library" description="Links, files, photos, and artifacts shared in this workspace." actions={<button className="primary" onClick={() => setAdding(true)}><Icon icon={Plus} size={14} />Save link</button>} />
    <div className="library-toolbar"><div className="tabs segmented" role="tablist" aria-label="Library collection">{[["messages", "Messages"], ["artifacts", "Saved Artifacts"]].map(([value, label]) => <button role="tab" aria-selected={collection === value} className={collection === value ? "active" : ""} key={value} onClick={() => setCollection(value)}>{label}</button>)}</div><Picker icon={ArrowDownUp} placeholder="All" label="Library order" heading="Order" value={order} options={[{value:"newest",label:"Newest first"},{value:"oldest",label:"Oldest first"}]} onChange={setOrder} /></div>
    <SearchField label="Search library" value={search} onChange={setSearch} placeholder="Search Library…" />
    {collection === "messages" ? <div className="library-filters">
      <Picker icon={Cpu} placeholder="All" label="Library agent types" heading="Agent types" value={harness} options={[{value:"all",label:"All agent types"},...agents.map(agent=>({value:agent.id,label:agent.name}))]} onChange={setHarness} />
      <Picker icon={Users} placeholder="All" label="Library senders" heading="Senders" value={sender} options={[{value:"all",label:"All senders"},{value:"member",label:"Members"},{value:"agent",label:"Agents"}]} onChange={setSender} />
      <Picker icon={FileText} placeholder="All" label="Library types" heading="Types" value={kind} options={[{value:"all",label:"All types"},{value:"link",label:"Links"},{value:"file",label:"Files"},{value:"photo",label:"Photos"}]} onChange={setKind} />
      <Picker icon={CalendarDays} placeholder="All" label="Library dates" heading="Dates" value={range} options={[{value:"all",label:"All dates"},{value:"1",label:"Past day"},{value:"7",label:"Past week"},{value:"30",label:"Past month"},{value:"365",label:"Past year"}]} onChange={setRange} />
    </div> : null}
    <div className="library-result-count"><small>{items.length} {items.length === 1 ? "item" : "items"}</small>{filtered ? <button className="text-button" onClick={() => { setSearch(""); setKind("all"); setSender("all"); setHarness("all"); setRange("all"); }}>Clear filters</button> : null}</div>
    <ErrorNotice message={error || resource.error} onRetry={resource.reload} />{resource.loading && !resource.data ? <Loading /> : null}
    <div className="library-items">{items.map(item => {
      const retainedUrl = item.retentionStatus === "retained" && item.downloadUrl?.startsWith(`/enterprise/api/projects/${encodeURIComponent(project.id)}/workspace-library/`) ? safeContentUrl(item.downloadUrl) : undefined;
      const href = item.retentionStatus ? retainedUrl : item.url ? safeContentUrl(item.url) : item.fileId ? `/enterprise/api/files/${encodeURIComponent(item.fileId)}/content?${new URLSearchParams({projectId:project.id,...(item.versionId ? {versionId:item.versionId} : {})})}` : undefined;
      return <article className="library-item" key={item.id}><Icon icon={item.type === "link" ? Link2 : item.type === "photo" ? Image : FileText} size={18} /><div>{href ? <a className="library-item-title" href={href} target="_blank" rel="noopener noreferrer">{item.title}</a> : item.type === "artifact" ? <Link className="library-item-title" to={`${orgBase}/workspaces/${project.id}/artifacts?item=${encodeURIComponent(item.id)}`}>{item.title}</Link> : <strong>{item.title}</strong>}<small>{item.sender === "agent" ? agentName(item.harness) : "Member"} · {item.saved ? "Saved" : "Shared"}{item.sentAt ? ` · ${date(item.sentAt)}` : ""}</small>{item.retentionStatus === "pending" ? <small role="status">Saving a workspace copy…</small> : item.retentionStatus === "unavailable" ? <><small>{item.retentionError || "This file is unavailable."}</small><button className="text-button" disabled={retrying === item.id} aria-label={`Retry saving ${item.title}`} onClick={async () => { setError(""); setRetrying(item.id); try { await send(`/enterprise/api/projects/${project.id}/workspace-library/${encodeURIComponent(item.id)}/retry`, {}); resource.reload(); } catch (error) { setError((error as Error).message); } finally { setRetrying(""); } }}>{retrying === item.id ? "Retrying…" : "Retry saving file"}</button></> : null}{item.type === "link" && item.url ? <small className="library-url">{item.url}</small> : null}</div>{item.conversationId ? <Link className="icon-button" title={item.conversationTitle || "Open conversation"} aria-label={`Open conversation for ${item.title}`} to={`${orgBase}/workspaces/${project.id}?conversation=${encodeURIComponent(item.conversationId)}`}><Icon icon={MessageSquare} size={15} /></Link> : null}</article>;
    })}</div>{!items.length && resource.data ? <Empty title={filtered ? "No matching items" : collection === "artifacts" ? "No saved artifacts yet" : "No Library items yet"}>{filtered ? "Adjust your filters or search to find an item." : collection === "artifacts" ? "Create an artifact with New note in the workspace sidebar." : "Files, links, and photos exchanged in messages appear here. You can also save a link to keep it with the workspace."}</Empty> : null}
    {adding ? <Modal title="Save link" onClose={() => setAdding(false)}><AsyncForm submitLabel="Save link" onCancel={() => setAdding(false)} onSubmit={async form => { await send(`/enterprise/api/projects/${project.id}/workspace-content`, { kind: "library", title: form.get("title"), body: "", data: { type: "link", url: form.get("url") } }); resource.reload(); workspaceChanged(); setAdding(false); }}><Field label="Title"><input name="title" required autoFocus maxLength={200} /></Field><Field label="URL"><input name="url" required type="url" placeholder="https://" /></Field></AsyncForm></Modal> : null}
  </section>;
}
