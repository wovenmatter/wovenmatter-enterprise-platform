import Fastify, { LogController } from "fastify";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  createDatabase,
  migrateFoundation,
  type Database,
} from "./db/index.js";
import { createContext, AppError, type AppConfig } from "./context.js";
import { registerAuth } from "./auth/index.js";
import { registerOrganizations } from "./organizations/index.js";
import { registerProjects } from "./projects/index.js";
import {
  createJobWorker,
  registerJobs,
  type JobHandler,
} from "./jobs/index.js";
import {
  registerFiles,
  resolveProjectMounts,
  reconcileProjectFiles,
  captureProjectManifest,
} from "./files/index.js";
import { ensureRoot } from "./files/paths.js";
import {
  registerLibrary,
  setLibraryRuntime,
  recheckLibrary,
  type LibraryRuntimeHost,
} from "./library/index.js";
import {
  createConversationService,
  registerConversations,
  type ConversationService,
} from "./conversations/index.js";
import {
  InferenceService,
  registerInferenceRoutes,
  type ProxyRegistry,
} from "./inference/index.js";
import { InferenceError } from "./inference/proxy-client.js";
import type { Runtime } from "../../../packages/runtime/src/types.js";
import {
  sendInvitation,
  sendPasswordReset,
  type MailConfig,
} from "./mail/index.js";

