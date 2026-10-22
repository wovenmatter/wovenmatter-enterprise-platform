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
const params = (r: FastifyRequest) => r.params as { projectId: string; id: string };
export async function registerWorkspaceContent(app: FastifyInstance, ctx: AppContext, conversations: ConversationService, jobs: boolean, inference: InferenceService) {
  const service = new WorkspaceContent(ctx), scheduler = new WorkspaceScheduler(ctx, conversations);
  await service.initialize();
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
    const scope = await inference.authorizeGateway(projectId, token);
    if (scope.assetId) throw new AppError(403, "forbidden", "Use the dedicated asset operation in an asset conversation.");
    const user = await conversations.user(scope.userId);
    await ctx.requireProject(user, projectId, "write");
    const input = object(r.body);
    const id = typeof input.id === "string" ? input.id : "";
    if (operation === "list") return service.list(user, projectId, input.kind);
    if (operation === "read") return contentView(await service.require(user, projectId, id));
    if (operation === "create") return service.create(user, projectId, input);
    if (operation === "update") return service.update(user, projectId, id, input);
    if (operation === "delete") return service.remove(user, projectId, id, Number(input.expectedRevision));
    if (operation === "versions") return service.versions(user, projectId, id);
    if (operation === "restore") return service.restore(user, projectId, id, input);
    if (operation === "library") return workspaceLibrary(ctx, user, projectId);
    if (operation === "usage") return workspaceUsage(ctx, user, projectId);
    if (operation === "databases") return databaseOperation(ctx, user, projectId, input);
    throw new AppError(400, "invalid_operation", "Choose a workspace operation.");
  });
  if (jobs) scheduler.start();
  app.addHook("onClose", () => scheduler.close());
  return { service, scheduler };
}
