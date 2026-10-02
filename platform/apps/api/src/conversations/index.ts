import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError, type AppContext } from "../context.js";
import { ConversationService } from "./service.js";
export { ConversationService, createConversationService } from "./service.js";
export type { ConversationDependencies } from "./types.js";
const body = (request: FastifyRequest): Record<string, unknown> => {
  if (
    !request.body ||
    typeof request.body !== "object" ||
    Array.isArray(request.body)
  )
    throw new AppError(400, "invalid_input", "A JSON object is required.");
  return request.body as Record<string, unknown>;
};
const params = (r: FastifyRequest) => r.params as Record<string, string>;
export async function registerConversations(
  app: FastifyInstance,
  ctx: AppContext,
  service: ConversationService,
) {
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const close of streams) close();
  });
  app.get("/enterprise/api/projects/:projectId/conversations", async (r) =>
    service.list(await ctx.requireUser(r), params(r).projectId!),
  );
  app.post(
    "/enterprise/api/projects/:projectId/conversations",
    async (r, reply) =>
      reply
        .code(201)
        .send(
          await service.create(
            await ctx.requireUser(r),
            params(r).projectId!,
            body(r),
          ),
        ),
  );
  app.get("/enterprise/api/conversations/:conversationId", async (r) =>
    service.get(await ctx.requireUser(r), params(r).conversationId!),
  );
  app.patch("/enterprise/api/conversations/:conversationId", async (r) =>
    service.update(
      await ctx.requireUser(r),
      params(r).conversationId!,
      body(r),
    ),
  );
  app.delete("/enterprise/api/conversations/:conversationId", async (r) =>
    service.remove(await ctx.requireUser(r), params(r).conversationId!),
  );
  app.get("/enterprise/api/conversations/:conversationId/members", async (r) =>
    service.members(await ctx.requireUser(r), params(r).conversationId!),
  );
  app.get(
    "/enterprise/api/conversations/:conversationId/eligible-members",
    async (r) => {
      const c = await service.requireConversation(
        await ctx.requireUser(r),
        params(r).conversationId!,
      );
      const project = await ctx.db.get<{
        org_id: string;
      }>("SELECT org_id FROM projects WHERE id=?", [c.project_id]);
      return {
        items: await ctx.db.all(
          "SELECT u.id,u.name,u.email FROM users u WHERE u.enabled=1 AND (u.role='owner' OR EXISTS(SELECT 1 FROM organization_memberships m WHERE m.user_id=u.id AND m.org_id=? AND (m.role='admin' OR EXISTS(SELECT 1 FROM project_members p WHERE p.user_id=u.id AND p.project_id=?)))) ORDER BY u.name,u.email",
          [project!.org_id, c.project_id],
        ),
      };
    },
  );
  app.post(
    "/enterprise/api/conversations/:conversationId/members",
    async (r) => {
      const input = body(r);
      if (typeof input.userId !== "string")
        throw new AppError(400, "invalid_input", "Select a project member.");
      return service.addMember(
        await ctx.requireUser(r),
        params(r).conversationId!,
        input.userId,
      );
    },
  );
  app.delete(
    "/enterprise/api/conversations/:conversationId/members/:userId",
    async (r) =>
      service.removeMember(
        await ctx.requireUser(r),
        params(r).conversationId!,
        params(r).userId!,
      ),
  );
  app.get(
    "/enterprise/api/conversations/:conversationId/messages",
    async (r) => {
      const query = r.query as Record<string, unknown>;
      return service.messages(
        await ctx.requireUser(r),
        params(r).conversationId!,
        typeof query.before === "string" ? query.before : undefined,
      );
    },
  );
  app.post(
    "/enterprise/api/conversations/:conversationId/messages",
    async (r, reply) =>
      reply
        .code(202)
        .send(
          await service.admit(
            await ctx.requireUser(r),
            params(r).conversationId!,
            body(r),
          ),
        ),
  );
  app.get(
    "/enterprise/api/conversations/:conversationId/runs/:runId/sources",
    async (r) =>
      service.sources(
        await ctx.requireUser(r),
        params(r).conversationId!,
        params(r).runId!,
      ),
  );
  app.get("/enterprise/api/conversations/:conversationId/runs", async (r) =>
    service.runs(await ctx.requireUser(r), params(r).conversationId!),
  );
  app.post(
    "/enterprise/api/conversations/:conversationId/cancel",
    async (r) => {
      const input = r.body ? body(r) : {};
      if (input.runId !== undefined && typeof input.runId !== "string")
        throw new AppError(400, "invalid_input", "Invalid run ID.");
      return service.cancel(
        await ctx.requireUser(r),
        params(r).conversationId!,
        input.runId as string | undefined,
      );
    },
  );
  app.get(
    "/enterprise/api/conversations/:conversationId/events",
    async (request, reply) =>
      streamEvents(request, reply, ctx, service, streams),
  );
}
async function streamEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: AppContext,
  service: ConversationService,
  streams: Set<() => void>,
) {
  const user = await ctx.requireUser(request),
    id = params(request).conversationId!,
    query = request.query as Record<string, unknown>;
  const rawAfter = request.headers["last-event-id"] ?? query.after ?? "0";
  if (
    typeof rawAfter !== "string" ||
    !/^\d{1,16}$/.test(rawAfter) ||
    !Number.isSafeInteger(Number(rawAfter))
  )
    throw new AppError(
      400,
      "invalid_cursor",
      "Event cursor must be a nonnegative integer.",
    );
  let after = Number(rawAfter);
  await service.requireConversation(user, id);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.write(": connected\n\n");
  let closed = false,
    busy = false,
    heartbeats = 0;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    streams.delete(finish);
    reply.raw.end();
  };
  const tick = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      // Re-read session and authorization while connected; no cached membership survives revocation.
      const freshUser = await ctx.requireUser(request);
      const events = await service.events(freshUser, id, after);
      if (closed) return;
      for (const event of events) {
        if (closed) break;
        if (reply.raw.writableLength > 1_048_576) {
          finish();
          break;
        }
        reply.raw.write(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
        after = event.id;
      }
      if (!closed && ++heartbeats % 15 === 0)
        reply.raw.write(": heartbeat\n\n");
    } catch {
      if (!closed)
        reply.raw.write(
          'event: access.revoked\ndata: {"type":"access.revoked"}\n\n',
        );
      finish();
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  timer.unref();
  streams.add(finish);
  reply.raw.on("close", finish);
  request.raw.on("aborted", finish);
  await tick();
}
