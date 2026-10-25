import { randomUUID } from "node:crypto";
import { AppError, type AppContext, type User } from "../context.js";
import { requireFolder } from "../projects/workspaces.js";
import { authorizeFile } from "../files/access.js";
import { schema } from "./schema.js";
import { withContentLock } from "./locks.js";
import { initializeLibrary, captureSavedLibraryFile } from "./library-storage.js";

export type ContentKind = "note" | "artifact" | "event" | "task" | "library";
export interface ContentRow {
  id: string; project_id: string; kind: ContentKind; title: string; body: string;
  folder_id: string | null; data: string; revision: number; created_by: string;
  updated_by: string; created_at: string; updated_at: string; deleted_at: string | null;
}
const kinds = new Set(["note", "artifact", "event", "task", "library"]);
// Evaluate current authority inside each mutation's SQLite transaction.
const writeAuthority = `EXISTS(SELECT 1 FROM users u JOIN projects p ON p.id=?
 WHERE u.id=? AND u.enabled=1 AND p.status NOT IN ('deleted','deleting','purged')
 AND (u.role='owner' OR EXISTS(SELECT 1 FROM organization_memberships o
 WHERE o.org_id=p.org_id AND o.user_id=u.id AND (o.role='admin' OR EXISTS(
 SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=u.id)))))`;
export const contentView = (r: ContentRow) => ({
  id: r.id, projectId: r.project_id, kind: r.kind, title: r.title, body: r.body,
  folderId: r.folder_id, data: JSON.parse(r.data), revision: r.revision,
  createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at,
});
const invalid = (message: string) => new AppError(400, "invalid_content", message);
export const conflict = () => new AppError(409, "revision_conflict", "This item changed. Reload it before saving your edits.");
function text(value: unknown, max: number, required = false) {
  if (typeof value !== "string" || value.length > max || value.includes("\0") || (required && !value.trim()))
    throw invalid(`Enter ${required ? "nonempty " : ""}text up to ${max} characters.`);
  return value;
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("A JSON object is required.");
  return value as Record<string, any>;
}
function instant(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))
    throw invalid("Choose a valid date and time.");
  return new Date(value).toISOString();
}
function boolean(value: unknown, fallback: boolean) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw invalid("Use true or false.");
  return value;
}
export function calendarData(kind: "event" | "task", input: Record<string, any>) {
  const startsAt = instant(input.startsAt), endsAt = input.endsAt ? instant(input.endsAt) : null;
  if (endsAt && endsAt <= startsAt) throw invalid("The end must follow the start.");
  const timeZone = text(input.timeZone ?? "UTC", 128, true);
  try { new Intl.DateTimeFormat("en", { timeZone }).format(); } catch { throw invalid("Choose a valid time zone."); }
  let recurrence = null;
  if (input.recurrence != null) {
    const r = object(input.recurrence);
    if (!["day", "week", "month"].includes(r.unit) || !Number.isInteger(r.interval) || r.interval < 1 || r.interval > 365)
      throw invalid("Repeat every 1–365 days, weeks or months.");
    recurrence = { unit: r.unit, interval: r.interval };
  }
  const allDay = boolean(input.allDay, false);
  if (kind === "task" && allDay) throw invalid("Choose a time for a scheduled task.");
  const color = input.color ?? "#004225";
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) throw invalid("Choose a calendar color.");
  const result: Record<string, any> = { startsAt, endsAt, timeZone, recurrence, allDay, color };
  if (kind === "task") {
    const harness = input.harness ?? "pi";
    if (!["pi", "codex", "claude_code", "grok_build", "opencode"].includes(harness)) throw invalid("Choose an available agent.");
    const sessionMode = input.sessionMode ?? "same";
    if (!["same", "new"].includes(sessionMode)) throw invalid("Choose same or new session.");
    Object.assign(result, { prompt: text(input.prompt, 65536, true), harness,
      model: text(input.model ?? "", 200), sessionMode,
      enabled: boolean(input.enabled, true), showsOnCalendar: boolean(input.showsOnCalendar, true) });
  }
  return result;
}

