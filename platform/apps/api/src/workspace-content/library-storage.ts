import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { AppError, type AppContext, type User } from "../context.js";
import { authorizeFile } from "../files/access.js";
import { cleanPath, readBytes, scopeRoot, withLeaf } from "../files/paths.js";
import { withContentLock } from "./locks.js";
import { withProjectLifecycle } from "../projects/trash.js";
import { restoreLibraryNativeRecord } from "./library-native.js";
import { discoverLibraryAssets, libraryFilePath, libraryKind, type LibraryAsset } from "./library-parser.js";

export const librarySchema = `
CREATE TABLE workspace_library_items (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 message_id TEXT REFERENCES conversation_messages(id), content_id TEXT REFERENCES workspace_content(id),
 source TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
 file_id TEXT, version_id TEXT, hash TEXT, size_bytes INTEGER,
 storage TEXT NOT NULL CHECK(storage IN ('link','pending','retained','unavailable')),
 error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX workspace_library_scope ON workspace_library_items(project_id,message_id,content_id);
CREATE TABLE workspace_library_messages (
 message_id TEXT PRIMARY KEY REFERENCES conversation_messages(id), project_id TEXT NOT NULL REFERENCES projects(id), digest TEXT NOT NULL
);
CREATE TABLE workspace_library_blobs (
 project_id TEXT NOT NULL REFERENCES projects(id), hash TEXT NOT NULL, size_bytes INTEGER NOT NULL,
 PRIMARY KEY(project_id,hash)
);
`;
export interface LibraryRow {
 id: string; project_id: string; message_id: string | null; content_id: string | null;
 source: string; title: string; kind: "link" | "file" | "photo";
 file_id: string | null; version_id: string | null; hash: string | null; size_bytes: number | null;
 storage: "link" | "pending" | "retained" | "unavailable"; error: string | null; created_at: string;
}
const authority = `EXISTS(SELECT 1 FROM users u JOIN projects p ON p.id=?
 WHERE u.id=? AND u.enabled=1 AND p.status NOT IN ('deleted','deleting','purged')
 AND (u.role='owner' OR EXISTS(SELECT 1 FROM organization_memberships o
 WHERE o.org_id=p.org_id AND o.user_id=u.id AND (o.role='admin' OR EXISTS(
 SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=u.id)))))`;
