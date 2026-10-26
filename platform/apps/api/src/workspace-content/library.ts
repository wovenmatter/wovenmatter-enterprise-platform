import type { AppContext, User } from "../context.js";
import { captureLibraryMessage, captureSavedLibraryFile } from "./library-storage.js";
export { discoverLibraryAssets, libraryFilePath } from "./library-parser.js";
import { WorkspaceContent } from "./service.js";

// WorkspaceLibrary.swift: explicit shared links are handbacks; code blocks,
// internal tool records and arbitrary prose filesystem paths are not.
export function sharedLinks(content: string) {
  const source = content.slice(0, 1_000_000).replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
  const links: { url: string; title: string }[] = [], seen = new Set<string>();
  const pattern = /!?\[([^\]]{0,500})\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^\s>]+)>/g;
  for (const m of source.matchAll(pattern)) {
    const raw = m[2] ?? m[3]!;
    if (links.length >= 200) break;
    if (raw.length > 8192) continue;
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
      seen.add(url.href); links.push({ url: url.href, title: m[1] || url.hostname });
    } catch { /* malformed link, not a handback */ }
  }
  return links;
}
export async function workspaceLibrary(ctx: AppContext, user: User, projectId: string) {
  await ctx.requireProject(user, projectId);
  const content = new WorkspaceContent(ctx), saved = await content.list(user, projectId, "library");
  // Recover accepted messages after process interruption and backfill existing chats.
  // Active assistant output is captured by finalization, never from a partial stream.
  const messages = await ctx.db.all<any>(`SELECT m.id FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id
    WHERE c.project_id=? AND c.deleted_at IS NULL AND c.asset_id IS NULL
    AND (m.role='user' AND COALESCE((SELECT i.delivery FROM conversation_inputs i WHERE i.message_id=m.id),'accepted')='accepted' OR m.role='assistant' AND NOT EXISTS(
      SELECT 1 FROM conversation_runs r WHERE r.assistant_message_id=m.id AND r.status IN ('queued','dispatching','running','cancelling')))
    ORDER BY m.created_at DESC LIMIT 1000`, [projectId]);
  for (const message of messages) await captureLibraryMessage(ctx, user, projectId, message.id);
  for (const item of saved.items) if (item.data.fileId) await captureSavedLibraryFile(ctx, user, projectId, item.id, item.title, item.data);
  const rows = await ctx.db.all<any>(`SELECT i.*,m.role,m.author_id,m.created_at AS sent_at,m.conversation_id,c.title AS conversation_title,c.harness
    FROM workspace_library_items i LEFT JOIN conversation_messages m ON m.id=i.message_id LEFT JOIN conversations c ON c.id=m.conversation_id
    WHERE i.project_id=? AND (i.content_id IS NOT NULL OR c.deleted_at IS NULL)`, [projectId]);
  const byContent = new Map(rows.filter(r => r.content_id).map(r => [r.content_id, r]));
  const retention = (row: any) => ({ source: row.source, storage: row.storage,
    retentionStatus: row.storage === 'link' ? null : row.storage,
    retentionError: row.error, sizeBytes: row.size_bytes, contentHash: row.hash,
    versionId: row.version_id, fileId: row.file_id,
    downloadUrl: row.storage === 'retained' ? `/enterprise/api/projects/${encodeURIComponent(projectId)}/workspace-library/${encodeURIComponent(row.id)}/download` : null });
  const items: Record<string, unknown>[] = saved.items.map(item => ({ ...item,
    ...(byContent.has(item.id) ? retention(byContent.get(item.id)) : { storage: item.data.type === 'link' ? 'link' : 'unavailable' }),
    type: item.data.type, url: item.data.url ?? null, sender: 'member', sentAt: item.createdAt,
    conversationId: null, saved: true }));
  for (const row of rows.filter(r => r.message_id)) items.push({ id: row.id, title: row.title, type: row.kind,
    ...retention(row), url: row.storage === 'link' ? row.source : null,
    sender: row.role === 'assistant' ? 'agent' : 'member', createdBy: row.author_id,
    harness: row.harness, conversationId: row.conversation_id, conversationTitle: row.conversation_title,
    messageId: row.message_id, sentAt: row.sent_at, saved: false });
  for (const a of (await content.list(user, projectId, 'artifact')).items)
    items.push({ ...a, type: 'artifact', sender: 'member', sentAt: a.createdAt, storage: 'saved', saved: true });
  await ctx.requireProject(user, projectId);
  return { items: items.sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt))).slice(0, 1000) };
}

export async function workspaceUsage(ctx: AppContext, user: User, projectId: string, filters: Record<string,unknown> = {}) {
  await ctx.requireProject(user, projectId);
  const where=["r.project_id=?"],parameters: string[]=[projectId];
  for (const [key,column] of [["since","r.created_at>="],["until","r.created_at<="],["harness","r.harness="],["model","r.model="]]) {
    const value=filters[key!];
    if (typeof value==="string" && value && value.length<=240) {where.push(column+"?");parameters.push(value);}
  }
  const rows = await ctx.db.all<any>("SELECT r.harness,r.model,COUNT(*) runs,SUM(r.status='completed') completed,SUM(r.status IN ('failed','interrupted')) failed,"+
    "SUM(u.totalTokens) totalTokens,SUM(u.inputTokens) inputTokens,SUM(u.outputTokens) outputTokens,SUM(u.cost) cost,SUM(COALESCE(u.measured,0)>0) measuredRuns "+
    "FROM conversation_runs r LEFT JOIN (SELECT run_id,SUM(json_extract(data,'$.totalTokens')) totalTokens,SUM(json_extract(data,'$.input')) inputTokens,"+
    "SUM(json_extract(data,'$.output')) outputTokens,SUM(json_extract(data,'$.cost')) cost,COUNT(*) measured "+
    "FROM conversation_events WHERE type='native.usage' GROUP BY run_id) u ON u.run_id=r.id WHERE "+where.join(" AND ")+" GROUP BY r.harness,r.model ORDER BY COUNT(*) DESC",parameters);
  return {items:rows,totals:rows.reduce((a,b)=>({runs:a.runs+b.runs,completed:a.completed+b.completed,failed:a.failed+b.failed}),{runs:0,completed:0,failed:0})};
}
