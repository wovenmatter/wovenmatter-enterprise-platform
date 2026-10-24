import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { File, FileText, MessageSquare, Plus, Upload, X } from "lucide-react";
import { api, errorMessage, useResource, type Conversation, type List } from "../api";
import { agentName } from "../agents";
import { Icon, Menu, MenuItem, SearchField } from "../components/controls";
import { ErrorNotice, Loading, Modal } from "../components/ui";
import type { ContentRecord } from "./workspace-content";
import "./composer-attachments.css";

export type ComposerAttachment = {
  kind: "file" | "note" | "conversation";
  id: string;
  title: string;
  /** Local display/limit hint; the send endpoint resolves authoritative files. */
  size?: number;
};
type AttachmentDraftProps = {
  attachments: ComposerAttachment[];
  onChange: (attachments: ComposerAttachment[]) => void;
  disabled?: boolean;
};
const icons = { file: File, note: FileText, conversation: MessageSquare };
const maxAttachments = 20;
const maxFiles = 8;
const maxFileBytes = 25 * 1024 * 1024;
const maxTotalFileBytes = 50 * 1024 * 1024;

/** DashboardDraftAttachmentChip. References remain IDs until authorized send. */
export function ComposerAttachmentChips({ attachments, onChange, disabled, projectId }: AttachmentDraftProps & { projectId?: string }) {
  if (!attachments.length) return null;
  return <div className="composer-attachments" role="list" aria-label="Attachments">
    {attachments.map(attachment => <div role="listitem" className="composer-attachment-chip" key={`${attachment.kind}:${attachment.id}`}>
      <Icon icon={icons[attachment.kind]} size={14} />
      {attachment.kind === "file" ? <a href={`/enterprise/api/files/${encodeURIComponent(attachment.id)}/content${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`} target="_blank" rel="noopener noreferrer" title={attachment.title} aria-label={`Open ${attachment.title}`}>{attachment.title}</a>
        : <span title={attachment.title}>{attachment.title}</span>}
      <small>{attachment.kind}</small>
      <button type="button" className="icon-button" disabled={disabled} aria-label={`Remove ${attachment.title}`}
        onClick={() => onChange(attachments.filter(item => item.kind !== attachment.kind || item.id !== attachment.id))}>
        <Icon icon={X} size={11} weight="control" />
      </button>
    </div>)}
  </div>;
}

