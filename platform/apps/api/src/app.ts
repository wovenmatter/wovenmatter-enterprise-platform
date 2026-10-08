import { AssetAgentService } from "./assets/service.js";
import { migrateAssetAgents } from "./assets/schema.js";
import { registerAssetAgents } from "./assets/index.js";
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
import { projectRuntimeSpec } from "./projects/runtime.js";
import {
  purgeExpiredProject,
  withProjectLifecycle,
  requireProjectRuntime,
} from "./projects/trash.js";
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
import { registerReports } from "./library/reports.js";
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
  await mkdir(config.stateDir, {
    recursive: true,
    mode: 0o700,
  });
  const db =
    options.database ??
    (await createDatabase(join(config.stateDir, "control", "platform.sqlite")));
  await migrateFoundation(db);
  const ctx = createContext(db, config);
  ctx.runtime = options.runtime;
  const app = Fastify({
    bodyLimit: 48 * 1024 * 1024,
    trustProxy: false,
    logController: new LogController({
      disableRequestLogging: true,
    }),
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
  // Every route, including safe reports, belongs to the configured portal host.
  app.addHook("onRoute", (route) => {
    if (!route.constraints?.host)
      route.constraints = {
        ...route.constraints,
        host: portalHosts,
      };
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
      request.log.error(
        {
          code,
          requestId: request.id,
        },
        "Request failed",
      );
    if (!reply.sent)
      reply.code(status).header("cache-control", "no-store").send({
        error: {
          code,
          message,
        },
      });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    if (
      portalHosts.test(request.headers.host ?? "") &&
      !request.routeOptions.config.safeReport
    ) {
      reply
        .header("referrer-policy", "no-referrer")
        .header("x-frame-options", "DENY")
        .header(
          "permissions-policy",
          "camera=(), microphone=(), geolocation=()",
        );
      reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
  const assetAgents = new AssetAgentService(
    ctx,
    options.runtime ?? unavailableRuntime,
    () => conversations!,
  );
  await registerReports(app, ctx, { removed: (id) => assetAgents.removed(id) });
  await migrateAssetAgents(ctx);
  await registerInferenceRoutes(app, ctx, inference);
  conversations = await createConversationService(ctx, {
    assets: assetAgents,
    runtime: options.runtime ?? unavailableRuntime,
    files: {
      resolveProjectMounts: (ctx, user, projectId, mode) =>
        resolveProjectMounts(ctx, user, projectId, mode, true),
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
      resolvePiModel: (orgId, model) => inference.resolvePiModel(orgId, model),
      defaultHarness: (orgId, model) => inference.defaultHarness(orgId, model),
      validateSelection: (...args) => inference.validateSelection(...args),
    },
  });
  let accessSyncPending = false;
  let accessSyncRevision = 0;
  let accessSyncLane = Promise.resolve();
  ctx.onAccessChanged = () => {
    const revision = ++accessSyncRevision;
    accessSyncPending = true;
    // Serialize the authoritative read as well as dispatch. Otherwise a slow
    // older read can restore a share after a newer revocation has returned.
    const operation = accessSyncLane
      .catch(() => {})
      .then(async () => {
        await conversations!.recheckAccess();
        const assetCleanup = assetAgents.maintenance().then(
          () => undefined,
          (error) => error,
        );
        if (options.runtime?.updateProject) {
          const projects = await db.all<{
            id: string;
            org_id: string;
            host_id: string;
          }>("SELECT id,org_id,host_id FROM projects WHERE status<>'purged'");
          // Wait for every revoked schedule mount to stop before acknowledging access changes.
          const results = await Promise.allSettled(
            projects.map((p) =>
              withProjectLifecycle(ctx, p.id, async () => {
                // Provision and restore share this lock. Re-read after either finishes,
                // including projects that were still deleted when this sync was queued.
                const current = await db.get<{
                  status: string;
                }>("SELECT status FROM projects WHERE id=?", [p.id]);
                if (
                  !current ||
                  !["ready", "provisioning"].includes(current.status)
                )
                  return;
                let spec;
                try {
                  spec = await projectRuntimeSpec(ctx, p.id);
                } catch (e) {
                  await options.runtime!.updateProject!({
                    projectId: p.id,
                    organizationId: p.org_id,
                    hostId: p.host_id,
                    scheduleEnabled: false,
                    scheduleMounts: [],
                  });
                  throw e;
                }
                await options.runtime!.updateProject!(spec);
              }),
            ),
          );
          const failed = results.find((r) => r.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        }
        await inference.recheckOAuthAccess();
        const assetFailure = await assetCleanup;
        if (assetFailure) throw assetFailure;
        if (revision === accessSyncRevision) accessSyncPending = false;
      });
    accessSyncLane = operation;
    return operation;
  };
  await registerConversations(app, ctx, conversations);
  await registerAssetAgents(app, ctx, assetAgents, inference);
  const handlers: Record<string, JobHandler> = {
    "project.provision": {
      replaySafe: true,
      async run({ job }) {
        return withProjectLifecycle(ctx, job.projectId!, async () => {
          const project = await db.get<{
            id: string;
            org_id: string;
            status: string;
            host_id: string;
          }>("SELECT id,org_id,status,host_id FROM projects WHERE id=?", [
            job.projectId!,
          ]);
          if (!project || project.status !== "provisioning") return;
          await ensureRoot(ctx, {
            orgId: project.org_id,
            projectId: project.id,
          });
          if (!options.runtime?.ensureProject)
            throw new AppError(
              503,
              "runtime_unavailable",
              "Project runtime provisioning is not configured.",
            );
          await options.runtime.ensureProject(
            await projectRuntimeSpec(ctx, project.id),
          );
        });
      },
    },
    "project.remove": {
      replaySafe: true,
      async run({ job }) {
        await withProjectLifecycle(ctx, job.projectId!, async () => {
          const project = await db.get<any>(
            "SELECT * FROM projects WHERE id=? AND status='deleting'",
            [job.projectId!],
          );
          if (project)
            await requireProjectRuntime(
              ctx,
              "stopProject",
            )({
              projectId: project.id,
              organizationId: project.org_id,
              hostId: project.host_id,
            });
          await conversations!.recheckAccess();
        });
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
  app.get("/enterprise/healthz", async () => ({
    status: "ok",
  }));
  app.get("/enterprise/readyz", async () => {
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
      prefix: "/enterprise/",
      wildcard: false,
      index: false,
      cacheControl: true,
      maxAge: "1h",
    });
    for (const route of ["/enterprise", "/enterprise/"])
      app.get(route, async (_request, reply) =>
        reply.header("cache-control", "no-cache").sendFile("index.html"),
      );
    app.setNotFoundHandler(async (request, reply) => {
      if (
        portalHosts.test(request.headers.host ?? "") &&
        request.method === "GET" &&
        /^\/enterprise\/(?:login|organizations|projects|personal-settings|activate|forgot-password|reset-password)(?:[/?]|$)/.test(
          request.url,
        )
      )
        return reply.header("cache-control", "no-cache").sendFile("index.html");
      return reply.code(404).send({
        error: {
          code: "not_found",
          message: "Not found",
        },
      });
    });
  }
  let accessRetry: Promise<void> | undefined;
  const accessTimer = setInterval(() => {
    if (accessSyncPending && !accessRetry)
      accessRetry = ctx.onAccessChanged!()
        .catch(() => {})
        .finally(() => {
          accessRetry = undefined;
        });
  }, 5000);
  accessTimer.unref();
  let purging: Promise<void> | undefined;
  const purgeTimer = setInterval(() => {
    if (purging) return;
    purging = (async () => {
      for (const row of await db.all<{
        id: string;
      }>(
        "SELECT id FROM projects WHERE status IN ('deleted','deleting') AND purge_after<=?",
        [new Date().toISOString()],
      ))
        await purgeExpiredProject(ctx, row.id);
    })()
      .catch(() => {})
      .finally(() => {
        purging = undefined;
      });
  }, 60000);
  purgeTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(purgeTimer);
    clearInterval(accessTimer);
    await accessRetry;
    await purging;
    await jobs.stop();
    await accessSyncLane.catch(() => {});
    await conversations!.close();
    if (!options.database) await db.close();
  });
  try {
    await app.ready();
    if (options.startConversations !== false) {
      await conversations.start();
      await ctx.onAccessChanged();
    }
    if (options.jobs !== false) jobs.start();
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    app,
    ctx,
    conversations,
    assetAgents,
    inference,
    jobs,
  };
}
