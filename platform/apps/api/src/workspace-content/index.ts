import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";
import type { ConversationService } from "../conversations/service.js";
import { WorkspaceContent, contentView, object } from "./service.js";
import { WorkspaceScheduler } from "./scheduler.js";
import { databaseOperation } from "./databases.js";
import { workspaceLibrary, workspaceUsage } from "./library.js";
import { captureLibraryMessage, captureLibraryNativeBatch, downloadLibraryFile, retryLibraryFile } from "./library-storage.js";
import { AppError } from "../context.js";
import type { InferenceService } from "../inference/service.js";
import { contentToolGroup, conversationToolAccess, readToolConversation, registerConversationTools, withConversationTools } from "../conversations/conversation-tools.js";
const params = (r: FastifyRequest) => r.params as { projectId: string; id: string };
export async function registerWorkspaceContent(app: FastifyInstance, ctx: AppContext, conversations: ConversationService, jobs: boolean, inference: InferenceService) {
  const service = new WorkspaceContent(ctx), scheduler = new WorkspaceScheduler(ctx, conversations);
  await service.initialize();
  await registerConversationTools(app, ctx);
  conversations.onMessageAccepted = (user, projectId, messageId) => captureLibraryMessage(ctx, user, projectId, messageId);
  conversations.onNativeLibraryBatch = (user, projectId, messageId, batch) => captureLibraryNativeBatch(ctx, user, projectId, messageId, batch);
  service.onTaskChanged = async (user, id) => {
    const runs = await ctx.db.all<{ conversation_id: string; run_id: string }>("SELECT t.conversation_id,t.run_id FROM workspace_task_runs t JOIN conversation_runs r ON r.id=t.run_id WHERE t.content_id=? AND r.status IN ('queued','dispatching','running','cancelling')", [id]);
    for (const run of runs) await conversations.cancel(user, run.conversation_id, run.run_id);
  };
  const base = "/enterprise/api/projects/:projectId/workspace-content";
  app.get(base, async r => service.list(await ctx.requireUser(r), params(r).projectId, (r.query as any).kind));
  app.post(base, async (r, reply) => reply.code(201).send(await service.create(await ctx.requireUser(r), params(r).projectId, object(r.body))));
  app.get(base + "/:id", async r => contentView(await service.require(await ctx.requireUser(r), params(r).projectId, params(r).id)));
  app.patch(base + "/:id", async r => service.update(await ctx.requireUser(r), params(r).projectId, params(r).id, object(r.body)));
  app.delete(base + "/:id", async r => service.remove(await ctx.requireUser(r), params(r).projectId, params(r).id, Number((r.query as any).revision)));
  app.get(base + "/:id/versions", async r => service.versions(await ctx.requireUser(r), params(r).projectId, params(r).id));
  app.post(base + "/:id/restore", async r => service.restore(await ctx.requireUser(r), params(r).projectId, params(r).id, object(r.body)));
  app.get(base + "/:id/runs", async r => {
    await service.require(await ctx.requireUser(r), params(r).projectId, params(r).id);
    return { items: await ctx.db.all("SELECT id,occurrence,conversation_id AS conversationId,run_id AS runId,status,error,created_at AS createdAt FROM workspace_task_runs WHERE content_id=? ORDER BY created_at DESC LIMIT 100", [params(r).id]), state: await ctx.db.get("SELECT next_at AS nextAt,last_status AS lastStatus,last_error AS lastError FROM workspace_task_state WHERE content_id=?", [params(r).id]) ?? null };
  });
  app.post("/enterprise/api/projects/:projectId/databases", async r => databaseOperation(ctx, await ctx.requireUser(r), params(r).projectId, object(r.body)));
  app.get("/enterprise/api/projects/:projectId/workspace-library", async r => workspaceLibrary(ctx, await ctx.requireUser(r), params(r).projectId));
  app.get("/enterprise/api/projects/:projectId/workspace-library/:id/download", async (r, reply) => {
    const file = await downloadLibraryFile(ctx, await ctx.requireUser(r), params(r).projectId, params(r).id);
    return reply.header("Content-Type", "application/octet-stream")
      .header("Content-Length", file.bytes.length).header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store").header("X-Library-Hash", file.hash)
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`)
      .send(file.bytes);
  });
  app.post("/enterprise/api/projects/:projectId/workspace-library/:id/retry", async r => retryLibraryFile(ctx, await ctx.requireUser(r), params(r).projectId, params(r).id));
  app.get("/enterprise/api/projects/:projectId/usage", async r => workspaceUsage(ctx, await ctx.requireUser(r), params(r).projectId));
  app.post("/enterprise/api/runtime/inference/:projectId/workspace/:operation", { bodyLimit: 2 * 1024 * 1024, config: { internalInference: true } }, async r => {
    const token = /^Bearer ([^\s]+)$/.exec(r.headers.authorization ?? "")?.[1];
    if (!token) throw new AppError(401, "unauthorized", "A current workspace run is required.");
    const { projectId, operation } = r.params as { projectId: string; operation: string };
    const initial = await inference.authorizeGateway(projectId, token);
    if (initial.assetId || !initial.conversationId) throw new AppError(403, "forbidden", "Use this operation from a workspace conversation.");
    return withConversationTools(ctx, initial.conversationId, async () => {
      // A queued call must recheck the current run after a settings change.
      const scope = await inference.authorizeGateway(projectId, token);
      const user = await conversations.user(scope.userId);
      await ctx.requireProject(user, projectId, "write");
      const access = await conversationToolAccess(ctx, user, initial.conversationId!, projectId);
      const input = object(r.body), id = typeof input.id === "string" ? input.id : "";
      if (input.kind === "conversation" && operation === "list") {
        await access.require("history");
        const list = await conversations.list(user, projectId);
        return { items: list.items.map(item => ({ id: item.id, title: item.title, folderId: item.folderId, updatedAt: item.updatedAt })) };
      }
      if (input.kind === "conversation" && operation === "read") {
        await access.require("history", { kind: "conversation", id });
        return readToolConversation(ctx, user, projectId, id, input);
      }
      if (operation === "list") {
        if (input.kind) await access.require(contentToolGroup(input.kind));
        const list = await service.list(user, projectId, input.kind);
        return { items: list.items.filter(item => access.settings[contentToolGroup(item.kind)]) };
      }
      if (["read", "update", "delete", "versions", "restore"].includes(operation)) {
        const row = await service.require(user, projectId, id);
        await access.require(contentToolGroup(row.kind), operation === "read" && row.kind === "note" ? { kind: "note", id } : undefined);
        if (operation === "read") return contentView(row);
        if (operation === "update") return service.update(user, projectId, id, input);
        if (operation === "delete") return service.remove(user, projectId, id, Number(input.expectedRevision));
        if (operation === "versions") return service.versions(user, projectId, id);
        return service.restore(user, projectId, id, input);
      }
      if (operation === "create") { await access.require(contentToolGroup(input.kind)); return service.create(user, projectId, input); }
      if (operation === "library") { await access.require("library"); return workspaceLibrary(ctx, user, projectId); }
      if (operation === "usage") { await access.require("usage"); return workspaceUsage(ctx, user, projectId); }
      if (operation === "databases") { await access.require("notes"); return databaseOperation(ctx, user, projectId, input); }
      throw new AppError(400, "invalid_operation", "Choose a workspace operation.");
    });
  });
  if (jobs) scheduler.start();
  app.addHook("onClose", () => scheduler.close());
  return { service, scheduler };
}
