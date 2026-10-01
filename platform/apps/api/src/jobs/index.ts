import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AppError, type AppContext, type User } from "../context.js";
import type { Statement } from "../db/index.js";
export interface Job {
  id: string;
  orgId: string | null;
  projectId: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  availableAt: string;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  leaseToken: string | null;
}
export interface NewJob {
  orgId?: string | null;
  projectId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  availableAt?: string;
}
export function jobStatement(input: NewJob): {
  id: string;
  statement: Statement;
} {
  const id = randomUUID();
  const now = new Date().toISOString();
  return {
    id,
    statement: {
      sql: "INSERT INTO jobs (id,org_id,project_id,type,payload,status,attempts,available_at,created_at,updated_at,idempotency_key) VALUES (?,?,?,?,?,'pending',0,?,?,?,?)",
      params: [
        id,
        input.orgId ?? null,
        input.projectId ?? null,
        input.type,
        JSON.stringify(input.payload ?? {}),
        input.availableAt ?? now,
        now,
        now,
        input.idempotencyKey ?? null,
      ],
    },
  };
}
function mapJob(r: any): Job {
  return {
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id,
    type: r.type,
    payload: JSON.parse(r.payload),
    status: r.status,
    attempts: r.attempts,
    availableAt: r.available_at,
    leaseUntil: r.lease_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    error: r.error,
    leaseToken: r.lease_token,
  };
}
export class JobQueue {
  constructor(private ctx: AppContext) {}
  async enqueue(input: NewJob): Promise<string> {
    if (input.idempotencyKey) {
      const existing = await this.ctx.db.get<any>(
        "SELECT id FROM jobs WHERE org_id IS ? AND type=? AND idempotency_key=?",
        [input.orgId ?? null, input.type, input.idempotencyKey],
      );
      if (existing) return existing.id;
    }
    const next = jobStatement(input);
    try {
      await this.ctx.db.run(next.statement.sql, next.statement.params);
    } catch (error) {
      if (input.idempotencyKey) {
        const existing = await this.ctx.db.get<any>(
          "SELECT id FROM jobs WHERE org_id IS ? AND type=? AND idempotency_key=?",
          [input.orgId ?? null, input.type, input.idempotencyKey],
        );
        if (existing) return existing.id;
      }
      throw error;
    }
    return next.id;
  }
  async get(id: string): Promise<Job | undefined> {
    const row = await this.ctx.db.get("SELECT * FROM jobs WHERE id=?", [id]);
    return row ? mapJob(row) : undefined;
  }
}
export interface JobHandler {
  replaySafe: boolean;
  run(input: { job: Job; ctx: AppContext; signal: AbortSignal }): Promise<void>;
}
export interface JobWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<boolean>;
}
export function createJobWorker(
  ctx: AppContext,
  handlers: Record<string, JobHandler>,
  options: { pollMs?: number; leaseMs?: number; maxAttempts?: number } = {},
): JobWorker {
  const leaseMs = Math.max(options.leaseMs ?? 60_000, 100);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<boolean> | undefined;
  let abort: AbortController | undefined;
  async function run(): Promise<boolean> {
    const now = new Date().toISOString();
    const expired = await ctx.db.all<any>(
      "SELECT id,type,attempts,project_id FROM jobs WHERE status='running' AND lease_until<?",
      [now],
    );
    for (const job of expired) {
      const canRetry =
        handlers[job.type]?.replaySafe &&
        job.attempts < (options.maxAttempts ?? 3);
      const expiredStatements: Statement[] = [
        {
          sql: "UPDATE jobs SET status=?,error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND lease_until<?",
          params: [
            canRetry ? "pending" : "needs_attention",
            canRetry
              ? "Worker interrupted; retrying idempotent operation"
              : "Execution was interrupted; inspect the result before retrying",
            now,
            job.id,
            now,
          ],
          expectChanges: 1,
        },
      ];
      if (!canRetry && job.type === "project.provision" && job.project_id)
        expiredStatements.push({
          sql: "UPDATE projects SET status='needs_attention' WHERE id=? AND status='provisioning'",
          params: [job.project_id],
        });
      try {
        await ctx.db.batch(expiredStatements);
      } catch (error) {
        if ((error as Error).message !== "Concurrent update conflict")
          throw error;
      }
    }
    const row = await ctx.db.get<any>(
      "SELECT * FROM jobs WHERE status='pending' AND available_at<=? ORDER BY available_at,created_at LIMIT 1",
      [now],
    );
    if (!row) return false;
    const leaseToken = randomUUID();
    const until = new Date(Date.now() + leaseMs).toISOString();
    const claim = await ctx.db.run(
      "UPDATE jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status='pending'",
      [leaseToken, until, now, row.id],
    );
    if (!claim.changes) return true;
    const handler = handlers[row.type];
    if (!handler) {
      const unavailable: Statement[] = [
        {
          sql: "UPDATE jobs SET status='needs_attention',error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?",
          params: ["This operation is not configured", now, row.id, leaseToken],
          expectChanges: 1,
        },
      ];
      if (row.type === "project.provision" && row.project_id)
        unavailable.push({
          sql: "UPDATE projects SET status='needs_attention' WHERE id=? AND status='provisioning'",
          params: [row.project_id],
        });
      await ctx.db.batch(unavailable);
      return true;
    }
    const job = mapJob({
      ...row,
      status: "running",
      attempts: row.attempts + 1,
      lease_token: leaseToken,
      lease_until: until,
    });
    const controller = new AbortController();
    abort = controller;
    let renewing = false;
    let leaseLost = false;
    const heartbeat = setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        void ctx.db
          .run(
            "UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND lease_token=?",
            [
              new Date(Date.now() + leaseMs).toISOString(),
              new Date().toISOString(),
              job.id,
              leaseToken,
            ],
          )
          .then((result) => {
            if (!result.changes) {
              leaseLost = true;
              controller.abort();
            }
          })
          .catch(() => {
            leaseLost = true;
            controller.abort();
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(25, Math.floor(leaseMs / 3)),
    );
    heartbeat.unref();
    try {
      await handler.run({ job, ctx, signal: controller.signal });
      if (leaseLost || controller.signal.aborted)
        throw new Error("Execution interrupted");
      const statements: Statement[] = [
        {
          sql: "UPDATE jobs SET status='succeeded',error=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='running'",
          params: [new Date().toISOString(), job.id, leaseToken],
          expectChanges: 1,
        },
      ];
      if (job.projectId && job.type === "project.provision")
        statements.push({
          sql: "UPDATE projects SET status='ready' WHERE id=? AND status='provisioning'",
          params: [job.projectId],
        });
      if (job.projectId && job.type === "project.remove")
        statements.push({
          sql: "UPDATE projects SET status='deleted' WHERE id=? AND status='deleting'",
          params: [job.projectId],
        });
      await ctx.db.batch(statements);
    } catch {
      const retry =
        handler.replaySafe && job.attempts < (options.maxAttempts ?? 3);
      const failed: Statement[] = [
        {
          sql: "UPDATE jobs SET status=?,error=?,available_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='running'",
          params: [
            retry ? "pending" : "needs_attention",
            retry
              ? "Operation failed; scheduled for retry"
              : "Operation did not complete. Administrator attention required",
            new Date(
              Date.now() + Math.min(60_000, 1000 * 2 ** job.attempts),
            ).toISOString(),
            new Date().toISOString(),
            job.id,
            leaseToken,
          ],
          expectChanges: 1,
        },
      ];
      if (!retry && job.type === "project.provision" && job.projectId)
        failed.push({
          sql: "UPDATE projects SET status='needs_attention' WHERE id=? AND status='provisioning'",
          params: [job.projectId],
        });
      try {
        await ctx.db.batch(failed);
      } catch (error) {
        if ((error as Error).message !== "Concurrent update conflict")
          throw error;
      }
    } finally {
      clearInterval(heartbeat);
      if (abort === controller) abort = undefined;
    }
    return true;
  }
  const runOnce = (): Promise<boolean> => {
    if (active) return active;
    active = run().finally(() => {
      active = undefined;
    });
    return active;
  };
  const tick = () => {
    if (stopped) return;
    void runOnce()
      .catch(() => {})
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(tick, options.pollMs ?? 1000);
          timer.unref();
        }
      });
  };
  return {
    start() {
      if (timer || active) return;
      stopped = false;
      tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      abort?.abort();
      await active;
    },
    runOnce,
  };
}
export async function retryProvisioning(
  ctx: AppContext,
  user: User,
  projectId: string,
) {
  const project = await ctx.requireProject(user, projectId);
  await ctx.requireOrgAdmin(user, project.orgId);
  const job = await ctx.db.get<any>(
    "SELECT * FROM jobs WHERE project_id=? AND type='project.provision' ORDER BY created_at DESC LIMIT 1",
    [projectId],
  );
  if (!job) throw new AppError(404, "not_found", "Provisioning job not found");
  if (
    project.status === "provisioning" &&
    ["pending", "running"].includes(job.status)
  )
    return { jobId: job.id, status: "provisioning" };
  if (
    project.status !== "needs_attention" ||
    !["needs_attention", "failed"].includes(job.status)
  )
    throw new AppError(
      409,
      "retry_unavailable",
      "This project does not need setup retried",
    );
  const now = new Date().toISOString();
  await ctx.db.batch([
    {
      sql: "UPDATE jobs SET status='pending',attempts=0,available_at=?,updated_at=?,lease_token=NULL,lease_until=NULL,error=NULL WHERE id=? AND status IN ('needs_attention','failed')",
      params: [now, now, job.id],
      expectChanges: 1,
    },
    {
      sql: "UPDATE projects SET status='provisioning' WHERE id=? AND status='needs_attention'",
      params: [projectId],
      expectChanges: 1,
    },
  ]);
  await ctx.audit(user, "project.provisioning_retried", projectId);
  return { jobId: job.id, status: "provisioning" };
}
export async function registerJobs(app: FastifyInstance, ctx: AppContext) {
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/retry",
    async (request, reply) => {
      const result = await retryProvisioning(
        ctx,
        await ctx.requireUser(request),
        request.params.projectId,
      );
      reply.code(202);
      return result;
    },
  );
  app.post<{ Params: { jobId: string } }>(
    "/api/jobs/:jobId/retry",
    async (request, reply) => {
      const user = await ctx.requireUser(request);
      const job = await new JobQueue(ctx).get(request.params.jobId);
      if (!job?.orgId) throw new AppError(404, "not_found", "Job not found");
      await ctx.requireOrgAdmin(user, job.orgId);
      if (job.type !== "project.provision" || !job.projectId)
        throw new AppError(
          409,
          "unsafe_retry",
          "This operation cannot be replayed automatically",
        );
      const result = await retryProvisioning(ctx, user, job.projectId);
      reply.code(202);
      return result;
    },
  );
  app.get<{ Params: { jobId: string } }>(
    "/api/jobs/:jobId",
    async (request) => {
      const user = await ctx.requireUser(request);
      const job = await new JobQueue(ctx).get(request.params.jobId);
      if (!job || !job.orgId)
        throw new AppError(404, "not_found", "Job not found");
      await ctx.requireOrgAdmin(user, job.orgId);
      const { payload, leaseToken, ...metadata } = job;
      return metadata;
    },
  );
}