export interface ApplicationOptions {
  database?: Database;
  runtime?: Runtime;
  registry?: ProxyRegistry;
  libraryHost?: LibraryRuntimeHost;
  mail?: MailConfig;
  webRoot?: string;
  jobs?: boolean;
  logger?: boolean;
  startConversations?: boolean;
}
const unavailableRuntime: Runtime = {
  async execute(_request, emit) {
    await emit({
      type: "failed",
      code: "runtime_unavailable",
      message:
        "Agent execution is not configured. Ask an administrator to check the runtime service.",
    });
  },
  async cancel() {},
  async recover() {
    return [];
  },
};
function regexLiteral(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export async function buildApp(
  config: AppConfig,
  options: ApplicationOptions = {},
) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const db =
    options.database ??
    (await createDatabase(join(config.stateDir, "control", "platform.sqlite")));
  await migrateFoundation(db);
  const ctx = createContext(db, config);
  const app = Fastify({
    bodyLimit: 48 * 1024 * 1024,
    trustProxy: false,
    logController: new LogController({ disableRequestLogging: true }),
    requestTimeout: 120_000,
    logger: options.logger
      ? {
          level: "info",
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.body",
            "res.headers.set-cookie",
          ],
        }
      : false,
  });
  const publicUrl = new URL(config.publicOrigin);
  const internalUrl = new URL(
    String(config.internalApiOrigin ?? config.publicOrigin),
  );
  const names = new Set([
    publicUrl.host,
    publicUrl.hostname,
    internalUrl.host,
    internalUrl.hostname,
  ]);
  if (publicUrl.hostname === "localhost") {
    names.add(`127.0.0.1:${config.port}`);
    names.add("127.0.0.1");
  }
  const portalHosts = new RegExp(
    `^(?:${[...names].map(regexLiteral).join("|")})$`,
    "i",
  );
  // Content routes supply their own exact per-asset host constraint. The ordinary
  // API and SPA must never become reachable on an untrusted generated-app origin.
  app.addHook("onRoute", (route) => {
    if (!route.constraints?.host)
      route.constraints = { ...route.constraints, host: portalHosts };
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof AppError || error instanceof InferenceError;
    const e = error as Error & {
      statusCode?: number;
      code?: string;
      validation?: unknown;
    };
    const validation = !!e.validation;
    const protocol =
      typeof e.code === "string" &&
      e.code.startsWith("FST_") &&
      typeof e.statusCode === "number" &&
      e.statusCode >= 400 &&
      e.statusCode < 500;
    const status = known
      ? e.statusCode!
      : validation
        ? 400
        : protocol
          ? e.statusCode!
          : e.statusCode === 413
            ? 413
            : e.code === "SQLITE_BUSY" ||
                e.code === "busy" ||
                e.code === "database_busy"
              ? 503
              : 500;
    const code = known
      ? e.code!
      : validation
        ? "invalid_request"
        : protocol
          ? "invalid_request"
          : status === 413
            ? "request_too_large"
            : status === 503
              ? "busy"
              : "internal_error";
    const message = known
      ? e.message
      : validation
        ? "The request contains invalid fields."
        : protocol
          ? "The request format is not supported."
          : status === 413
            ? "The request is too large."
            : status === 503
              ? "The service is busy. Please try again."
              : "The request could not be completed.";
    if (status >= 500)
      request.log.error({ code, requestId: request.id }, "Request failed");
    if (!reply.sent)
      reply
        .code(status)
        .header("cache-control", "no-store")
        .send({ error: { code, message } });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    if (portalHosts.test(request.headers.host ?? "")) {
      reply
        .header("referrer-policy", "no-referrer")
        .header("x-frame-options", "DENY")
        .header(
          "permissions-policy",
          "camera=(), microphone=(), geolocation=()",
        );
      reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-src blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
    }
    return payload;
  });
  let conversations: ConversationService | undefined;
  const inference = new InferenceService(ctx, {
    registry: options.registry ?? {
      async resolve() {
        return undefined;
      },
    },
    canUseRun: (scope) =>
      conversations?.canUseRun(scope) ?? Promise.resolve(false),
    runtimeApiOrigin: String(config.internalApiOrigin ?? config.publicOrigin),
    customProviderOrigins: Array.isArray(config.customProviderOrigins)
      ? (config.customProviderOrigins as string[])
      : [],
  });
  await inference.initialize();
  await registerAuth(app, ctx);
  await registerOrganizations(app, ctx);
  await registerProjects(app, ctx);
  await registerJobs(app, ctx);
  await registerFiles(app, ctx);
  if (options.libraryHost) setLibraryRuntime(ctx, options.libraryHost);
  await registerLibrary(app, ctx);
  await registerInferenceRoutes(app, ctx, inference);
  conversations = await createConversationService(ctx, {
    runtime: options.runtime ?? unavailableRuntime,
    files: {
      resolveProjectMounts,
      reconcileProjectFiles,
      captureProjectManifest,
    },
    inference: {
      issueGateway: (scope) =>
        inference.issueGateway({
          ...scope,
          model: scope.model ?? "",
          harness: scope.harness ?? "",
        }),
      revokeGateway: (id) => inference.revokeGateway(id),
      defaultHarness: (orgId, model) => inference.defaultHarness(orgId, model),
      validateSelection: (...args) => inference.validateSelection(...args),
    },
  });
  ctx.onAccessChanged = async () => {
    await conversations!.recheckAccess();
    await recheckLibrary(ctx);
  };
  await registerConversations(app, ctx, conversations);
  const handlers: Record<string, JobHandler> = {
    "project.provision": {
      replaySafe: true,
      async run({ job }) {
        const project = await db.get<{
          id: string;
          org_id: string;
          status: string;
        }>("SELECT id,org_id,status FROM projects WHERE id=?", [
          job.projectId!,
        ]);
        if (!project || project.status !== "provisioning") return;
        await ensureRoot(ctx, { orgId: project.org_id, projectId: project.id });
      },
    },
    "project.remove": {
      replaySafe: true,
      async run() {
        await conversations!.recheckAccess();
        await recheckLibrary(ctx);
      },
    },
  };
  if (options.mail)
    handlers["invitation.deliver"] = {
      replaySafe: false,
      async run({ job, signal }) {
        const p = job.payload;
        const valid = await db.get(
          "SELECT id FROM invitations WHERE id=? AND accepted_at IS NULL AND expires_at>?",
          [String(p.invitationId), new Date().toISOString()],
        );
        if (!valid) return;
        await sendInvitation(
          options.mail!,
          {
            email: String(p.email),
            name: String(p.name ?? ""),
            activationUrl: String(p.activationUrl),
          },
          signal,
        );
      },
    };
  if (options.mail)
    handlers["password_reset.deliver"] = {
      replaySafe: false,
      async run({ job, signal }) {
        const p = job.payload;
        const valid = await db.get(
          "SELECT id FROM password_reset_tokens WHERE id=? AND used_at IS NULL AND expires_at>?",
          [String(p.resetId), new Date().toISOString()],
        );
        if (!valid) return;
        await sendPasswordReset(
          options.mail!,
          {
            email: String(p.email),
            name: String(p.name ?? ""),
            resetUrl: String(p.resetUrl),
          },
          signal,
        );
      },
    };
  const jobs = createJobWorker(ctx, handlers);
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => {
    await db.get("SELECT 1");
    return {
      status: "ready",
      runtime: options.runtime ? "configured" : "unconfigured",
    };
  });
  const webRoot = options.webRoot ?? resolve("platform/apps/web/dist");
  if (existsSync(join(webRoot, "index.html"))) {
    await app.register(staticFiles, {
      root: webRoot,
      wildcard: false,
      index: false,
      cacheControl: true,
      maxAge: "1h",
    });
    app.get("/", async (_request, reply) =>
      reply.header("cache-control", "no-cache").sendFile("index.html"),
    );
    app.setNotFoundHandler(async (request, reply) => {
      if (
        portalHosts.test(request.headers.host ?? "") &&
        request.method === "GET" &&
        !request.url.startsWith("/api/") &&
        !request.url.startsWith("/share/")
      )
        return reply.header("cache-control", "no-cache").sendFile("index.html");
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "Not found" } });
    });
  }
  app.addHook("onClose", async () => {
    await jobs.stop();
    await conversations!.close();
    if (!options.database) await db.close();
  });
  try {
    await app.ready();
    if (options.startConversations !== false) await conversations.start();
    if (options.jobs !== false) jobs.start();
  } catch (error) {
    await app.close();
    throw error;
  }
  return { app, ctx, conversations, inference, jobs };
}