export const libraryLimit = (ctx: AppContext) => Math.min(25 * 1024 ** 2, Number(ctx.config.maxFileBytes ?? 25 * 1024 ** 2));
const quota = (ctx: AppContext) => Math.max(0, Number(ctx.config.libraryQuotaBytes ?? ctx.config.storageQuotaBytes ?? 1024 ** 3));
function failure(error: unknown) {
 const code = (error as { code?: string }).code;
 return code === "file_too_large" ? "This file exceeds the Library file size limit."
  : code === "library_quota" ? "This workspace has reached its Library storage allowance."
  : code === "ENOENT" ? "The shared file is no longer available."
  : "The shared file could not be retained from this workspace.";
}
export async function initializeLibrary(ctx: AppContext) {
 await ctx.db.migrate("workspace-library-v1", librarySchema);
 await fs.mkdir(join(ctx.config.stateDir, "workspace-library"), { recursive: true, mode: 0o700 });
}
function storageRoot(ctx: AppContext, projectId: string) {
 if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error("invalid_scope");
 return join(ctx.config.stateDir, "workspace-library", projectId);
}
async function retainBytes(ctx: AppContext, user: User, projectId: string, bytes: Buffer) {
 if (bytes.length > libraryLimit(ctx)) throw new AppError(413, "file_too_large", "Library file size limit exceeded.");
 const hash = createHash("sha256").update(bytes).digest("hex");
 const existing = await ctx.db.get("SELECT 1 FROM workspace_library_blobs WHERE project_id=? AND hash=?", [projectId, hash]);
 if (!existing) {
  const used = await ctx.db.get<{ bytes: number }>("SELECT COALESCE(SUM(size_bytes),0) bytes FROM workspace_library_blobs WHERE project_id=?", [projectId]);
  if (Number(used?.bytes ?? 0) + bytes.length > quota(ctx)) throw new AppError(413, "library_quota", "Library storage allowance exceeded.");
 }
 await ctx.requireProject(user, projectId);
 // Serialize publication with permanent deletion. Admission before this lane is
 // not authority to recreate a workspace after a queued purge has completed.
 return withProjectLifecycle(ctx, projectId, async () => {
 await ctx.requireProject(user, projectId);
 const root = storageRoot(ctx, projectId);
 await withLeaf(join(ctx.config.stateDir, "workspace-library"), projectId, async leaf => {
  try { await fs.mkdir(leaf, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const stat = await fs.lstat(leaf);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid_storage");
 });
 // Immutable hash-addressed bytes live outside the runtime mounts. Publish only a
 // complete fsynced object; every parent and leaf is opened without following links.
 const temporary = `pending-${randomUUID()}`;
 await withLeaf(root, temporary, async leaf => {
  const handle = await fs.open(leaf, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
 });
 try {
  await withLeaf(root, temporary, async source => withLeaf(root, hash, async target => {
   try { await fs.link(source, target); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }));
 } finally { await withLeaf(root, temporary, leaf => fs.unlink(leaf)); }
 const retained = await readBytes(root, hash, libraryLimit(ctx));
 if (createHash("sha256").update(retained).digest("hex") !== hash) throw new Error("invalid_storage");
 const result = await ctx.db.run(`INSERT OR IGNORE INTO workspace_library_blobs(project_id,hash,size_bytes) SELECT ?,?,? WHERE ${authority}`, [projectId, hash, bytes.length, projectId, user.id]);
 if (!result.changes && !existing) {
  await withLeaf(root, hash, leaf => fs.unlink(leaf));
  await ctx.requireProject(user, projectId);
  throw new Error("retention_interrupted");
 }
 return { hash, size: bytes.length };
 });
}
async function fileBytes(ctx: AppContext, user: User, projectId: string, fileId: string, versionId?: string | null) {
 const auth = await authorizeFile(ctx, user, fileId, projectId, false, !!versionId);
 if (auth.row.project_id !== projectId || auth.row.kind !== "file") throw new Error("invalid_source");
 const version = await ctx.db.get<{ id: string; hash: string; size: number }>("SELECT id,hash,size FROM workspace_file_versions WHERE id=? AND file_id=?", [versionId ?? auth.row.version_id, fileId]);
 if (!version || !/^[a-f0-9]{64}$/.test(version.hash)) throw new Error("invalid_source");
 if (version.size > libraryLimit(ctx)) throw new AppError(413, "file_too_large", "Library file size limit exceeded.");
 const bytes = await readBytes(join(ctx.config.stateDir, "file-versions"), version.hash, libraryLimit(ctx));
 await ctx.requireProject(user, projectId);
 return { bytes, versionId: version.id };
}
async function handbackBytes(ctx: AppContext, user: User, projectId: string, source: string, messageId: string) {
 const project = await ctx.requireProject(user, projectId);
 const conversation = await ctx.db.get<{ working_directory: string | null; directory_device: string | null; directory_inode: string | null }>(`SELECT c.working_directory,c.directory_device,c.directory_inode FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.project_id=? AND c.deleted_at IS NULL AND c.asset_id IS NULL`, [messageId, projectId]);
 if (!conversation) throw new Error("invalid_source");
 let path = libraryFilePath(source);
 if (path.startsWith("/")) {
  if (!path.startsWith("/workspace/")) throw new Error("invalid_source");
  path = path.slice("/workspace/".length);
 } else {
  if (!conversation.working_directory) throw new Error("invalid_source");
  path = `${conversation.working_directory}/${path.replace(/^\.\//, "")}`;
 }
 cleanPath(path, false);
 // Organization shares remain independently authorized; do not turn their bytes
 // into a permanent workspace grant, including names beneath native mount aliases.
 const shares = await ctx.db.all<{ name: string }>("SELECT name FROM workspace_file_shares WHERE project_id=?", [projectId]);
 if (shares.some(s => path === s.name || path.startsWith(s.name + "/"))) throw new Error("invalid_source");
 if (path.split("/").some(p => /^(?:\.wme-|\.ssh$|\.aws$|\.codex$|\.claude$|\.env(?:\.|$)|session$|control$)/i.test(p))) throw new Error("invalid_source");
 const root = scopeRoot(ctx, { orgId: project.orgId, projectId });
 if (conversation.working_directory && path.startsWith(conversation.working_directory + "/")) {
  await withLeaf(root, conversation.working_directory, async leaf => {
   const stat = await fs.lstat(leaf, { bigint: true });
   if (!stat.isDirectory() || stat.isSymbolicLink() || (conversation.directory_device && (String(stat.dev) !== conversation.directory_device || String(stat.ino) !== conversation.directory_inode))) throw new Error("invalid_source");
  });
 }
 const bytes = await readBytes(root, path, libraryLimit(ctx));
 await ctx.requireProject(user, projectId);
 return bytes;
}
async function captureRow(ctx: AppContext, user: User, row: LibraryRow, embedded?: Buffer) {
 if (row.storage === "retained" || row.storage === "link") return;
 try {
  let bytes: Buffer, versionId = row.version_id;
  if (embedded) {
   if (!row.source.startsWith("embedded:") && !/^https?:/i.test(row.source)) {
    if (!row.message_id) throw new Error("invalid_source");
    await handbackBytes(ctx, user, row.project_id, row.source, row.message_id);
   }
   bytes = embedded;
  }
  else if (row.file_id) { const file = await fileBytes(ctx, user, row.project_id, row.file_id, versionId); bytes = file.bytes; versionId = file.versionId; }
  else if (row.message_id) bytes = await handbackBytes(ctx, user, row.project_id, row.source, row.message_id);
  else throw new Error("invalid_source");
  const retained = await retainBytes(ctx, user, row.project_id, bytes);
  await ctx.db.run(`UPDATE workspace_library_items SET hash=?,size_bytes=?,version_id=?,storage='retained',error=NULL WHERE id=? AND ${authority}`, [retained.hash, retained.size, versionId, row.id, row.project_id, user.id]);
 } catch (error) {
  await ctx.db.run(`UPDATE workspace_library_items SET storage='unavailable',error=? WHERE id=? AND storage!='retained' AND ${authority}`, [failure(error), row.id, row.project_id, user.id]);
 }
}
async function insertAsset(ctx: AppContext, user: User, projectId: string, asset: LibraryAsset, options: { messageId?: string; contentId?: string; fileId?: string; versionId?: string; id?: string; bytes?: Buffer }) {
 const id = options.id ?? createHash("sha256").update(`${options.messageId}\0${asset.source}`).digest("hex");
 const storage = !options.bytes && /^https?:/i.test(asset.source) ? "link" : "pending";
 await ctx.db.run(`INSERT OR IGNORE INTO workspace_library_items(id,project_id,message_id,content_id,source,title,kind,file_id,version_id,storage,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${authority}`, [id, projectId, options.messageId ?? null, options.contentId ?? null, asset.source, asset.title, asset.type, options.fileId ?? null, options.versionId ?? null, storage, new Date().toISOString(), projectId, user.id]);
 const row = await ctx.db.get<LibraryRow>("SELECT * FROM workspace_library_items WHERE id=? AND project_id=?", [id, projectId]);
 if (row) {
  if (options.bytes && row.storage === "link") {
   await ctx.db.run(`UPDATE workspace_library_items SET storage='pending' WHERE id=? AND ${authority}`, [id, projectId, user.id]);
   row.storage = "pending";
  }
  await captureRow(ctx, user, row, options.bytes);
 }
}
export async function captureLibraryMessage(ctx: AppContext, user: User, projectId: string, messageId: string) {
 return withContentLock(ctx, `library:${projectId}`, async () => {
  await ctx.requireProject(user, projectId);
  const message = await ctx.db.get<{ content: string; citations: string; attachments: string }>(`SELECT m.content,m.citations,m.attachments FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.project_id=? AND c.deleted_at IS NULL AND c.asset_id IS NULL`, [messageId, projectId]);
  if (!message) return;
  const latest = await ctx.db.get<{ordinal: number | null}>(`SELECT MAX(n.ordinal) ordinal FROM conversation_native_records n JOIN conversation_runs r ON r.id=n.run_id WHERE r.assistant_message_id=?`, [messageId]);
  const digest = createHash("sha256").update(message.content + message.citations + message.attachments + String(latest?.ordinal ?? 0)).digest("hex");
  if (await ctx.db.get("SELECT 1 FROM workspace_library_messages WHERE message_id=? AND digest=?", [messageId, digest])) return;
  // Chunk bytes are read sequentially by the authenticated manifest decoder;
  // loading a page of base64 chunk payloads here would multiply peak memory.
  const archive = await ctx.db.all<{payload: string; ordinal: number; source_id: string}>(`SELECT n.payload,n.ordinal,n.source_id FROM conversation_native_records n JOIN conversation_runs r ON r.id=n.run_id WHERE r.assistant_message_id=? AND n.kind!='native-file.chunk' ORDER BY n.ordinal DESC LIMIT 200`, [messageId]);
  for (const asset of discoverLibraryAssets(message.content)) await insertAsset(ctx, user, projectId, asset, { messageId });
  for (const attachment of JSON.parse(message.attachments ?? "[]")) {
    if (attachment.kind !== "file" || !attachment.versionId) continue;
    const auth = await authorizeFile(ctx, user, attachment.id, projectId, false, true);
    if (auth.row.project_id !== projectId) continue;
    await insertAsset(ctx, user, projectId, { source: `workspace-file:${attachment.id}/${attachment.versionId}`, title: attachment.title, type: libraryKind(attachment.title) }, { messageId, fileId: attachment.id, versionId: attachment.versionId });
  }
  const sources = new Map<string, unknown[]>();
  for (const record of archive) {
   try {
    const records = sources.get(record.source_id) ?? [];
    records.push(JSON.parse(record.payload)); sources.set(record.source_id, records);
   } catch { /* Malformed historical records do not authorize attachments. */ }
  }
  for (const [sourceID, records] of sources) await captureNativeBatchLocked(ctx, user, projectId, messageId, { sourceID, records });
  let citations: { fileId?: string; versionId?: string; label?: string }[] = [];
  try { const parsed = JSON.parse(message.citations); if (Array.isArray(parsed)) citations = parsed.slice(0, 200); } catch { /* Invalid historic citations cannot abort message acceptance. */ }
  for (const citation of citations) {
   if (typeof citation?.fileId !== "string") continue;
   try {
    const auth = await authorizeFile(ctx, user, citation.fileId, projectId, false, !!citation.versionId);
    if (auth.row.project_id !== projectId) continue;
    await insertAsset(ctx, user, projectId, { source: `workspace-file:${citation.fileId}`, title: citation.label || auth.row.path.split("/").at(-1)!, type: libraryKind(auth.row.path) }, { messageId, fileId: citation.fileId, versionId: citation.versionId });
   } catch { /* A citation never grants more authority than its source. */ }
  }
  await ctx.db.run(`INSERT INTO workspace_library_messages(message_id,project_id,digest) SELECT ?,?,? WHERE ${authority} ON CONFLICT(message_id) DO UPDATE SET digest=excluded.digest`, [messageId, projectId, digest, projectId, user.id]);
 });
}
export async function captureSavedLibraryFile(ctx: AppContext, user: User, projectId: string, contentId: string, title: string, data: { type: string; fileId?: string }) {
 return withContentLock(ctx, `library:${projectId}`, async () => {
  await ctx.requireProject(user, projectId);
  if (!data.fileId) {
   await ctx.db.run(`DELETE FROM workspace_library_items WHERE content_id=? AND project_id=? AND ${authority}`, [contentId, projectId, projectId, user.id]);
   return;
  }
  const old = await ctx.db.get<LibraryRow>("SELECT * FROM workspace_library_items WHERE id=? AND project_id=?", [contentId, projectId]);
  if (old && old.file_id === data.fileId && old.storage === "retained") {
   await ctx.db.run(`UPDATE workspace_library_items SET title=?,kind=? WHERE id=? AND ${authority}`, [title, data.type, contentId, projectId, user.id]);
   return;
  }
  if (old) await ctx.db.run(`DELETE FROM workspace_library_items WHERE id=? AND ${authority}`, [contentId, projectId, user.id]);
  await insertAsset(ctx, user, projectId, { source: `workspace-file:${data.fileId}`, title, type: data.type as "file" | "photo" }, { id: contentId, contentId, fileId: data.fileId });
 });
}
export async function downloadLibraryFile(ctx: AppContext, user: User, projectId: string, id: string) {
 await ctx.requireProject(user, projectId);
 const row = await ctx.db.get<LibraryRow>(`SELECT i.* FROM workspace_library_items i LEFT JOIN workspace_content w ON w.id=i.content_id LEFT JOIN conversation_messages m ON m.id=i.message_id LEFT JOIN conversations c ON c.id=m.conversation_id WHERE i.id=? AND i.project_id=? AND ((w.project_id=i.project_id AND w.deleted_at IS NULL) OR (c.project_id=i.project_id AND c.deleted_at IS NULL))`, [id, projectId]);
 if (!row || row.storage !== "retained" || !row.hash || !/^[a-f0-9]{64}$/.test(row.hash)) throw new AppError(404, "library_unavailable", "This Library file is unavailable.");
 let bytes: Buffer;
 try {
  bytes = await readBytes(storageRoot(ctx, projectId), row.hash, libraryLimit(ctx));
  if (createHash("sha256").update(bytes).digest("hex") !== row.hash) throw new Error("invalid_storage");
 } catch { throw new AppError(404, "library_unavailable", "This Library file is unavailable."); }
 await ctx.requireProject(user, projectId);
 return { bytes, name: row.title, hash: row.hash };
}
export async function retryLibraryFile(ctx: AppContext, user: User, projectId: string, id: string) {
 return withContentLock(ctx, `library:${projectId}`, async () => {
  await ctx.requireProject(user, projectId);
  const row = await ctx.db.get<LibraryRow>(`SELECT i.* FROM workspace_library_items i LEFT JOIN workspace_content w ON w.id=i.content_id LEFT JOIN conversation_messages m ON m.id=i.message_id LEFT JOIN conversations c ON c.id=m.conversation_id WHERE i.id=? AND i.project_id=? AND ((w.project_id=i.project_id AND w.deleted_at IS NULL) OR (c.project_id=i.project_id AND c.deleted_at IS NULL))`, [id, projectId]);
  if (!row) throw new AppError(404, "not_found", "Library item not found.");
  await captureRow(ctx, user, row);
  await ctx.requireProject(user, projectId);
  return { ok: true };
 });
}

/** Match only actual assistant message content blocks. Tool traces and private
 * native configuration records cannot supply Library attachments. */
export async function captureLibraryNativeBatch(ctx: AppContext, user: User, projectId: string, messageId: string, batch: Record<string, unknown>) {
 return withContentLock(ctx, `library:${projectId}`, () => captureNativeBatchLocked(ctx, user, projectId, messageId, batch));
}
async function captureNativeBatchLocked(ctx: AppContext, user: User, projectId: string, messageId: string, batch: Record<string, unknown>) {
  await ctx.requireProject(user, projectId);
  const message = await ctx.db.get<{run_id: string | null; harness: string}>("SELECT m.run_id,c.harness FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.role='assistant' AND c.project_id=? AND c.deleted_at IS NULL AND c.asset_id IS NULL", [messageId, projectId]);
  if (!message) return;
  for (const original of (Array.isArray(batch.records) ? batch.records : []).slice(0, 200)) {
   const record = await restoreLibraryNativeRecord(ctx, message.run_id ?? "", String(batch.sourceID ?? ""), original);
   if (!record) continue;
   if (record?.runID && record.runID !== message.run_id) continue;
   let payload: any = record?.payload ?? record;
   try { if (typeof payload === 'string' && payload.length <= 36 * 1024 ** 2) payload = JSON.parse(payload); } catch { continue; }
   let projection: any = {};
   try { if (record?.projectionJSON) projection = JSON.parse(record.projectionJSON); } catch { continue; }
   // A parent's archive also contains private child records. Only the root
   // assistant's delivered content belongs in its shared Library collection.
   if (!projection || projection.childID !== undefined || projection.parentNativeConversationID !== undefined || projection.parentNativeSessionID !== undefined) continue;
   const body = payload?.message ?? payload;
   // ACP presents assistant attachments as content chunks; OpenCode archives
   // delivered message parts. Neither tool output nor thought chunks qualify.
   const durableRoot = message.harness === 'pi' && record?.kind === 'pi.assistant'
    && payload?.type === 'entry' && payload.value?.kind === 'pi.assistant'
    && projection.nativeConversationID !== undefined && projection.nativeConversationID === payload.conversationId;
   const blocks = durableRoot && Array.isArray(payload.value.model)
    ? payload.value.model.slice(0, 200).flatMap((m: any) => m?.role === 'assistant' && Array.isArray(m.content) ? m.content : [])
    : payload?.sessionUpdate === 'agent_message_chunk'
    ? [payload.content]
    : body?.role === 'assistant' && (!payload?.type || ['message', 'message_end', 'assistant', 'assistant_message'].includes(payload.type))
      ? Array.isArray(body.content) ? body.content : Array.isArray(body.parts) ? body.parts : []
      : [];
   for (const block of blocks.slice(0, 200)) {
    if (!block || !['image','audio','video','file'].includes(block.type)) continue;
    let source = typeof block.url === 'string' ? block.url : typeof block.path === 'string' ? block.path : typeof block.source?.url === 'string' ? block.source.url : '';
    let encoded = typeof block.data === 'string' ? block.data : typeof block.source?.data === 'string' ? block.source.data : undefined;
    if (source.startsWith('data:')) {
      const match = /^data:[^,]*;base64,(.*)$/.exec(source); if (!match) continue;
      encoded = match[1]; source = '';
    }
    const title = String(block.fileName || block.filename || block.alt || source.split('/').at(-1) || 'Attachment').slice(0,512);
    let bytes: Buffer | undefined;
    if (encoded !== undefined && encoded.length <= Math.ceil(libraryLimit(ctx) * 4 / 3) + 8 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
     const decoded = Buffer.from(encoded, 'base64');
     if (decoded.toString('base64') === encoded) bytes = decoded;
    }
    if (encoded !== undefined && !bytes) {
      const hash = createHash('sha256').update(encoded).digest('hex');
      await insertAsset(ctx, user, projectId, { source: `embedded:${hash}`, title, type: block.type === 'image' ? 'photo' : 'file' }, { messageId });
      continue;
    }
    if (bytes && !source) source = `embedded:${createHash('sha256').update(bytes).digest('hex')}`;
    if (!source || ((!bytes || /^https?:/i.test(source)) && !discoverLibraryAssets(`[Attachment](<${source}>)`).length)) continue;
    await insertAsset(ctx, user, projectId, { source, title, type: block.type === 'image' || String(block.mimeType || block.mime || block.source?.media_type || '').startsWith('image/') ? 'photo' : libraryKind(source) }, { messageId, bytes });
   }
  }
}
