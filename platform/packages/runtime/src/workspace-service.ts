import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  RuntimeError,
  type RuntimeRequest,
  type RuntimeEvent,
  type SteeringInput,
} from "./types.js";
import { identity, MAX_LINE, MAX_OUTPUT, validateEvent } from "./validation.js";

export interface WorkspaceWorker {
  processId?: number;
  turn(
    request: RuntimeRequest,
    emit: (event: RuntimeEvent) => Promise<void>,
  ): Promise<void>;
  steer(input: SteeringInput): Promise<void>;
  /** Resolves only after the namespace and all descendants have gone. */
  stop(): Promise<void>;
  closed: Promise<void>;
}
type InputReceipt = {
  hash: string;
  state: "pending" | "accepted" | "rejected" | "uncertain";
  code?: string;
};
type Run = {
  id: string;
  conversationId: string;
  sessionKey: string;
  generation: number;
  fingerprint: string;
  terminal: boolean;
  cursor: number;
  acknowledged?: number;
  expired?: boolean;
  inputs: Record<string, InputReceipt>;
  lastInput: number;
  bytes: number;
  attachment?: string;
};
type Session = {
  key: string;
  conversationId: string;
  generation: number;
  signature: string;
  users: Set<string>;
  worker: WorkspaceWorker;
  active?: string;
  settled?: Promise<void>;
  stopped: boolean;
};
const terminal = (event: RuntimeEvent) =>
  ["completed", "cancelled", "failed"].includes(event.type);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = (code: string) =>
  new RuntimeError(code, "The workspace cannot complete this operation.");