/** DashboardComposerAttachmentMenu: upload, note, conversation. */
export function ComposerAttachments({ orgId, projectId, attachments, onChange, disabled, onBusy }: AttachmentDraftProps & {
  orgId: string;
  projectId: string;
  onBusy: (busy: boolean) => void;
}) {
  const [picker, setPicker] = useState<"note" | "conversation" | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const pickerTrigger = useRef<HTMLElement | null>(null);
  const latest = useRef({ attachments, onChange, onBusy });
  latest.current = { attachments, onChange, onBusy };
  useEffect(() => () => {
    controller.current?.abort();
    if (controller.current) latest.current.onBusy(false);
  }, []);
  useLayoutEffect(() => {
    if (picker) return;
    const trigger = pickerTrigger.current;
    pickerTrigger.current = null;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, [picker]);
  function append(items: ComposerAttachment[]) {
    const existing = latest.current.attachments;
    const next = [...existing, ...items.filter(item => !existing.some(current => current.kind === item.kind && current.id === item.id))];
    latest.current.attachments = next;
    latest.current.onChange(next);
  }
  function showPicker(kind: "note" | "conversation") {
    pickerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError("");
    setPicker(kind);
  }
  async function uploadFiles(files: FileList | null) {
    if (!files?.length || disabled || controller.current) return;
    const current = latest.current.attachments, selected: File[] = [], errors: string[] = [];
    const attachedFiles = current.filter(item => item.kind === "file");
    let bytes = attachedFiles.reduce((total, item) => total + (item.size ?? 0), 0);
    for (const file of Array.from(files)) {
      if (current.length + selected.length >= maxAttachments) errors.push(`${file.name}: up to ${maxAttachments} attachments per message.`);
      else if (attachedFiles.length + selected.length >= maxFiles) errors.push(`${file.name}: up to ${maxFiles} files per message.`);
      else if (file.size > maxFileBytes) errors.push(`${file.name}: exceeds the 25 MiB file limit.`);
      else if (bytes + file.size > maxTotalFileBytes) errors.push(`${file.name}: exceeds the 50 MiB total file limit.`);
      else { selected.push(file); bytes += file.size; }
    }
    if (upload.current) upload.current.value = "";
    setError(errors.join(" "));
    if (!selected.length) return;
    const request = new AbortController();
    controller.current = request;
    setUploading(true); onBusy(true);
    try {
      const data = new FormData();
      data.set("orgId", orgId);
      data.set("projectId", projectId);
      data.set("path", `.WovenMatter/attachments/${crypto.randomUUID()}`);
      // Distinct subpaths also protect files with the same display name.
      data.set("paths", JSON.stringify(selected.map((file, index) => `${index + 1}/${file.name}`)));
      for (const file of selected) data.append("files", file, file.name);
      const result = await api<{ items: { id: string; name: string; size: number }[]; errors: { path: string; message: string }[] }>(
        "/enterprise/api/files/upload", { method: "POST", body: data, signal: request.signal },
      );
      if (request.signal.aborted) return;
      append(result.items.map(item => ({ kind: "file", id: item.id, title: item.name, size: item.size })));
      errors.push(...result.errors.map(item => `${item.path}: ${item.message}`));
      setError(errors.join(" "));
    } catch (error) {
      if (!request.signal.aborted) setError([...errors, errorMessage(error)].join(" "));
    } finally {
      if (!request.signal.aborted) { controller.current = null; setUploading(false); latest.current.onBusy(false); }
    }
  }
  const full = attachments.length >= maxAttachments;
  return <>
    <div className="composer-attachment-control">
      <Menu label="Add files or photos" icon={Plus} iconSize={16} className="composer-attachment-trigger" align="start" disabled={disabled || uploading}>
        <MenuItem icon={Upload} disabled={full || attachments.filter(item => item.kind === "file").length >= maxFiles} onSelect={() => upload.current?.click()}>Upload photos or files</MenuItem>
        <MenuItem icon={FileText} disabled={full} onSelect={() => showPicker("note")}>Attach note</MenuItem>
        <MenuItem icon={MessageSquare} disabled={full} onSelect={() => showPicker("conversation")}>Attach conversation</MenuItem>
      </Menu>
      <input ref={upload} type="file" hidden multiple aria-label="Upload photos or files" onChange={event => void uploadFiles(event.currentTarget.files)} />
      {uploading ? <span role="status" className="composer-upload-status">Uploading attachments…</span> : null}
      {error ? <div className="composer-attachment-error"><ErrorNotice message={error} /><button type="button" className="icon-button" aria-label="Dismiss attachment error" onClick={() => setError("")}><Icon icon={X} size={12} /></button></div> : null}
    </div>
    {picker ? <ReferencePicker kind={picker} projectId={projectId} attachments={attachments} disabled={disabled || full}
      onClose={() => setPicker(null)} onSelect={item => { append([item]); setPicker(null); }} /> : null}
  </>;
}

function ReferencePicker({ kind, projectId, attachments, disabled, onClose, onSelect }: {
  kind: "note" | "conversation";
  projectId: string;
  attachments: ComposerAttachment[];
  disabled?: boolean;
  onClose: () => void;
  onSelect: (attachment: ComposerAttachment) => void;
}) {
  const [query, setQuery] = useState("");
  const resource = useResource<List<ContentRecord | Conversation>>(`/enterprise/api/projects/${encodeURIComponent(projectId)}/${kind === "note" ? "workspace-content?kind=note" : "conversations"}`);
  const items = (resource.data?.items ?? []).filter(item => kind === "note" ? "kind" in item && item.kind === "note" : "harness" in item && !item.deletedAt);
  const detail = (item: ContentRecord | Conversation) => "body" in item ? item.body : agentName(item.harness);
  const search = query.trim().toLocaleLowerCase();
  const filtered = items.filter(item => `${item.title} ${detail(item)}`.toLocaleLowerCase().includes(search));
  return <Modal title={`Attach ${kind}`} onClose={onClose} compact>
    <SearchField label={`Search ${kind}s`} placeholder={`Search ${kind}s…`} value={query} onChange={setQuery} />
    <ErrorNotice message={resource.error} onRetry={resource.reload} />
    {resource.loading && !resource.data ? <Loading /> : null}
    <div className="attachment-reference-list" aria-label={`${kind === "note" ? "Notes" : "Conversations"} to attach`}>
      {filtered.map(item => {
        const attached = attachments.some(attachment => attachment.kind === kind && attachment.id === item.id);
        return <button key={item.id} type="button" className="attachment-reference-row" disabled={disabled || attached}
          aria-label={`Attach ${kind}: ${item.title}`} onClick={() => onSelect({ kind, id: item.id, title: item.title })}>
          <Icon icon={icons[kind]} size={16} /><span><strong>{item.title}</strong><small>{detail(item).replace(/\s+/g, " ").slice(0, 180)}</small></span>
          {attached ? <small>Attached</small> : null}
        </button>;
      })}
      {!resource.loading && !resource.error && !filtered.length ? <p className="muted">{query ? `No matching ${kind}s. Try a different search.` : `No ${kind}s yet. Create one in this workspace, then attach it here.`}</p> : null}
    </div>
    <div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button></div>
  </Modal>;
}
