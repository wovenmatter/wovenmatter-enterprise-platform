import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AppError, objectBody, type AppContext } from "./context.js";
import { normalizeConversationTools } from "./conversations/conversation-tools.js";

export type PersonalPreferences = { dictationLanguage: string; automaticTitles:boolean; calendarAccess:"readOnly"|"full"; tools: ReturnType<typeof normalizeConversationTools> };
export async function personalPreferences(ctx: AppContext, userId: string): Promise<PersonalPreferences> {
  const row = await ctx.db.get<{settings: string}>("SELECT settings FROM personal_preferences WHERE user_id=?", [userId]);
  return { dictationLanguage: "", automaticTitles:true, calendarAccess:"full", tools: normalizeConversationTools(), ...JSON.parse(row?.settings ?? "{}") };
}
export async function migratePreferences(ctx: AppContext) {
  await ctx.db.migrate("desktop-workspace-preferences-v1", `
CREATE TABLE personal_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id),settings TEXT NOT NULL DEFAULT '{}');
CREATE TABLE organization_agent_settings(org_id TEXT PRIMARY KEY REFERENCES organizations(id),settings TEXT NOT NULL DEFAULT '{}',revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL);
CREATE TABLE dictation_history(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),text TEXT NOT NULL,language TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE INDEX dictation_history_owner ON dictation_history(user_id,created_at DESC);
`);
}
export async function registerPreferences(app: FastifyInstance,ctx:AppContext) {
  await migratePreferences(ctx);
  app.get("/enterprise/api/me/preferences", async request => personalPreferences(ctx, (await ctx.requireUser(request)).id));
  app.patch("/enterprise/api/me/preferences", async request => {
    const user = await ctx.requireUser(request), input = objectBody(request.body);
    if (Object.keys(input).some(key => !["dictationLanguage", "tools","automaticTitles","calendarAccess"].includes(key)))
      throw new AppError(400, "invalid_preferences", "Choose supported preferences.");
    const previous = await personalPreferences(ctx, user.id);
    if (input.automaticTitles!==undefined && typeof input.automaticTitles!=="boolean" || input.calendarAccess!==undefined && !["readOnly","full"].includes(String(input.calendarAccess))) throw new AppError(400,"invalid_preferences","Choose supported title and calendar settings.");
    if (input.dictationLanguage !== undefined && (typeof input.dictationLanguage !== "string" || !/^[a-zA-Z0-9-]{0,64}$/.test(input.dictationLanguage)))
      throw new AppError(400, "invalid_preferences", "Choose a language tag or Automatic.");
    const next = { automaticTitles:input.automaticTitles===undefined?previous.automaticTitles:input.automaticTitles,calendarAccess:input.calendarAccess===undefined?previous.calendarAccess:input.calendarAccess,dictationLanguage: input.dictationLanguage === undefined ? previous.dictationLanguage : input.dictationLanguage,
      tools: input.tools === undefined ? previous.tools : normalizeConversationTools(input.tools) };
    await ctx.db.run("INSERT INTO personal_preferences(user_id,settings) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings=excluded.settings", [user.id, JSON.stringify(next)]);
    return next;
  });
  app.get("/enterprise/api/me/dictations", async request => {
    const user = await ctx.requireUser(request), query = request.query as Record<string,string>;
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20))),offset=Math.min(100000,Math.max(0,Math.floor(Number(query.offset)||0)));
    const before = query.before ?? "9999", search = (query.search ?? "").slice(0, 200);
    const items = await ctx.db.all("SELECT id,text,language,created_at AS createdAt FROM dictation_history WHERE user_id=? AND created_at<? AND instr(lower(text),lower(?))>0 ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", [user.id, before, search, limit + 1,offset]);
    const hasMore = items.length > limit;
    return { items: items.slice(0, limit), hasMore, nextBefore: hasMore ? (items[limit - 1] as {createdAt:string}).createdAt : null };
  });
  app.post("/enterprise/api/me/dictations", async request => {
    const user = await ctx.requireUser(request), input = objectBody(request.body);
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 100000 || (input.language !== undefined && (typeof input.language !== "string" || input.language.length > 64)))
      throw new AppError(400, "invalid_dictation", "Dictation must contain 1–100,000 characters.");
    const id = randomUUID(), at = new Date().toISOString();
    await ctx.db.batch([
      {sql:"INSERT INTO dictation_history(id,user_id,text,language,created_at) VALUES(?,?,?,?,?)",params:[id,user.id,input.text.trim(),String(input.language ?? ""),at]},
    ]);
    return {id,text:input.text.trim(),language:input.language ?? "",createdAt:at};
  });
  app.delete("/enterprise/api/me/dictations/:id", async request => {
    const user = await ctx.requireUser(request);
    await ctx.db.run("DELETE FROM dictation_history WHERE id=? AND user_id=?", [(request.params as {id:string}).id,user.id]);
    return {ok:true};
  });
}