export class WorkspaceContent {
  onTaskChanged?: (user: User, id: string) => Promise<void>;
  constructor(readonly ctx: AppContext) {}
  async initialize() { await this.ctx.db.migrate("workspace-content-v1", schema); await initializeLibrary(this.ctx); }
  async require(user: User, projectId: string, id: string) {
    await this.ctx.requireProject(user, projectId);
    const row = await this.ctx.db.get<ContentRow>("SELECT * FROM workspace_content WHERE id=? AND project_id=? AND deleted_at IS NULL", [id, projectId]);
    if (!row) throw new AppError(404, "not_found", "Workspace item not found.");
    return row;
  }
  async list(user: User, projectId: string, kind?: string) {
    await this.ctx.requireProject(user, projectId);
    if (kind && !kinds.has(kind)) throw invalid("Choose a workspace item type.");
    const rows = await this.ctx.db.all<ContentRow>(`SELECT * FROM workspace_content WHERE project_id=? AND deleted_at IS NULL${kind ? " AND kind=?" : ""} ORDER BY updated_at DESC,id LIMIT 1000`, kind ? [projectId, kind] : [projectId]);
    return { items: rows.map(contentView) };
  }
  private async values(user: User, projectId: string, input: Record<string, any>, prior?: ContentRow) {
    const kind = prior?.kind ?? input.kind;
    if (!kinds.has(kind)) throw invalid("Choose a workspace item type.");
    if (prior && input.kind !== undefined && input.kind !== prior.kind) throw invalid("The item type cannot change.");
    const title = text(input.title ?? prior?.title, 4096, true).trim();
    const body = text(input.body ?? prior?.body ?? "", 1_000_000);
    const folderId = input.folderId === undefined ? prior?.folder_id ?? null : input.folderId;
    if (folderId !== null) await requireFolder(this.ctx, projectId, folderId);
    let data = object(input.data ?? (prior ? JSON.parse(prior.data) : {}));
    if (JSON.stringify(data).length > 65536) throw invalid("Item metadata is too large.");
    if (kind === "task" || kind === "event") data = calendarData(kind, data);
    else if (kind === "library") {
      const type = data.type ?? "link";
      if (!["link", "file", "photo"].includes(type)) throw invalid("Choose link, file or photo.");
      if (type === "link") {
        let url: URL;
        try { url = new URL(data.url); } catch { throw invalid("Enter an HTTP or HTTPS link."); }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw invalid("Enter an HTTP or HTTPS link without credentials.");
        data = { type, url: url.href };
      } else {
        const fileId = text(data.fileId, 128, true);
        const retained = prior && JSON.parse(prior.data).fileId === fileId && await this.ctx.db.get(
          "SELECT 1 FROM workspace_library_items WHERE content_id=? AND project_id=? AND file_id=? AND storage='retained'", [prior.id, projectId, fileId]);
        if (!retained) {
          const file = await authorizeFile(this.ctx, user, fileId, projectId);
          // An org source retains its independent policy. It must never become a
          // workspace-wide permanent grant through a catalog reference.
          if (file.row.project_id !== projectId) throw invalid("Save a file from this workspace. Organization Files retain their source permissions.");
        }
        data = { type, fileId };
      }
    } else {
      const format = data.format ?? "markdown";
      if (!["markdown", "text", "html", "csv"].includes(format)) throw invalid("Choose a supported document format.");
      data = { format };
    }
    return { kind: kind as ContentKind, title, body, folderId, data };
  }
  async create(user: User, projectId: string, input: Record<string, any>) {
    const project = await this.ctx.requireProject(user, projectId, "write");
    const v = await this.values(user, projectId, input), id = randomUUID(), at = new Date().toISOString();
    await this.ctx.db.batch([
      { sql: `INSERT INTO workspace_content(id,project_id,kind,title,body,folder_id,data,created_by,updated_by,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${writeAuthority}`, params: [id, projectId, v.kind, v.title, v.body, v.folderId, JSON.stringify(v.data), user.id, user.id, at, at, projectId, user.id], expectChanges: 1 },
      this.versionStatement(id),
      ...(v.kind === "task" ? [{ sql: "INSERT INTO workspace_task_state(content_id,next_at) VALUES(?,?)", params: [id, v.data.enabled ? v.data.startsAt : null] }] : []),
    ]).catch(async error => { await this.ctx.requireProject(user, projectId, "write"); throw error; });
    if (v.kind === "library") await captureSavedLibraryFile(this.ctx, user, projectId, id, v.title, v.data as any);
    await this.ctx.audit(user, project.orgId, "workspace_content.created", id, { kind: v.kind });
    return contentView(await this.require(user, projectId, id));
  }
  private versionStatement(id: string) {
    return { sql: "INSERT INTO workspace_content_versions(content_id,revision,title,body,folder_id,data,updated_by,updated_at) SELECT id,revision,title,body,folder_id,data,updated_by,updated_at FROM workspace_content WHERE id=?", params: [id] };
  }
  update(user: User, projectId: string, id: string, input: Record<string, any>) {
    return withContentLock(this.ctx, id, () => this.updateLocked(user, projectId, id, input));
  }
  private async updateLocked(user: User, projectId: string, id: string, input: Record<string, any>) {
    const row = await this.require(user, projectId, id);
    if (input.expectedRevision !== row.revision) throw conflict();
    const v = await this.values(user, projectId, input, row), at = new Date().toISOString();
    try {
      await this.ctx.db.batch([
        { sql: `UPDATE workspace_content SET title=?,body=?,folder_id=?,data=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL AND ${writeAuthority}`, params: [v.title, v.body, v.folderId, JSON.stringify(v.data), user.id, at, id, row.revision, projectId, user.id], expectChanges: 1 },
        this.versionStatement(id),
        ...(v.kind === "task" && JSON.stringify(v.data) !== row.data ? [{ sql: "UPDATE workspace_task_state SET next_at=?,conversation_id=NULL,last_status=NULL,last_error=NULL WHERE content_id=?", params: [v.data.enabled ? v.data.startsAt : null, id] }] : []),
      ]);
    } catch (error) { await this.ctx.requireProject(user, projectId, "write"); if ((error as Error).message === "Concurrent update conflict") throw conflict(); throw error; }
    if (v.kind === "library") await captureSavedLibraryFile(this.ctx, user, projectId, id, v.title, v.data as any);
    if (row.kind === "task") await this.onTaskChanged?.(user, id);
    return contentView(await this.require(user, projectId, id));
  }
  remove(user: User, projectId: string, id: string, revision: number) {
    return withContentLock(this.ctx, id, () => this.removeLocked(user, projectId, id, revision));
  }
  private async removeLocked(user: User, projectId: string, id: string, revision: number) {
    const row = await this.require(user, projectId, id);
    if (row.revision !== revision) throw conflict();
    const result = await this.ctx.db.run(`UPDATE workspace_content SET deleted_at=?,revision=revision+1,updated_by=? WHERE id=? AND revision=? AND deleted_at IS NULL AND ${writeAuthority}`, [new Date().toISOString(), user.id, id, revision, projectId, user.id]);
    if (!result.changes) { await this.ctx.requireProject(user, projectId, "write"); throw conflict(); }
    if (row.kind === "task") await this.onTaskChanged?.(user, id);
    return { ok: true };
  }
  async versions(user: User, projectId: string, id: string) {
    await this.require(user, projectId, id);
    return { items: (await this.ctx.db.all<any>("SELECT * FROM workspace_content_versions WHERE content_id=? ORDER BY revision DESC LIMIT 200", [id])).map(r => ({ revision: r.revision, title: r.title, body: r.body, folderId: r.folder_id, data: JSON.parse(r.data), updatedBy: r.updated_by, updatedAt: r.updated_at })) };
  }
  async restore(user: User, projectId: string, id: string, input: Record<string, any>) {
    await this.require(user, projectId, id);
    const version = await this.ctx.db.get<any>("SELECT * FROM workspace_content_versions WHERE content_id=? AND revision=?", [id, Number(input.revision)]);
    if (!version) throw new AppError(404, "not_found", "Version not found.");
    return this.update(user, projectId, id, { expectedRevision: input.expectedRevision, title: version.title, body: version.body, folderId: version.folder_id, data: JSON.parse(version.data) });
  }
}
