import type { FastifyInstance } from "fastify";
import { AppError, type AppContext, type User } from "../context.js";
import { hasConversationAttachment } from "./attachments.js";

// WovenMatter f885d281: WorkspaceToolGroup, WorkspaceDatabase+AgentTools,
// and WovenMatterToolProtocol (managed databases belong to Notes).
export const conversationToolGroups = [
  { id: "notes", label: "Notes", description: "Workspace notes, artifacts and managed databases" },
  { id: "history", label: "Conversation history", description: "Read conversations in this workspace" },
  { id: "sessions", label: "Sessions", description: "Coordinate chats in this workspace with explicit access grants" },
  { id: "timers", label: "Timers", description: "Scheduled instructions for this chat" },
  { id: "browser", label: "Browser", description: "The isolated browser in this workspace" },
  { id: "executor", label: "Connected apps", description: "Only selected organization app profiles" },
  { id: "usage", label: "Usage data", description: "Read only" },
  { id: "calendar", label: "Calendar", description: "Workspace events and scheduled tasks" },
  { id: "library", label: "Library", description: "Workspace library items" },
] as const;
export type ConversationToolGroup = typeof conversationToolGroups[number]["id"];
export type ConversationTools = Record<ConversationToolGroup, boolean>;
const invalid = () => new AppError(400, "invalid_tools", "Choose supported tool groups using true or false.");

export function normalizeConversationTools(value: unknown = {}): ConversationTools {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  if (Object.entries(input).some(([key, enabled]) => !conversationToolGroups.some(group => group.id === key) || typeof enabled !== "boolean")) throw invalid();
  return Object.fromEntries(conversationToolGroups.map(group => [group.id, input[group.id] ?? (group.id!=="executor")])) as ConversationTools;
}
export const serializeConversationTools = (value?: unknown) => JSON.stringify(normalizeConversationTools(value));
export function readConversationTools(value?: string): ConversationTools {
  return normalizeConversationTools(value ? JSON.parse(value) : {});
}
export function toolPrompt(value?: string) {
  const settings = readConversationTools(value);
  return "\n\nWorkspace tool settings for this conversation: " + conversationToolGroups.map(group => `${group.label}: ${settings[group.id] ? "enabled" : "disabled"}`).join("; ") + ". " +
    "Use typed Woven MCP tools for authorized workspace operations. wme-workspace remains a compatibility fallback. Notes also controls artifacts and managed databases; Calendar controls events and scheduled tasks. " +
    'For conversation history, use woven_history_list, or woven_history_read with {"id":"CONVERSATION_ID","after":0,"limit":50}. ' +
    'Each result includes bounded message content. When nextOffset is present, read that exact message with woven_history_read using {"id":"CONVERSATION_ID","messageId":"MESSAGE_ID","offset":NEXT_OFFSET,"characters":16000}; continue until nextOffset is null. ' +
    "Explicitly attached notes and conversations grant only scoped reads while their groups are disabled. They do not grant edits or broader discovery. " +
    "The broker checks current membership and tool settings on every operation; a later user change may disable a group. These switches do not change workspace filesystem access.";
}
export async function migrateConversationTools(ctx: AppContext) {
  await ctx.db.migrate("conversation-tool-settings-v1", "ALTER TABLE conversations ADD COLUMN tool_settings TEXT NOT NULL DEFAULT '{}';");
}

const lanes = new WeakMap<AppContext, Map<string, Promise<unknown>>>();
/** A completed disable fences later broker calls; an in-flight write finishes first. */
export async function withConversationTools<T>(ctx: AppContext, id: string, action: () => Promise<T>): Promise<T> {
  let pending = lanes.get(ctx);
  if (!pending) { pending = new Map(); lanes.set(ctx, pending); }
  const prior = pending.get(id) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(action);
  pending.set(id, next);
  try { return await next; } finally { if (pending.get(id) === next) pending.delete(id); }
}

async function requireToolConversation(ctx: AppContext, user: User, id: string) {
  const row = await ctx.db.get<{ project_id: string | null; asset_id: string | null; tool_settings: string }>(
    "SELECT project_id,asset_id,tool_settings FROM conversations WHERE id=? AND deleted_at IS NULL", [id],
  );
  if (!row || !row.project_id || row.asset_id) throw new AppError(404, "not_found", "Workspace conversation not found.");
  await ctx.requireProject(user, row.project_id);
  return row;
}
const view = (settings: ConversationTools) => ({ settings, groups: conversationToolGroups.map(group => ({ ...group, enabled: settings[group.id] })) });
export async function registerConversationTools(app: FastifyInstance, ctx: AppContext) {
  const base = "/enterprise/api/conversations/:conversationId/tools";
  app.get(base, async request => {
    const user = await ctx.requireUser(request), id = (request.params as { conversationId: string }).conversationId;
    return view(readConversationTools((await requireToolConversation(ctx, user, id)).tool_settings));
  });
  // Agent capabilities cannot call this user-authenticated control route.
  app.patch(base, async request => {
    const user = await ctx.requireUser(request), id = (request.params as { conversationId: string }).conversationId;
    const input = request.body as Record<string, unknown> | null;
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["group", "enabled"].includes(key)) || !conversationToolGroups.some(group => group.id === input.group) || typeof input.enabled !== "boolean") throw invalid();
    return withConversationTools(ctx, id, async () => {
      const row = await requireToolConversation(ctx, user, id);
      const settings = readConversationTools(row.tool_settings);
      settings[input.group as ConversationToolGroup] = input.enabled as boolean;
      await ctx.requireProject(user, row.project_id!, "write");
      const result = await ctx.db.run(`UPDATE conversations SET tool_settings=? WHERE id=? AND deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM users u JOIN projects p ON p.id=conversations.project_id
        WHERE u.id=? AND u.enabled=1 AND p.status NOT IN ('deleted','deleting','purged')
        AND (u.role='owner' OR EXISTS(SELECT 1 FROM organization_memberships o
        WHERE o.org_id=p.org_id AND o.user_id=u.id AND (o.role='admin' OR EXISTS(
        SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=u.id)))))`, [JSON.stringify(settings), id, user.id]);
      if (result.changes !== 1) throw new AppError(404, "not_found", "Workspace conversation not found.");
      if(input.group==="timers" && input.enabled===false && await ctx.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_session_timers'"))await ctx.db.run("UPDATE workspace_session_timers SET status='paused',revision=revision+1 WHERE conversation_id=? AND status='active'",[id]);
      if(input.group==="browser"&&input.enabled===false)await ctx.runtime?.browser?.(row.project_id!,id,{action:"stop"});
      await ctx.onConversationToolsChanged?.(id,String(input.group),Boolean(input.enabled));
      return view(settings);
    });
  });
}