/** Trusted workspace owner. Attachments never own processes. Files live outside agent mounts. */
export class WorkspaceService {
  private runs = new Map<string, Run>();
  private sessions = new Map<string, Session>();
  private fences = new Map<string, number>();
  private lanes = new Map<string, Promise<unknown>>();
  private deliveries = new Map<string, Promise<void>>();
  private waiters = new Map<string, Set<() => void>>();
  private closing = false;
  private closeTask?: Promise<void>;
  private db!: DatabaseSync;
  constructor(
    private directory: string,
    private launch: (
      request: RuntimeRequest,
      key: string,
    ) => Promise<WorkspaceWorker>,
    private limits = {
      replayBytes: 256 * 1024 * 1024,
      retentionMs: 30 * 86400000,
    },
  ) {}
  private lane<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.lanes.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(action);
    this.lanes.set(id, next);
    void next
      .finally(() => {
        if (this.lanes.get(id) === next) this.lanes.delete(id);
      })
      .catch(() => {});
    return next;
  }
  private async saveRun(run: Run) {
    const { attachment, ...record } = run;
    this.db
      .prepare(
        "INSERT INTO runs(id,conversation,terminal,bytes,created,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET terminal=excluded.terminal,bytes=excluded.bytes,data=excluded.data",
      )
      .run(
        run.id,
        run.conversationId,
        Number(run.terminal),
        run.bytes,
        Date.now(),
        JSON.stringify(record),
      );
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.directory, "workspace.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,conversation TEXT NOT NULL,terminal INTEGER NOT NULL,bytes INTEGER NOT NULL,created INTEGER NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS running_thread ON runs(conversation,terminal);
CREATE TABLE IF NOT EXISTS events(run TEXT NOT NULL REFERENCES runs(id),sequence INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(run,sequence));
CREATE TABLE IF NOT EXISTS fences(conversation TEXT PRIMARY KEY,generation INTEGER NOT NULL);
`);
    for (const row of this.db
      .prepare("SELECT conversation,generation FROM fences")
      .all())
      this.fences.set(String(row.conversation), Number(row.generation));
    // SQLite commits the event and terminal metadata together; a torn write cannot discard earlier receipts.
    for (const row of this.db
      .prepare("SELECT id FROM runs WHERE terminal=0")
      .all()) {
      const run = this.run(String(row.id));
      for (const receipt of Object.values(run.inputs))
        if (receipt.state === "pending") receipt.state = "uncertain";
      await this.record(run, {
        type: "failed",
        code: "workspace_restarted",
        message:
          "The workspace restarted. Live work was interrupted and was not replayed.",
      });
    }
    this.prune();
  }
  private prune(reserve = 0) {
    // Only an API database commit acknowledges output. A socket write never does.
    const rows = this.db
      .prepare(
        "SELECT id,bytes,created,data FROM runs WHERE terminal=1 AND bytes>0 ORDER BY created,id",
      )
      .iterate();
    let bytes = Number(
      this.db
        .prepare(
          "SELECT COALESCE(SUM(bytes),0) AS bytes FROM runs WHERE terminal=1",
        )
        .get()!.bytes,
    );
    for (const row of rows) {
      if (
        bytes + reserve <= this.limits.replayBytes &&
        Number(row.created) >= Date.now() - this.limits.retentionMs
      )
        break;
      const run = JSON.parse(String(row.data)) as Run;
      if ((run.acknowledged ?? 0) < run.cursor) continue;
      run.bytes = 0;
      run.expired = true;
      run.inputs = {};
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("DELETE FROM events WHERE run=?").run(run.id);
        this.db
          .prepare("UPDATE runs SET bytes=0,data=? WHERE id=?")
          .run(JSON.stringify(run), run.id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      const cached = this.runs.get(run.id);
      if (cached)
        Object.assign(cached, { bytes: 0, expired: true, inputs: {} });
      bytes -= Number(row.bytes);
    }
    // Only bounded replay pages are materialized. Completed metadata is loaded lazily from SQLite.
    const active = new Set(
      [...this.sessions.values()].map((session) => session.active),
    );
    for (const [id, run] of this.runs)
      if (
        this.runs.size > this.sessions.size + 64 &&
        run.terminal &&
        !active.has(id)
      )
        this.runs.delete(id);
  }
  private async record(run: Run, input: RuntimeEvent) {
    if (run.terminal) return;
    const event = { ...validateEvent(input), sequence: run.cursor + 1 },
      line = JSON.stringify(event);
    if (Buffer.byteLength(line) > MAX_LINE - 4096)
      throw failure("output_limit");
    this.prune(Buffer.byteLength(line));
    if (run.bytes + Buffer.byteLength(line) > MAX_OUTPUT && !terminal(event))
      throw failure("output_limit");
    if (
      !terminal(event) &&
      Number(
        this.db
          .prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM runs")
          .get()!.bytes,
      ) +
        Buffer.byteLength(line) >
        this.limits.replayBytes
    )
      throw failure("journal_full");
    const next = {
      ...run,
      cursor: event.sequence,
      bytes: run.bytes + Buffer.byteLength(line),
      terminal: terminal(event),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO events(run,sequence,data) VALUES(?,?,?)")
        .run(run.id, event.sequence, line);
      // saveRun is synchronous before its resolved Promise; no other work may interleave this transaction.
      const { attachment, ...data } = next;
      this.db
        .prepare("UPDATE runs SET terminal=?,bytes=?,data=? WHERE id=?")
        .run(Number(next.terminal), next.bytes, JSON.stringify(data), run.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    Object.assign(run, next);
    for (const wake of this.waiters.get(run.id) ?? []) wake();
    if (run.terminal) this.prune();
  }
  async admit(request: RuntimeRequest) {
    identity(request.runId);
    identity(request.conversationId);
    const generation = request.generation ?? 0;
    if (!Number.isSafeInteger(generation) || generation < 0)
      throw failure("invalid_generation");
    const signature = digest([request.mounts, request.access, request.assetId]);
    const sessionKey = digest([
      request.conversationId,
      request.harness,
      request.access,
      generation,
    ]);
    const fingerprint = digest([
      request.projectId,
      request.organizationId,
      request.conversationId,
      request.harness,
      request.model,
      request.connectionId,
      request.access,
      request.prompt,
      request.resumeId,
      request.pi,
      request.gateway,
      request.egressProxyUrl,
      generation,
      request.userId,
      request.assetId,
      request.workspaceLease,
    ]);
    const pending = await this.lane(
      request.conversationId,
      async (): Promise<{ settled?: Promise<void> }> => {
        if (
          this.closing ||
          generation < (this.fences.get(request.conversationId) ?? 0)
        )
          throw failure("authority_revoked");
        const previous = this.db
          .prepare("SELECT 1 FROM runs WHERE id=?")
          .get(request.runId)
          ? this.run(request.runId)
          : undefined;
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw failure("request_conflict");
          return {}; // An accepted identity is never dispatched twice, even after interruption.
        }
        if (
          this.db
            .prepare("SELECT 1 FROM runs WHERE conversation=? AND terminal=0")
            .get(request.conversationId)
        )
          throw failure("thread_busy");
        const settling = [...this.sessions.values()].find(
          (value) =>
            value.conversationId === request.conversationId && value.active,
        );
        if (settling) return { settled: settling.settled };
        this.prune(1);
        if (
          Number(
            this.db
              .prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM runs")
              .get()!.bytes,
          ) >= this.limits.replayBytes
        )
          throw failure("journal_full");
        const previousOwner = [...this.sessions.values()].find(
          (value) => value.conversationId === request.conversationId,
        );
        if (previousOwner?.stopped) throw failure("session_stopping");
        if (previousOwner && previousOwner.key !== sessionKey)
          throw failure("authority_changed");
        let session = this.sessions.get(sessionKey);
        if (session && session.signature !== signature)
          throw failure("authority_changed");
        if (!session) {
          if (this.sessions.size >= 128) throw failure("session_capacity");
          const worker = await this.launch(request, sessionKey);
          session = {
            key: sessionKey,
            conversationId: request.conversationId,
            generation,
            signature,
            users: new Set(),
            worker,
            stopped: false,
          };
          this.sessions.set(sessionKey, session);
          const owned = session;
          void worker.closed
            .then(() =>
              this.lane(owned.conversationId, async () => {
                const cancelled = owned.stopped;
                owned.stopped = true;
                this.sessions.delete(owned.key);
                if (owned.active) {
                  const run = this.run(owned.active);
                  await this.record(
                    run,
                    cancelled
                      ? { type: "cancelled" }
                      : {
                          type: "failed",
                          code: "session_stopped",
                          message:
                            "The native environment stopped; work was not replayed.",
                        },
                  );
                }
              }),
            )
            .catch(() => {});
        }
        const run: Run = {
          id: request.runId,
          conversationId: request.conversationId,
          sessionKey,
          generation,
          fingerprint,
          terminal: false,
          cursor: 0,
          inputs: {},
          lastInput: -1,
          bytes: 0,
        };
        await this.saveRun(run); // Durable admission precedes the native write.
        this.runs.set(run.id, run);
        session.users.add(request.userId ?? request.conversationId);
        session.active = run.id;
        const owned = session;
        const write = (event: RuntimeEvent) =>
          this.lane(run.conversationId, () => this.record(run, event));
        // Never await inference completion while holding the admission lane.
        owned.settled = owned.worker
          .turn(request, write)
          .catch(async (error) => {
            await write({
              type: "failed",
              code: error instanceof RuntimeError ? error.code : "agent_failed",
              message:
                "The agent stopped without a confirmed result. Work was not replayed.",
            });
          })
          .finally(() =>
            this.lane(run.conversationId, async () => {
              if (!run.terminal)
                await this.record(run, {
                  type: "failed",
                  code: "outcome_uncertain",
                  message: "The agent did not confirm completion.",
                });
              if (owned.active === run.id) owned.active = undefined;
            }),
          )
          .catch(() => {
            void owned.worker.stop();
          });
        return {};
      },
    );
    // Waiting outside the lane lets final events and steering receipts settle.
    if (pending.settled) {
      await pending.settled;
      await this.admit(request);
    }
  }
  async acknowledge(id: string, cursor: number) {
    const run = this.run(id);
    await this.lane(run.conversationId, async () => {
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > run.cursor)
        throw failure("invalid_cursor");
      run.acknowledged = Math.max(run.acknowledged ?? 0, cursor);
      await this.saveRun(run);
      this.prune();
    });
  }
  async attach(id: string) {
    const run = this.run(id);
    return this.lane(run.conversationId, async () => {
      run.attachment = randomUUID();
      return {
        attachment: run.attachment,
        terminal: run.terminal,
        cursor: run.cursor,
      };
    });
  }
  private run(id: string) {
    identity(id);
    let run = this.runs.get(id);
    if (!run) {
      const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id);
      if (!row) throw failure("run_missing");
      run = JSON.parse(String(row.data)) as Run;
      this.runs.set(id, run);
    }
    return run;
  }
  async poll(id: string, after: number, waitMs = 0) {
    const run = this.run(id);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      after > run.cursor ||
      !Number.isFinite(waitMs) ||
      waitMs < 0 ||
      waitMs > 10000
    )
      throw failure("invalid_cursor");
    if (run.expired && after < run.cursor) throw failure("replay_expired");
    if (after === run.cursor && !run.terminal && waitMs) {
      const waiters = this.waiters.get(id) ?? new Set<() => void>();
      if (waiters.size >= 16) throw failure("attachment_limit");
      this.waiters.set(id, waiters);
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timeout);
          waiters.delete(wake);
          if (!waiters.size) this.waiters.delete(id);
          resolve();
        };
        const timeout = setTimeout(wake, waitMs);
        waiters.add(wake);
      });
    }
    const events: RuntimeEvent[] = [];
    let bytes = 0;
    for (const row of this.db
      .prepare(
        "SELECT data FROM events WHERE run=? AND sequence>? ORDER BY sequence LIMIT 256",
      )
      .iterate(id, after)) {
      const event = JSON.parse(String(row.data)) as RuntimeEvent;
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (bytes > 768 * 1024 && events.length) break;
      events.push(event);
    }
    return {
      events,
      terminal: run.terminal && after + events.length === run.cursor,
    };
  }
  async steer(id: string, attachment: string, input: SteeringInput) {
    const run = this.run(id),
      hash = digest(input),
      key = id + ":" + identity(input.id);
    let delivery: Promise<void> | undefined;
    await this.lane(run.conversationId, async () => {
      if (attachment !== run.attachment) throw failure("attachment_replaced");
      const previous = run.inputs[input.id];
      if (previous) {
        if (previous.hash !== hash) throw failure("request_conflict");
        if (previous.state === "accepted") return;
        delivery = this.deliveries.get(key);
        if (!delivery) throw failure(previous.code ?? "steering_uncertain");
        return;
      }
      const session = this.sessions.get(run.sessionKey);
      if (run.terminal || session?.active !== id || session.stopped)
        throw failure("run_ended");
      if (
        !Number.isSafeInteger(input.sequence) ||
        input.sequence <= run.lastInput ||
        Object.keys(run.inputs).length >= 1024
      )
        throw failure("input_order");
      run.lastInput = input.sequence;
      run.inputs[input.id] = { hash, state: "pending" };
      await this.saveRun(run);
      delivery = session.worker.steer(input).then(
        () =>
          this.lane(run.conversationId, async () => {
            run.inputs[input.id]!.state = "accepted";
            await this.saveRun(run);
          }),
        (error) =>
          this.lane(run.conversationId, async () => {
            const code =
              error instanceof RuntimeError ? error.code : "steering_uncertain";
            run.inputs[input.id] = {
              hash,
              state:
                code === "steering_rejected" || code === "steering_unavailable"
                  ? "rejected"
                  : "uncertain",
              code,
            };
            await this.saveRun(run);
            throw failure(code);
          }),
      );
      this.deliveries.set(key, delivery);
      void delivery.finally(() => this.deliveries.delete(key)).catch(() => {});
    });
    await delivery;
  }
  async stopSession(conversationId: string, generation: number) {
    identity(conversationId);
    if (!Number.isSafeInteger(generation) || generation < 0)
      throw failure("invalid_generation");
    // Persist the fence before touching processes, including when stop must be retried.
    const victims = await this.lane(conversationId, async () => {
      this.fences.set(
        conversationId,
        Math.max(generation, this.fences.get(conversationId) ?? 0),
      );
      this.db
        .prepare(
          "INSERT INTO fences(conversation,generation) VALUES(?,?) ON CONFLICT(conversation) DO UPDATE SET generation=MAX(generation,excluded.generation)",
        )
        .run(conversationId, this.fences.get(conversationId)!);
      const victims = [...this.sessions.values()].filter(
        (session) =>
          session.conversationId === conversationId &&
          session.generation < generation,
      );
      for (const session of victims) session.stopped = true;
      return victims;
    });
    await Promise.all(
      victims.map(async (session) => {
        session.stopped = true;
        await session.worker.stop();
        await this.lane(conversationId, async () => {
          session.stopped = true;
          this.sessions.delete(session.key);
          if (session.active)
            await this.record(this.run(session.active), { type: "cancelled" });
        });
      }),
    );
  }
  async cancel(id: string) {
    const run = this.run(id);
    const session = this.sessions.get(run.sessionKey);
    if (!session) return;
    // Cancels the native environment that owns this run, even if its turn finished.
    session.stopped = true;
    await session.worker.stop();
    await this.lane(run.conversationId, async () => {
      session.stopped = true;
      this.sessions.delete(session.key);
      if (session.active)
        await this.record(this.run(session.active), { type: "cancelled" });
    });
  }
  status() {
    return {
      runIds: [...this.runs.values()]
        .filter((run) => !run.terminal)
        .map((run) => run.id),
      sessions: [...this.sessions.values()].map((session) => ({
        conversationId: session.conversationId,
        generation: session.generation,
        processId: session.worker.processId,
        users: [...session.users],
        activeRun: session.active ?? null,
      })),
    };
  }
  close() {
    return (this.closeTask ??= (async () => {
      this.closing = true;
      await Promise.all(
        [...this.runs.values()]
          .filter((run) => !run.terminal)
          .map((run) =>
            this.lane(run.conversationId, () =>
              this.record(run, {
                type: "failed",
                code: "workspace_restarted",
                message:
                  "The workspace stopped. Live work was interrupted and was not replayed.",
              }),
            ),
          ),
      );
      await Promise.all(
        [...this.sessions.values()].map((session) => session.worker.stop()),
      );
      while (this.lanes.size)
        await Promise.allSettled([...this.lanes.values()]);
      this.db.close();
    })());
  }
}
