import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";
import { InferenceService } from "./service.js";
import { InferenceError, object } from "./proxy-client.js";
export { InferenceService } from "./service.js";
export type {
  InferenceOptions,
  ProxyRegistry,
  RunScope,
  InferenceModel,
} from "./service.js";
export {
  CLAUDE_SUBSCRIPTION_NOTICE,
  CLI_PROXY_REVISION,
} from "./proxy-client.js";

const paramsSchema = {
  type: "object",
  required: ["orgId"],
  properties: { orgId: { type: "string", format: "uuid" } },
} as const;
const accountSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "label", "apiKey"],
  properties: {
    provider: {
      type: "string",
      enum: ["openai", "anthropic", "xai", "openrouter", "custom"],
    },
    label: { type: "string", minLength: 1, maxLength: 160 },
    apiKey: { type: "string", minLength: 8, maxLength: 8192 },
    baseUrl: { type: "string", maxLength: 2048 },
    models: {
      type: "array",
      maxItems: 500,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
} as const;
type OrgParams = { orgId: string; accountId?: string; sessionId?: string };
export async function registerInferenceRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  service: InferenceService,
) {
  const activeRequests = new Set<AbortController>();
  let closing = false;
  // onClose runs after HTTP drains; a provider stream can otherwise prevent
  // it from ever reaching conversation cancellation and database shutdown.
  app.addHook("preClose", async () => {
    closing = true;
    for (const controller of activeRequests) controller.abort();
  });
  const base = "/api/organizations/:orgId/inference";
  async function admin(request: FastifyRequest) {
    const user = await ctx.requireUser(request);
    const { orgId } = request.params as OrgParams;
    await ctx.requireOrgAdmin(user, orgId);
    return user;
  }
  // Inference error messages are static and redact upstream details by construction.
  app.get(
    `${base}/accounts`,
    { schema: { params: paramsSchema } },
    async (request) => {
      await admin(request);
      return service.accounts((request.params as OrgParams).orgId);
    },
  );
  app.post(
    `${base}/accounts`,
    { schema: { params: paramsSchema, body: accountSchema } },
    async (request, reply) => {
      const user = await admin(request);
      const account = await service.addApiKey(
        user,
        (request.params as OrgParams).orgId,
        request.body as Parameters<InferenceService["addApiKey"]>[2],
      );
      return reply.code(201).send(account);
    },
  );
  app.post(
    `${base}/discover`,
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["provider", "apiKey"],
          properties: {
            provider: {
              type: "string",
              enum: ["openai", "anthropic", "xai", "openrouter", "custom"],
            },
            apiKey: { type: "string", minLength: 8, maxLength: 8192 },
            baseUrl: { type: "string", maxLength: 2048 },
          },
        },
      },
    },
    async (request) => {
      const user = await admin(request);
      return service.discover(
        user,
        (request.params as OrgParams).orgId,
        request.body as Parameters<InferenceService["discover"]>[2],
      );
    },
  );
  app.patch(
    `${base}/accounts/:accountId`,
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            enabled: { type: "boolean" },
            priority: { type: "integer", minimum: -1000, maximum: 1000 },
            label: { type: "string", minLength: 1, maxLength: 160 },
          },
        },
      },
    },
    async (request) => {
      const user = await admin(request);
      const { orgId, accountId } = request.params as OrgParams;
      return service.updateAccount(
        user,
        orgId,
        accountId!,
        request.body as Parameters<InferenceService["updateAccount"]>[3],
      );
    },
  );
  app.delete(`${base}/accounts/:accountId`, async (request) => {
    const user = await admin(request);
    const { orgId, accountId } = request.params as OrgParams;
    return service.removeAccount(user, orgId, accountId!);
  });
  app.post(`${base}/accounts/:accountId/refresh`, async (request) => {
    const user = await admin(request);
    const { orgId, accountId } = request.params as OrgParams;
    return service.refreshAccount(user, orgId, accountId!);
  });
  app.post(
    `${base}/oauth`,
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["provider"],
          properties: {
            provider: { type: "string", enum: ["openai", "anthropic", "xai"] },
            acceptedRisk: { type: "boolean" },
          },
        },
      },
    },
    async (request) => {
      const user = await admin(request);
      const input = request.body as {
        provider: "openai" | "anthropic" | "xai";
        acceptedRisk?: boolean;
      };
      return service.startOAuth(
        user,
        (request.params as OrgParams).orgId,
        input.provider,
        input.acceptedRisk === true,
      );
    },
  );
  app.get(`${base}/oauth/:sessionId`, async (request) => {
    const user = await admin(request);
    const { orgId, sessionId } = request.params as OrgParams;
    return service.oauthStatus(user, orgId, sessionId!);
  });
  app.post(
    `${base}/oauth/:sessionId/callback`,
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["redirectUrl"],
          properties: {
            redirectUrl: { type: "string", minLength: 1, maxLength: 16384 },
          },
        },
      },
    },
    async (request) => {
      const user = await admin(request);
      const { orgId, sessionId } = request.params as OrgParams;
      return service.oauthCallback(
        user,
        orgId,
        sessionId!,
        (request.body as { redirectUrl: string }).redirectUrl,
      );
    },
  );
  app.delete(`${base}/oauth/:sessionId`, async (request) => {
    const user = await admin(request);
    const { orgId, sessionId } = request.params as OrgParams;
    return service.cancelOAuth(user, orgId, sessionId!);
  });
  app.get(`${base}/models`, async (request) => {
    const user = await ctx.requireUser(request);
    const { orgId } = request.params as OrgParams;
    await ctx.requireOrgMember(user, orgId);
    return { items: await service.models(orgId) };
  });
  app.get(`${base}/usage`, async (request) => {
    await admin(request);
    return service.usage((request.params as OrgParams).orgId);
  });

  const gateway = "/api/runtime/inference/:projectId";
  // The foundation excludes ONLY this bearer-authenticated prefix from browser CSRF.
  // Nothing under this prefix forwards management requests or browser cookies.
  for (const path of [
    "/v1/models",
    "/v1/responses",
    "/v1/responses/compact",
    "/v1/chat/completions",
    "/v1/messages",
    "/v1/messages/count_tokens",
  ]) {
    app.route({
      method: path === "/v1/models" ? "GET" : "POST",
      url: `${gateway}${path}`,
      config: { internalInference: true },
      bodyLimit: 8 * 1024 * 1024,
      handler: async (request, reply) => {
        const projectId = (request.params as { projectId: string }).projectId;
        const auth = request.headers.authorization;
        const token =
          typeof auth === "string" && auth.startsWith("Bearer ")
            ? auth.slice(7)
            : typeof request.headers["x-api-key"] === "string"
              ? request.headers["x-api-key"]
              : "";
        const scope = await service.authorizeGateway(projectId, token);
        if (
          path !== "/v1/models" &&
          scope.model &&
          object(request.body).model !== scope.model
        )
          throw new InferenceError(
            403,
            "run_model_denied",
            "This run credential is restricted to its selected model.",
          );
        if (closing)
          throw new InferenceError(
            503,
            "gateway_closing",
            "The inference gateway is stopping.",
          );
        const abort = new AbortController();
        activeRequests.add(abort);
        const disconnected = () => abort.abort();
        request.raw.on("aborted", disconnected);
        reply.raw.on("close", disconnected);
        let checking = false;
        const interval = setInterval(() => {
          if (checking) return;
          checking = true;
          void service
            .authorizeGateway(projectId, token)
            .catch(() => abort.abort())
            .finally(() => {
              checking = false;
            });
        }, 1000);
        interval.unref();
        const cleanup = () => {
          activeRequests.delete(abort);
          clearInterval(interval);
          request.raw.off("aborted", disconnected);
          reply.raw.off("close", disconnected);
        };
        try {
          const beta = request.headers["anthropic-beta"];
          const response = await service.proxy.forward(
            scope.orgId,
            path,
            request.body,
            abort.signal,
            {
              sessionId: `wme:${scope.orgId}:${scope.projectId}:${scope.conversationId ?? scope.runId}`,
              anthropicBeta:
                typeof beta === "string" &&
                beta.length <= 2048 &&
                /^[a-zA-Z0-9_, .-]+$/.test(beta)
                  ? beta
                  : undefined,
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new InferenceError(
              response.status === 429 ? 429 : 502,
              "provider_request_failed",
              `The model request failed (HTTP ${response.status}).`,
            );
          }
          reply.header("cache-control", "no-store");
          reply.header(
            "content-type",
            response.headers.get("content-type")?.includes("text/event-stream")
              ? "text/event-stream"
              : "application/json",
          );
          if (!response.body) {
            cleanup();
            return reply.send();
          }
          const stream = Readable.fromWeb(
            response.body as Parameters<typeof Readable.fromWeb>[0],
          );
          stream.once("close", cleanup);
          stream.once("error", cleanup);
          stream.once("end", cleanup);
          return reply.send(stream);
        } catch (error) {
          cleanup();
          throw error;
        }
      },
    });
  }
}
