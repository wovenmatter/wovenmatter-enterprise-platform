import { Readable } from "node:stream";
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
      if (c.asset_id) return { items: [] };
      const project = await ctx.db.get<{
        org_id: string;
      }>("SELECT org_id FROM projects WHERE id=?", [c.project_id]);
      return {
        items: await ctx.db.all(
          "SELECT u.id,u.name,u.email FROM users u WHERE u.enabled=1 AND (u.role='owner' OR EXISTS(SELECT 1 FROM organization_memberships m WHERE m.user_id=u.id AND m.org_id=? AND (m.role='admin' OR EXISTS(SELECT 1 FROM project_members p WHERE p.user_id=u.id AND p.project_id=? AND (?='read' OR p.access='write'))))) ORDER BY u.name,u.email",
          [project!.org_id, c.project_id, c.mode],
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
        query.compact === "1",
      );
    },
  );
  app.get(
    "/enterprise/api/conversations/:conversationId/messages/:messageId",
    async (r) =>
      service.message(
        await ctx.requireUser(r),
        params(r).conversationId!,
        params(r).messageId!,
      ),
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
  const natural = (value: unknown, fallback?: number): number | undefined => {
    if (value === undefined) return fallback;
    if (
      typeof value !== "string" ||
      !/^\d{1,16}$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw new AppError(400, "invalid_cursor", "Invalid history cursor.");
    return Number(value);
  };
  app.get(
    "/enterprise/api/conversations/:conversationId/sdk-catalog",
    async (r) =>
      service.sdkCatalog(await ctx.requireUser(r), params(r).conversationId!),
  );
  app.post(
    "/enterprise/api/conversations/:conversationId/sdk-generation",
    async (r) =>
      service.activateSDK(
        await ctx.requireUser(r),
        params(r).conversationId!,
        body(r).generation,
      ),
  );
  app.get(
    "/enterprise/api/conversations/:conversationId/activities",
    async (r) => {
      const q = r.query as Record<string, unknown>;
      if (
        q.runId !== undefined &&
        (typeof q.runId !== "string" ||
          !q.runId ||
          q.runId.length > 100 ||
          q.after !== undefined ||
          q.before !== undefined)
      )
        throw new AppError(
          400,
          "invalid_cursor",
          "Choose a run or the conversation history cursor.",
        );
      if (q.runAfter !== undefined && q.runId === undefined)
        throw new AppError(
          400,
          "invalid_cursor",
          "Choose a run for this activity cursor.",
        );
      if (
        q.after !== undefined &&
        (typeof q.after !== "string" ||
          !/^\d{1,16}:\d{1,16}$/.test(q.after) ||
          !q.after
            .split(":")
            .every((value) => Number.isSafeInteger(Number(value))))
      )
        throw new AppError(400, "invalid_cursor", "Invalid activity cursor.");
      if (q.after !== undefined && q.before !== undefined)
        throw new AppError(400, "invalid_cursor", "Choose one cursor.");
      return service.activities(
        await ctx.requireUser(r),
        params(r).conversationId!,
        q.after as string | undefined,
        natural(q.before),
        q.runId as string | undefined,
        natural(q.runAfter, 0),
      );
    },
  );
  app.get(
    "/enterprise/api/conversations/:conversationId/activities/:runId/:key",
    async (r) => {
      const q = r.query as Record<string, unknown>;
      return service.activityDetail(
        await ctx.requireUser(r),
        params(r).conversationId!,
        params(r).runId!,
        params(r).key!,
        natural(q.offset, 0)!,
        natural(q.revision),
      );
    },
  );
  app.get(
    "/enterprise/api/conversations/:conversationId/archive",
    async (r) => {
      const q = r.query as Record<string, unknown>;
      if (q.q !== undefined && (typeof q.q !== "string" || q.q.length > 500))
        throw new AppError(
          400,
          "invalid_query",
          "Search must contain at most 500 characters.",
        );
      if (q.runId !== undefined && typeof q.runId !== "string")
        throw new AppError(400, "invalid_query", "Invalid run.");
      return service.archive(
        await ctx.requireUser(r),
        params(r).conversationId!,
        natural(q.after, 0)!,
        q.q as string | undefined,
        q.runId as string | undefined,
        false,
      );
    },
  );
  app.get(
    "/enterprise/api/conversations/:conversationId/archive/:ordinal",
    async (r) =>
      service.archiveRecord(
        await ctx.requireUser(r),
        params(r).conversationId!,
        natural(params(r).ordinal)!,
      ),
  );
  app.get(
    "/enterprise/api/conversations/:conversationId/archive/export",
    async (r, reply) => {
      const id = params(r).conversationId!;
      await service.requireConversation(await ctx.requireUser(r), id);
      async function* records() {
        let after = 0;
        do {
          const page = await service.archive(
            await ctx.requireUser(r),
            id,
            after,
          );
          for (const record of page.items) {
            if (reply.raw.destroyed) return;
            yield JSON.stringify(record) + "\n";
          }
          after = page.cursor;
          if (!page.hasMore) return;
        } while (!reply.raw.destroyed);
      }
      return reply
        .header("cache-control", "no-store")
        .header(
          "content-disposition",
          'attachment; filename="native-history.ndjson"',
        )
        .type("application/x-ndjson")
        .send(Readable.from(records()));
    },
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
      let events;
      do {
        // Re-read session and authorization while connected; no cached membership survives revocation.
        const freshUser = await ctx.requireUser(request);
        events = await service.events(freshUser, id, after);
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
      } while (!closed && events.length === 100);
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