export function contentToolGroup(kind: unknown): ConversationToolGroup {
  if (kind === "note" || kind === "artifact") return "notes";
  if (kind === "event" || kind === "task") return "calendar";
  if (kind === "library") return "library";
  throw new AppError(400, "invalid_content", "Choose a workspace item type.");
}
export async function conversationToolAccess(ctx: AppContext, user: User, conversationId: string, projectId: string) {
  const row = await requireToolConversation(ctx, user, conversationId);
  if (row.project_id !== projectId) throw new AppError(403, "forbidden", "This tool belongs to another workspace.");
  const settings = readConversationTools(row.tool_settings);
  return {
    settings,
    async require(group: ConversationToolGroup, attachment?: { kind: "note" | "conversation"; id: string }) {
      if (settings[group]) return;
      if (attachment && ((attachment.kind === "conversation" && attachment.id === conversationId) || await hasConversationAttachment(ctx, conversationId, attachment.kind, attachment.id))) return;
      const label = conversationToolGroups.find(item => item.id === group)!.label;
      throw new AppError(403, "tool_disabled", `${label} is disabled for this conversation.`);
    },
  };
}

/** Public shared transcript only; private native records and tool state stay private. */
export async function readToolConversation(ctx: AppContext, user: User, projectId: string, id: string, input: Record<string, unknown>) {
  const row = await requireToolConversation(ctx, user, id);
  if (row.project_id !== projectId) throw new AppError(404, "not_found", "Workspace conversation not found.");
  if (input.messageId !== undefined) {
    const offset = input.offset ?? 0, characters = input.characters ?? 16000;
    if (typeof input.messageId !== "string" || !Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(characters) || Number(characters) < 1 || Number(characters) > 16000)
      throw new AppError(400, "invalid_input", "Choose a message ID, nonnegative text offset and 1–16000 characters.");
    const message = await ctx.db.get<{ id: string; role: string; content: Uint8Array; totalCharacters: number; windowCharacters: number; kind: string; createdAt: string }>(
      "SELECT id,role,wme_text_substr(CAST(content AS BLOB),?,?) AS content,wme_text_length(CAST(content AS BLOB)) AS totalCharacters,wme_text_length(wme_text_substr(CAST(content AS BLOB),?,?)) AS windowCharacters,kind,created_at AS createdAt FROM conversation_messages WHERE conversation_id=? AND id=?",
      [Number(offset) + 1, Number(characters), Number(offset) + 1, Number(characters), id, input.messageId],
    );
    if (!message) throw new AppError(404, "not_found", "Conversation message not found.");
    const next = Number(offset) + message.windowCharacters;
    const { windowCharacters: _count, ...content } = message;
    return { conversationId: id, message: { ...content, content: Buffer.from(message.content).toString("utf8"), offset: Number(offset), nextOffset: next < message.totalCharacters ? next : null } };
  }
  if (input.offset !== undefined || input.characters !== undefined)
    throw new AppError(400, "invalid_input", "Choose a message ID to read a text window.");
  const after = input.after ?? 0, limit = input.limit ?? 50;
  if (!Number.isSafeInteger(after) || Number(after) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100)
    throw new AppError(400, "invalid_input", "Choose a nonnegative message cursor and a limit from 1 to 100.");
  const messages = await ctx.db.all<{ cursor: number; id: string; role: string; content: Uint8Array; totalCharacters: number; kind: string; createdAt: string }>(
    "SELECT rowid AS cursor,id,role,wme_text_substr(CAST(content AS BLOB),1,16000) AS content,wme_text_length(CAST(content AS BLOB)) AS totalCharacters,kind,created_at AS createdAt FROM conversation_messages WHERE conversation_id=? AND rowid>? ORDER BY rowid LIMIT ?", [id, Number(after), Number(limit) + 1],
  );
  const items = messages.slice(0, Number(limit));
  return { conversationId: id, items: items.map(item => ({ ...item, content: Buffer.from(item.content).toString("utf8"), contentTruncated: item.totalCharacters > 16000, offset: 0, nextOffset: item.totalCharacters > 16000 ? 16000 : null })), nextAfter: messages.length > Number(limit) ? items.at(-1)!.cursor : null };
}
