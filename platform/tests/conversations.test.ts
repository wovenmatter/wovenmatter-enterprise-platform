import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { createDatabase, migrateFoundation } from "../apps/api/src/db/index.js";
import { createContext, AppError, type User } from "../apps/api/src/context.js";
import {
  createConversationService,
  registerConversations,
} from "../apps/api/src/conversations/index.js";
import type {
  Runtime,
  RuntimeRequest,
  RuntimeEvent,
  EventSink,
} from "@wovenmatter-enterprise/runtime";
import { WorkspaceService } from "../packages/runtime/src/workspace-service.js";
const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function durableRuntime(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "wme-durable-api-")),
    requests: RuntimeRequest[] = [],
    stopped: string[] = [];
  const turns = new Map<string, { emit: EventSink; finish: () => void }>(),
    attachments = new Map<string, string>();
  const workspace = new WorkspaceService(dir, async (request) => {
    let close!: () => void, finish: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    return {
      closed,
      async turn(input, emit) {
        requests.push(input);
        const complete = new Promise<void>((resolve) => {
          finish = resolve;
        });
        turns.set(input.runId, { emit, finish: finish! });
        await emit({ type: "started" });
        await emit({ type: "input_accepted" });
        await emit({
          type: "native_session",
          sessionId: "native-" + input.conversationId,
        });
        await complete;
      },
      async steer() {},
      async stop() {
        stopped.push(request.conversationId);
        finish?.();
        close();
      },
    };
  });
  await workspace.initialize();
  let rejectAck = false;
  const runtime: Runtime = {
    async execute(input, emit, signal) {
      await workspace.admit(input);
      await runtime.attach!(input.runId, 0, emit, signal);
    },
    async attach(id, after, emit, signal) {
      attachments.set(id, (await workspace.attach(id)).attachment);
      await emit({ type: "attached" });
      while (!signal?.aborted) {
        const page = await workspace.poll(id, after, 20);
        for (const event of page.events) {
          signal?.throwIfAborted();
          await emit(event);
          after = event.sequence!;
        }
        if (page.terminal) return;
      }
      signal?.throwIfAborted();
    },
    async acknowledge(id, cursor) {
      if (rejectAck) throw new Error("Synthetic acknowledgment outage");
      await workspace.acknowledge(id, cursor);
    },
    async steer(id, input) {
      await workspace.steer(id, attachments.get(id)!, input);
    },
    async stopSession(_project, id, generation) {
      await workspace.stopSession(id, generation);
    },
    async cancel(id) {
      await workspace.cancel(id);
    },
    async recover() {
      return [];
    },
  };
  t.after(async () => {
    await workspace.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    runtime,
    workspace,
    requests,
    stopped,
    rejectAcks(value: boolean) {
      rejectAck = value;
    },
    async event(id: string, event: RuntimeEvent) {
      await turns.get(id)!.emit(event);
      if (["completed", "failed", "cancelled"].includes(event.type))
        turns.get(id)!.finish();
    },
  };
}
async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await pause();
  }
  throw new Error("Timed out");
}
test("API detach and restart recover service-owned output once, and acknowledge only committed transcript cursors", async (t) => {
  const durable = await durableRuntime(t),
    f = await fixture(t, 20, {}, durable.runtime),
    c = await f.create();
  durable.rejectAcks(true);
  const receipt = await f.service.admit(f.users[0], c.id, {
      content: "Initial request",
      requestId: "durable-initial-request",
    }),
    id = receipt.run!.id;
  await until(() => durable.requests.length === 1);
  await durable.event(id, { type: "assistant_delta", delta: "before " });
  await until(async () =>
    (await f.service.messages(f.users[0], c.id)).items.some(
      (m) => m.content === "before ",
    ),
  );
  await f.service.close();
  assert.equal(durable.stopped.length, 0);
  await durable.event(id, {
    type: "assistant_delta",
    delta: "disconnected result",
  });
  await durable.event(id, { type: "completed" });
  const recovered = await createConversationService(f.ctx, f.deps);
  try {
    durable.rejectAcks(false);
    await recovered.start();
    await until(
      async () =>
        (await recovered.runs(f.users[0], c.id)).items[0].status ===
        "completed",
    );
    const messages = (await recovered.messages(f.users[0], c.id)).items;
    assert.equal(
      messages.find((m) => m.role === "assistant")!.content,
      "before disconnected result",
    );
    assert.equal(
      durable.requests.length,
      1,
      "reattach must not redispatch accepted input",
    );
    await until(async () => {
      const row = await f.db.get<any>(
        "SELECT runtime_cursor,runtime_ack FROM conversation_runs WHERE id=?",
        [id],
      );
      return row.runtime_ack === row.runtime_cursor && row.runtime_cursor > 0;
    });
    await recovered.cancel(f.users[0], c.id);
    assert.deepEqual(durable.stopped, [c.id]);
    await recovered.admit(f.users[0], c.id, {
      content: "New explicit request",
      requestId: "durable-explicit-next",
    });
    await until(() => durable.requests.length === 2);
    assert.equal(durable.requests[1].resumeId, "native-" + c.id);
    assert.equal(durable.requests[1].generation, 1);
  } finally {
    await recovered.close();
  }
});

test("revocation stops idle background ownership, preserves siblings, and does not depend on gateway deletion succeeding", async (t) => {
  const durable = await durableRuntime(t),
    f = await fixture(t, 100000, {}, durable.runtime);
  const first = await f.create(f.users[0], "write"),
    sibling = await f.create(f.users[1], "write");
  for (const [user, thread] of [
    [f.users[0], first],
    [f.users[1], sibling],
  ] as const) {
    const receipt = await f.service.admit(user, thread.id, {
      content: "Start background work",
      requestId: "background-" + thread.id,
    });
    await until(() =>
      durable.requests.some((r) => r.runId === receipt.run!.id),
    );
    await durable.event(receipt.run!.id, { type: "completed" });
    await until(
      async () =>
        (await f.service.runs(user, thread.id)).items[0].status === "completed",
    );
  }
  await f.db.run("DELETE FROM project_members WHERE user_id=?", [
    f.users[0].id,
  ]);
  f.deps.inference.revokeGateway = async () => {
    throw new Error("Synthetic gateway cleanup failure");
  };
  await f.service.recheckAccess();
  assert.deepEqual(durable.stopped, [first.id]);
  assert.equal(
    durable.workspace
      .status()
      .sessions.some((s) => s.conversationId === sibling.id),
    true,
  );
  assert.equal(
    (
      await f.db.all(
        "SELECT * FROM conversation_runtime_owners WHERE conversation_id=?",
        [first.id],
      )
    ).length,
    0,
  );
});
class FakeRuntime implements Runtime {
  requests: RuntimeRequest[] = [];
  steers: {
    runId: string;
    input: import("../packages/runtime/src/types.js").SteeringInput;
  }[] = [];
  async steer(
    runId: string,
    input: import("../packages/runtime/src/types.js").SteeringInput,
  ) {
    if (!this.pending.has(runId))
      throw Object.assign(new Error("Ended"), {
        code: "run_ended",
      });
    this.steers.push({
      runId,
      input,
    });
  }
  cancelled: string[] = [];
  recovered = 0;
  pending = new Map<
    string,
    {
      emit: EventSink;
      resolve: () => void;
    }
  >();
  async execute(request: RuntimeRequest, emit: EventSink) {
    this.requests.push(request);
    await emit({
      type: "started",
    });
    await emit({
      type: "input_accepted",
    });
    await emit({
      type: "native_session",
      sessionId: `native-${request.runId}`,
    });
    await new Promise<void>((resolve) =>
      this.pending.set(request.runId, {
        emit,
        resolve,
      }),
    );
  }
  async event(id: string, event: RuntimeEvent) {
    const job = this.pending.get(id);
    assert.ok(job);
    await job.emit(event);
  }
  async complete(id: string) {
    const job = this.pending.get(id);
    assert.ok(job);
    await job.emit({
      type: "completed",
    });
    this.pending.delete(id);
    job.resolve();
  }
  async cancel(id: string) {
    this.cancelled.push(id);
    const job = this.pending.get(id);
    if (job) {
      await job.emit({
        type: "cancelled",
      });
      this.pending.delete(id);
      job.resolve();
    }
  }
  async recover() {
    this.recovered++;
    return [];
  }
}
async function fixture(
  t: any,
  recheckIntervalMs = 100_000,
  limits: Pick<
    import("../apps/api/src/conversations/types.js").ConversationDependencies,
    "maxConcurrentRuns" | "maxConcurrentRunsPerOrganization"
  > = {},
  overrides: Partial<Runtime> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "wme-conversations-")),
    db = await createDatabase(join(dir, "test.sqlite"));
  await migrateFoundation(db);
  const org = randomUUID(),
    otherOrg = randomUUID(),
    project = randomUUID(),
    timestamp = new Date().toISOString();
  await db.batch([
    {
      sql: "INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)",
      params: [org, "Firm", timestamp],
    },
    {
      sql: "INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)",
      params: [otherOrg, "Other", timestamp],
    },
    {
      sql: "INSERT INTO projects(id,org_id,name,description,status,access,created_at) VALUES(?,?,?,?,?,?,?)",
      params: [project, org, "Matter", "", "ready", "write", timestamp],
    },
  ]);
  const users: User[] = [];
  for (const [index, role] of [
    "member",
    "member",
    "member",
    "admin",
    "member",
  ].entries()) {
    const id = randomUUID(),
      orgId = index === 4 ? otherOrg : org;
    await db.run(
      "INSERT INTO users(id,org_id,email,name,role,enabled,created_at) VALUES(?,?,?,?,?,1,?)",
      [
        id,
        orgId,
        `user${index}@test.invalid`,
        `Person ${index}`,
        role,
        timestamp,
      ],
    );
    const user = {
      id,
      orgId,
      email: `user${index}@test.invalid`,
      name: `Person ${index}`,
      role: role as User["role"],
      enabled: true,
      theme: "green" as const,
    };
    users.push(user);
    if (index < 2)
      await db.run("INSERT INTO project_members VALUES(?,?,?,?)", [
        project,
        id,
        "write",
        timestamp,
      ]);
  }
  const ctx = createContext(db, {
    stateDir: dir,
    publicOrigin: "http://localhost",
    host: "127.0.0.1",
    port: 4100,
    secureCookies: false,
  });
  const runtime = Object.assign(new FakeRuntime(), overrides),
    revoked: string[] = [],
    issued: string[] = [],
    mounts = [
      {
        source: "/trusted/project",
        target: "/workspace",
        readOnly: false,
      },
    ];
  const deps = {
    runtime,
    files: {
      async resolveProjectMounts(
        _ctx: any,
        _user: any,
        _project: any,
        mode: string,
      ) {
        return mounts.map((m) => ({
          ...m,
          readOnly: mode === "read" || m.readOnly,
        }));
      },
      async reconcileProjectFiles() {},
    },
    inference: {
      async defaultHarness() {
        return "codex" as const;
      },
      async validateSelection() {},
      async issueGateway(input: { runId: string }) {
        issued.push(input.runId);
        return {
          baseUrl: "http://gateway",
          token: "test-private-token",
        };
      },
      async revokeGateway(id: string) {
        revoked.push(id);
      },
    },
    recheckIntervalMs,
    ...limits,
  };
  const service = await createConversationService(ctx, deps);
  await service.start();
  t.after(async () => {
    await service.close();
    await db.close();
    await rm(dir, {
      recursive: true,
      force: true,
    });
  });
  const create = (user = users[0], mode = "read") =>
    service.create(user, project, {
      title: "Analysis",
      mode,
      model: "gpt-test",
    });
  return {
    db,
    ctx,
    service,
    runtime,
    users,
    org,
    project,
    create,
    mounts,
    revoked,
    issued,
    deps,
  };
}
test("private conversations require current project and thread membership; sharing does not grant project rights", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  assert.equal(c.harness, "codex");
  assert.deepEqual((await f.service.list(f.users[1], f.project)).items, []);
  await assert.rejects(f.service.get(f.users[1], c.id), {
    statusCode: 404,
  });
  await assert.rejects(f.service.get(f.users[3], c.id), {
    statusCode: 404,
  });
  await assert.rejects(f.service.addMember(f.users[0], c.id, f.users[2].id), {
    statusCode: 404,
  });
  await assert.rejects(f.service.addMember(f.users[0], c.id, f.users[4].id), {
    statusCode: 404,
  });
  await f.service.addMember(f.users[0], c.id, f.users[1].id);
  assert.equal((await f.service.list(f.users[1], f.project)).items.length, 1);
  await f.db.run("DELETE FROM project_members WHERE user_id=?", [
    f.users[1].id,
  ]);
  await assert.rejects(f.service.get(f.users[1], c.id), {
    statusCode: 404,
  });
});
test("concurrent duplicate admission is atomic and dispatches once; request IDs cannot be hijacked", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  await f.service.addMember(f.users[0], c.id, f.users[1].id);
  const results = await Promise.all(
    Array.from(
      {
        length: 8,
      },
      () =>
        f.service.admit(f.users[0], c.id, {
          content: "Analyze the raw files",
          requestId: "request-12345678",
        }),
    ),
  );
  assert.equal(new Set(results.map((r) => r.run!.id)).size, 1);
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  await until(() => f.runtime.pending.size === 1);
  assert.equal(f.runtime.requests.length, 1);
  assert.equal((await f.service.messages(f.users[0], c.id)).items.length, 2);
  await assert.rejects(
    f.service.admit(f.users[0], c.id, {
      content: "Different",
      requestId: "request-12345678",
    }),
    {
      code: "request_conflict",
    },
  );
  await assert.rejects(
    f.service.admit(f.users[1], c.id, {
      content: "Analyze the raw files",
      requestId: "request-12345678",
    }),
    {
      code: "request_conflict",
    },
  );
  await f.runtime.event(results[0].run!.id, {
    type: "assistant_delta",
    delta: "Extracted finding",
  });
  await f.runtime.complete(results[0].run!.id);
  await until(
    async () =>
      (await f.service.runs(f.users[0], c.id)).items[0].status === "completed",
  );
  const messages = (await f.service.messages(f.users[1], c.id)).items;
  assert.equal(messages[0].authorName, "Person 0");
  assert.equal(messages[1].content, "Extracted finding");
});
test("active messages steer in server order; idle follow-ups resume persisted native history", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  const first = await f.service.admit(f.users[0], c.id, {
    content: "One",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(first.run!.id));
  const second = await f.service.admit(f.users[0], c.id, {
    content: "Two",
    requestId: randomUUID(),
  });
  assert.equal(second.run!.id, first.run!.id);
  await until(() => f.runtime.steers.length === 1);
  assert.equal(f.runtime.steers[0].input.content, "Two");
  assert.equal(f.runtime.requests.length, 1);
  await f.runtime.complete(first.run!.id);
  f.mounts.push({
    source: "/trusted/new-share",
    target: "/workspace/reference",
    readOnly: true,
  });
  const next = await f.service.admit(f.users[0], c.id, {
    content: "Continue",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(next.run!.id));
  assert.equal(f.runtime.requests[1].resumeId, `native-${first.run!.id}`);
  assert.equal(f.runtime.requests[1].mounts.length, 2);
  await f.runtime.complete(next.run!.id);
});
test("full threads retain their mode and loss of project access cancels active work and inference", async (t) => {
  const f = await fixture(t),
    c = await f.create(f.users[0], "write");
  await f.service.addMember(f.users[0], c.id, f.users[1].id);
  await f.db.run("UPDATE project_members SET access='read' WHERE user_id=?", [
    f.users[1].id,
  ]);
  await assert.rejects(f.create(f.users[1], "write"), {
    code: "read_only",
  });
  const response = await f.service.admit(f.users[0], c.id, {
    content: "Change files",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(response.run!.id));
  assert.equal(
    await f.service.canUseRun({
      orgId: f.org,
      projectId: f.project,
      userId: f.users[0].id,
      runId: response.run!.id,
    }),
    true,
  );
  await f.db.run("DELETE FROM project_members WHERE user_id=?", [
    f.users[0].id,
  ]);
  await f.service.recheckAccess();
  assert.ok(f.runtime.cancelled.includes(response.run!.id));
  assert.ok(f.revoked.includes(response.run!.id));
  assert.equal(
    await f.service.canUseRun({
      orgId: f.org,
      projectId: f.project,
      userId: f.users[0].id,
      runId: response.run!.id,
    }),
    false,
  );
});
test("removing collaborator and unsharing mounts stops the appropriate execution", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  await f.service.addMember(f.users[0], c.id, f.users[1].id);
  const first = await f.service.admit(f.users[1], c.id, {
    content: "Read",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(first.run!.id));
  await assert.rejects(
    f.service.removeMember(f.users[0], c.id, f.users[1].id),
    {
      code: "not_supported",
    },
  );
  await f.db.run("DELETE FROM project_members WHERE user_id=?", [
    f.users[1].id,
  ]);
  await f.service.recheckAccess();
  assert.ok(f.runtime.cancelled.includes(first.run!.id));
  const second = await f.service.admit(f.users[0], c.id, {
    content: "Read",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(second.run!.id));
  f.mounts.push({
    source: "/changed",
    target: "/workspace/shared",
    readOnly: true,
  });
  await f.service.recheckAccess();
  assert.ok(f.runtime.cancelled.includes(second.run!.id));
});
test("cancel queued execution never dispatches it; persisted cursor replay retains terminal events", async (t) => {
  const f = await fixture(t, 100000, {
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerOrganization: 1,
    }),
    blocker = await f.create(),
    c = await f.create();
  const first = await f.service.admit(f.users[0], blocker.id, {
    content: "One",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(first.run!.id));
  const queued = await f.service.admit(f.users[0], c.id, {
    content: "Two",
    requestId: randomUUID(),
  });
  const before = await f.service.events(f.users[0], c.id, 0);
  await f.service.cancel(f.users[0], c.id, queued.run!.id);
  const after = await f.service.events(f.users[0], c.id, before.at(-1)!.id);
  assert.ok(after.some((e) => e.type === "run.cancelled"));
  await f.runtime.complete(first.run!.id);
  await pause(30);
  assert.equal(f.runtime.requests.length, 1);
});
test("restart marks unknown dispatch interrupted and never repeats it", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  const id = randomUUID(),
    mid = randomUUID(),
    aid = randomUUID(),
    stamp = new Date().toISOString();
  await f.db.batch([
    {
      sql: "INSERT INTO conversation_messages(id,conversation_id,run_id,role,author_id,content,created_at) VALUES(?,?,?,?,?,?,?)",
      params: [mid, c.id, id, "user", f.users[0].id, "Before crash", stamp],
    },
    {
      sql: "INSERT INTO conversation_messages(id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?)",
      params: [aid, c.id, id, "assistant", "Partial output", stamp],
    },
    {
      sql: "INSERT INTO conversation_runs(id,conversation_id,org_id,project_id,user_id,request_id,user_message_id,assistant_message_id,status,mode,harness,model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [
        id,
        c.id,
        f.org,
        f.project,
        f.users[0].id,
        randomUUID(),
        mid,
        aid,
        "dispatching",
        "read",
        "codex",
        "gpt-test",
        stamp,
      ],
    },
  ]);
  await f.service.close();
  const service = await createConversationService(f.ctx, f.deps);
  await service.start();
  await service.close();
  assert.equal(
    (await service.runs(f.users[0], c.id)).items[0].status,
    "interrupted",
  );
  assert.equal(f.runtime.requests.length, 0);
  assert.ok(f.revoked.includes(id));
  assert.equal(
    (await service.messages(f.users[0], c.id)).items[1].content,
    "Partial output",
  );
});
test("HTTP routes persist acceptance and report validation/access failures", async (t) => {
  const f = await fixture(t),
    app = Fastify();
  f.ctx.requireUser = async () => f.users[0];
  app.setErrorHandler((error, _r, reply) => {
    const e = error as AppError;
    reply.code(e.statusCode ?? 500).send({
      error: {
        code: e.code,
        message: e.message,
      },
    });
  });
  await registerConversations(app, f.ctx, f.service);
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: `/enterprise/api/projects/${f.project}/conversations`,
    payload: {
      title: "HTTP",
      mode: "read",
      model: "gpt-test",
    },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().id;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/enterprise/api/conversations/${id}/messages`,
        payload: {
          content: "Question",
          requestId: randomUUID(),
        },
      })
    ).statusCode,
    202,
  );
  assert.equal(
    (
      await app.inject({
        url: `/enterprise/api/conversations/${id}/events?after=-1`,
      })
    ).statusCode,
    400,
  );
  const messages = await app.inject({
    url: `/enterprise/api/conversations/${id}/messages`,
  });
  assert.equal(messages.json().items[0].content, "Question");
});
test("runtime disconnect preserves partial output, marks uncertainty, and never retries the model operation", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  let calls = 0;
  f.runtime.execute = async (_request, emit) => {
    calls++;
    await emit({
      type: "started",
    });
    await emit({
      type: "assistant_delta",
      delta: "Already performed work",
    });
    throw new Error("Socket closed after send");
  };
  const result = await f.service.admit(f.users[0], c.id, {
    content: "Do work",
    requestId: randomUUID(),
  });
  await until(
    async () =>
      (await f.service.runs(f.users[0], c.id)).items[0].status ===
      "interrupted",
  );
  assert.equal(calls, 1);
  assert.equal(
    (await f.service.messages(f.users[0], c.id)).items[1].content,
    "Already performed work",
  );
  assert.ok(f.revoked.includes(result.run!.id));
  assert.equal(
    (
      await f.service.admit(f.users[0], c.id, {
        content: "Do work",
        requestId: result.run!.requestId,
      })
    ).run!.status,
    "interrupted",
  );
  assert.equal(calls, 1);
});
test("runtime failures hide secrets and durable native sessions continue without replaying old input", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  const first = await f.service.admit(f.users[0], c.id, {
    content: "First",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(first.run!.id));
  await f.runtime.complete(first.run!.id);
  const second = await f.service.admit(f.users[0], c.id, {
    content: "Second",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(second.run!.id));
  await f.runtime.event(second.run!.id, {
    type: "failed",
    code: "upstream_error",
    message: "Credential abcSuperPrivate failed",
  });
  f.runtime.pending.get(second.run!.id)!.resolve();
  f.runtime.pending.delete(second.run!.id);
  const third = await f.service.admit(f.users[0], c.id, {
    content: "Third",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(third.run!.id));
  assert.equal(f.runtime.requests[2].resumeId, `native-${second.run!.id}`);
  assert.doesNotMatch(f.runtime.requests[2].prompt, /Second/);
  assert.doesNotMatch(
    JSON.stringify(await f.service.events(f.users[0], c.id, 0)),
    /abcSuperPrivate/,
  );
  await f.runtime.complete(third.run!.id);
});
test("queued input rechecks every author before initial dispatch", async (t) => {
  const f = await fixture(t, 100000, {
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerOrganization: 1,
    }),
    blocker = await f.create(),
    c = await f.create();
  const active = await f.service.admit(f.users[0], blocker.id, {
    content: "Block",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(active.run!.id));
  await f.service.addMember(f.users[0], c.id, f.users[1].id);
  const first = await f.service.admit(f.users[0], c.id, {
    content: "Allowed",
    requestId: randomUUID(),
  });
  const second = await f.service.admit(f.users[1], c.id, {
    content: "Revoked author",
    requestId: randomUUID(),
  });
  await f.db.run("DELETE FROM project_members WHERE user_id=?", [
    f.users[1].id,
  ]);
  await f.runtime.complete(active.run!.id);
  await until(() => f.runtime.pending.has(first.run!.id));
  assert.doesNotMatch(f.runtime.requests[1].prompt, /Revoked author/);
  assert.equal(
    (await f.service.messages(f.users[0], c.id)).items.find(
      (m) => m.id === second.message.id,
    )?.delivery,
    "rejected",
  );
  await f.runtime.complete(first.run!.id);
});
test("SSE replays persisted cursor events and terminates a live connection after membership revocation", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  await f.service.addMember(f.users[0], c.id, f.users[1].id);
  const run = await f.service.admit(f.users[0], c.id, {
    content: "Read files",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(run.run!.id));
  const existing = await f.service.events(f.users[0], c.id, 0),
    cursor = existing.at(-1)!.id;
  await f.runtime.event(run.run!.id, {
    type: "assistant_delta",
    delta: "Persisted stream text",
  });
  const app = Fastify();
  f.ctx.requireUser = async () => f.users[1];
  await registerConversations(app, f.ctx, f.service);
  await app.listen({
    host: "127.0.0.1",
    port: 0,
  });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/enterprise/api/conversations/${c.id}/events?after=${cursor}`,
    {
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  const reader = response.body!.getReader();
  let text = "";
  try {
    while (!text.includes("assistant.delta")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
    }
    assert.match(text, /Persisted stream text/);
    assert.doesNotMatch(text, /run.queued/);
    await f.db.run("DELETE FROM project_members WHERE user_id=?", [
      f.users[1].id,
    ]);
    await f.service.recheckAccess();
    while (!text.includes("access.revoked")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    assert.match(text, /access.revoked/);
  } finally {
    await reader.cancel();
    await app.close();
  }
});
test("source references retain exact available versions and reject unknown file/version claims", async (t) => {
  const f = await fixture(t),
    fileId = randomUUID(),
    versionId = "version-00000001";
  (
    f.deps
      .files as import("../apps/api/src/conversations/types.js").ConversationDependencies["files"]
  ).captureProjectManifest = async () => [
    {
      fileId,
      path: "Evidence.pdf",
      versionId,
    },
  ];
  const c = await f.create(),
    result = await f.service.admit(f.users[0], c.id, {
      content: "Summarize",
      requestId: randomUUID(),
    });
  await until(() => f.runtime.pending.has(result.run!.id));
  assert.match(f.runtime.requests[0].prompt, new RegExp(fileId));
  assert.match(f.runtime.requests[0].prompt, /Do not claim verified page/);
  await f.runtime.event(result.run!.id, {
    type: "citation",
    fileId,
    versionId: "unknown-version",
  });
  await f.runtime.event(result.run!.id, {
    type: "assistant_delta",
    delta: `See [Evidence](wme-file://${fileId}/${versionId}#page=2).`,
  });
  await f.runtime.complete(result.run!.id);
  const citation = (await f.service.messages(f.users[0], c.id)).items[1]
    .citations[0];
  assert.equal(citation.versionId, versionId);
  assert.equal(citation.page, 2);
  assert.equal(citation.verification, "source_reference");
  assert.match(citation.url, /versionId=version-00000001/);
  const snapshot = await f.service.sources(f.users[0], c.id, result.run!.id);
  assert.equal(snapshot.verification, "available_at_dispatch");
  assert.equal(snapshot.items[0].path, "Evidence.pdf");
});
test("uncertain cleanup retains the execution lease and rejects new work until stop is confirmed", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  let canStop = false,
    calls = 0;
  const original = f.runtime.execute.bind(f.runtime),
    cancel = f.runtime.cancel.bind(f.runtime);
  f.runtime.execute = async (req, emit) => {
    if (++calls === 1) {
      await emit({
        type: "started",
      });
      throw new Error("Disconnected");
    }
    await original(req, emit);
  };
  f.runtime.cancel = async (id) => {
    if (!canStop) throw new Error("Unavailable");
    await cancel(id);
  };
  await f.service.admit(f.users[0], c.id, {
    content: "Effect",
    requestId: randomUUID(),
  });
  await until(
    async () =>
      (await f.service.runs(f.users[0], c.id)).items[0].status === "cancelling",
  );
  await assert.rejects(
    f.service.admit(f.users[0], c.id, {
      content: "Next",
      requestId: randomUUID(),
    }),
    {
      code: "run_stopping",
    },
  );
  assert.equal(calls, 1);
  canStop = true;
  await f.service.recheckAccess();
  await until(
    async () =>
      (await f.service.runs(f.users[0], c.id)).items[0].status ===
      "interrupted",
  );
  const next = await f.service.admit(f.users[0], c.id, {
    content: "Next",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(next.run!.id));
  assert.equal(calls, 2);
  await f.runtime.complete(next.run!.id);
});
test("a failed first cancellation retries until runtime acknowledgment even after access revocation", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  const run = await f.service.admit(f.users[0], c.id, {
    content: "Work",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(run.run!.id));
  let attempts = 0;
  const originalCancel = f.runtime.cancel.bind(f.runtime);
  f.runtime.cancel = async (id) => {
    if (++attempts === 1) throw new Error("Temporary stop failure");
    await originalCancel(id);
  };
  await f.db.run("UPDATE project_members SET access='read' WHERE user_id=?", [
    f.users[0].id,
  ]);
  await f.service.cancel(f.users[0], c.id, run.run!.id);
  assert.equal(
    (await f.service.runs(f.users[0], c.id)).items[0].status,
    "cancelling",
  );
  await f.service.recheckAccess();
  await until(
    async () =>
      (await f.service.runs(f.users[0], c.id)).items[0].status === "cancelled",
  );
  assert.ok(attempts >= 2);
});
test("gateway revocation failure never prevents the runtime stop attempt", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  const run = await f.service.admit(f.users[0], c.id, {
    content: "Work",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(run.run!.id));
  let failures = 1;
  const originalRevoke = f.deps.inference.revokeGateway;
  f.deps.inference.revokeGateway = async (id) => {
    if (failures-- > 0) throw new Error("Temporary database failure");
    await originalRevoke(id);
  };
  await f.service.cancel(f.users[0], c.id, run.run!.id);
  assert.ok(f.runtime.cancelled.includes(run.run!.id));
  assert.equal(
    await f.service.canUseRun({
      orgId: f.org,
      projectId: f.project,
      userId: f.users[0].id,
      runId: run.run!.id,
    }),
    false,
  );
});
test("an admitted request receipt remains recoverable after a write permission downgrade", async (t) => {
  const f = await fixture(t),
    c = await f.create(f.users[0], "write"),
    input = {
      content: "Authorized work",
      requestId: randomUUID(),
    };
  const first = await f.service.admit(f.users[0], c.id, input);
  await until(() => f.runtime.pending.has(first.run!.id));
  await f.db.run("UPDATE project_members SET access='read' WHERE user_id=?", [
    f.users[0].id,
  ]);
  await f.service.recheckAccess();
  const receipt = await f.service.admit(f.users[0], c.id, input);
  assert.equal(receipt.duplicate, true);
  assert.equal(receipt.run!.id, first.run!.id);
  assert.equal(f.runtime.requests.length, 1);
});
test("the queued admission bound is enforced atomically under concurrent requests", async (t) => {
  const f = await fixture(t),
    c = await f.create(),
    first = await f.service.admit(f.users[0], c.id, {
      content: "Active",
      requestId: randomUUID(),
    });
  await until(() => f.runtime.pending.has(first.run!.id));
  const results = await Promise.allSettled(
    Array.from(
      {
        length: 55,
      },
      (_, i) =>
        f.service.admit(f.users[0], c.id, {
          content: `Queued ${i}`,
          requestId: randomUUID(),
        }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 50);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && r.reason.code === "queue_full",
    ).length,
    5,
  );
});
test("closing the HTTP server terminates persistent SSE without waiting for a browser disconnect", async (t) => {
  const f = await fixture(t),
    c = await f.create(),
    app = Fastify();
  f.ctx.requireUser = async () => f.users[0];
  await registerConversations(app, f.ctx, f.service);
  await app.listen({
    host: "127.0.0.1",
    port: 0,
  });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/enterprise/api/conversations/${c.id}/events`,
    {
      signal: AbortSignal.timeout(5000),
    },
  );
  const reader = response.body!.getReader();
  await reader.read();
  await app.close();
  while (!(await reader.read()).done) {}
  await reader.cancel();
});
test("provider default uses catalog ownership, and an explicit null resets a custom harness choice", async (t) => {
  const f = await fixture(t);
  (
    f.deps
      .inference as import("../apps/api/src/conversations/types.js").ConversationDependencies["inference"]
  ).defaultHarness = async () => "pi";
  const c = await f.service.create(f.users[0], f.project, {
    title: "OpenRouter",
    mode: "read",
    model: "anthropic/claude-test",
  });
  assert.equal(c.harness, "pi");
  assert.equal(
    (
      await f.service.update(f.users[0], c.id, {
        harness: "claude",
      })
    ).harness,
    "claude",
  );
  assert.equal(
    (
      await f.service.update(f.users[0], c.id, {
        harness: null,
      })
    ).harness,
    "pi",
  );
});
test("API restart refuses to release an active run when the supervisor cannot confirm cleanup", async (t) => {
  const f = await fixture(t),
    c = await f.create(),
    run = await f.service.admit(f.users[0], c.id, {
      content: "Work",
      requestId: randomUUID(),
    });
  await until(() => f.runtime.pending.has(run.run!.id));
  const originalCancel = f.runtime.cancel.bind(f.runtime);
  f.runtime.cancel = async () => {
    throw new Error("Stop not confirmed");
  };
  const restarted = await createConversationService(f.ctx, f.deps);
  await assert.rejects(restarted.start(), /Stop not confirmed/);
  assert.equal(
    (await f.service.runs(f.users[0], c.id)).items[0].status,
    "running",
  );
  f.runtime.cancel = originalCancel;
});
test("maintenance reconciles a durable active record after terminal persistence temporarily fails", async (t) => {
  const f = await fixture(t, 20),
    c = await f.create();
  let failures = 2;
  const originalBatch = f.db.batch.bind(f.db);
  f.db.batch = async (statements) => {
    if (
      statements[0]?.sql.startsWith("UPDATE conversation_runs SET status=?") &&
      failures-- > 0
    )
      throw new Error("Temporary terminal write failure");
    return originalBatch(statements);
  };
  f.runtime.execute = async (_request, emit) => {
    await emit({
      type: "started",
    });
    await emit({
      type: "completed",
    });
  };
  const run = await f.service.admit(f.users[0], c.id, {
    content: "Work",
    requestId: randomUUID(),
  });
  await until(
    async () =>
      (await f.service.runs(f.users[0], c.id)).items[0].status ===
      "interrupted",
  );
  assert.ok(f.runtime.cancelled.includes(run.run!.id));
  assert.equal(
    (await f.service.runs(f.users[0], c.id)).items[0].error?.code,
    "execution_state_lost",
  );
});
test("SSE reconnect Last-Event-ID supersedes the initial query cursor", async (t) => {
  const f = await fixture(t),
    c = await f.create(),
    run = await f.service.admit(f.users[0], c.id, {
      content: "Work",
      requestId: randomUUID(),
    });
  await until(() => f.runtime.pending.has(run.run!.id));
  await f.runtime.event(run.run!.id, {
    type: "assistant_delta",
    delta: "Earlier text",
  });
  const detail = await f.service.get(f.users[0], c.id);
  await f.runtime.event(run.run!.id, {
    type: "assistant_delta",
    delta: "Newest text",
  });
  const app = Fastify();
  f.ctx.requireUser = async () => f.users[0];
  await registerConversations(app, f.ctx, f.service);
  await app.listen({
    host: "127.0.0.1",
    port: 0,
  });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/enterprise/api/conversations/${c.id}/events?after=0`,
    {
      headers: {
        "last-event-id": String(detail.lastEventId),
      },
      signal: AbortSignal.timeout(5000),
    },
  );
  const reader = response.body!.getReader();
  let text = "";
  try {
    while (!text.includes("Newest text")) {
      const next = await reader.read();
      assert.equal(next.done, false);
      text += new TextDecoder().decode(next.value);
    }
    assert.doesNotMatch(text, /Earlier text|run.queued/);
  } finally {
    await reader.cancel();
    await app.close();
  }
});
test("invited read-only project members have full thread authority without direct file or other-session authority", async (t) => {
  const f = await fixture(t),
    c = await f.create(f.users[0], "write"),
    privateThread = await f.create();
  await f.db.run("UPDATE project_members SET access='read' WHERE user_id=?", [
    f.users[1].id,
  ]);
  await assert.rejects(f.create(f.users[1], "write"), {
    code: "read_only",
  });
  await f.service.addMember(f.users[0], c.id, f.users[1].id);
  assert.equal((await f.service.get(f.users[1], c.id)).effectiveMode, "write");
  await assert.rejects(f.ctx.requireProject(f.users[1], f.project, "write"), {
    code: "read_only",
  });
  await assert.rejects(f.service.get(f.users[1], privateThread.id), {
    code: "conversation_not_found",
  });
  const reader = await f.service.admit(f.users[1], c.id, {
    content: "Perform this edit",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(reader.run!.id));
  assert.equal(reader.run!.mode, "write");
  assert.equal(reader.message.authorId, f.users[1].id);
  assert.equal(f.runtime.requests[0].access, "write");
  assert.equal(f.runtime.requests[0].mounts[0].access, "write");
  await assert.rejects(
    f.service.update(f.users[0], c.id, {
      mode: "read",
    }),
    {
      code: "fixed_mode",
    },
  );
  await f.runtime.complete(reader.run!.id);
});
test("fixed thread authority survives a direct-access downgrade while an execution waits for capacity", async (t) => {
  const f = await fixture(t, 100000, {
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerOrganization: 1,
    }),
    blocker = await f.create(),
    c = await f.create(f.users[0], "write");
  await f.service.addMember(f.users[0], c.id, f.users[1].id);
  const first = await f.service.admit(f.users[0], blocker.id, {
    content: "Block",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(first.run!.id));
  const queued = await f.service.admit(f.users[1], c.id, {
    content: "Full thread",
    requestId: randomUUID(),
  });
  await f.db.run("UPDATE project_members SET access='read' WHERE user_id=?", [
    f.users[1].id,
  ]);
  await f.runtime.complete(first.run!.id);
  await until(() => f.runtime.pending.has(queued.run!.id));
  assert.equal(f.runtime.requests[1].access, "write");
  await f.runtime.complete(queued.run!.id);
});
async function secondOrganizationProject(
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const project = randomUUID(),
    timestamp = new Date().toISOString();
  await f.db.batch([
    {
      sql: "INSERT INTO projects(id,org_id,name,description,status,access,created_at) VALUES(?,?,?,?,?,?,?)",
      params: [
        project,
        f.users[4].orgId!,
        "Second firm",
        "",
        "ready",
        "write",
        timestamp,
      ],
    },
    {
      sql: "INSERT INTO project_members VALUES(?,?,?,?)",
      params: [project, f.users[4].id, "write", timestamp],
    },
  ]);
  return project;
}
test("global and organization capacity select oldest eligible conversations and release slots after completion", async (t) => {
  const f = await fixture(t, 100_000, {
      maxConcurrentRuns: 3,
      maxConcurrentRunsPerOrganization: 2,
    }),
    otherProject = await secondOrganizationProject(f);
  const a = await Promise.all(
    Array.from(
      {
        length: 3,
      },
      () => f.create(),
    ),
  );
  const b = await Promise.all(
    Array.from(
      {
        length: 2,
      },
      () =>
        f.service.create(f.users[4], otherProject, {
          title: "Other firm",
          mode: "read",
          model: "gpt-test",
        }),
    ),
  );
  const aRuns: Awaited<ReturnType<typeof f.service.admit>>[] = [];
  for (const c of a)
    aRuns.push(
      await f.service.admit(f.users[0], c.id, {
        content: "A firm request",
        requestId: randomUUID(),
      }),
    );
  const bRuns: Awaited<ReturnType<typeof f.service.admit>>[] = [];
  for (const c of b)
    bRuns.push(
      await f.service.admit(f.users[4], c.id, {
        content: "B firm request",
        requestId: randomUUID(),
      }),
    );
  await until(() => f.runtime.pending.size === 3);
  assert.equal(f.runtime.requests.length, 3);
  assert.ok(f.runtime.pending.has(aRuns[0].run!.id));
  assert.ok(f.runtime.pending.has(aRuns[1].run!.id));
  assert.ok(f.runtime.pending.has(bRuns[0].run!.id));
  assert.equal(
    (await f.service.runs(f.users[0], a[2].id)).items[0].status,
    "queued",
  );
  await f.runtime.complete(bRuns[0].run!.id);
  await until(() => f.runtime.pending.has(bRuns[1].run!.id));
  assert.equal(
    f.runtime.pending.has(aRuns[2].run!.id),
    false,
    "saturated first organization cannot consume another slot",
  );
  await f.runtime.complete(aRuns[0].run!.id);
  await until(() => f.runtime.pending.has(aRuns[2].run!.id));
  assert.equal(f.runtime.pending.size, 3);
  for (const id of [...f.runtime.pending.keys()]) await f.runtime.complete(id);
});
test("uncertain stopping leases keep global capacity occupied until cleanup is acknowledged", async (t) => {
  const f = await fixture(t, 100_000, {
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerOrganization: 1,
    }),
    first = await f.create(),
    second = await f.create();
  let canStop = false;
  const cancel = f.runtime.cancel.bind(f.runtime);
  f.runtime.cancel = async (id) => {
    if (!canStop) throw new Error("Stop unavailable");
    await cancel(id);
  };
  const runA = await f.service.admit(f.users[0], first.id, {
    content: "First",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(runA.run!.id));
  const runB = await f.service.admit(f.users[0], second.id, {
    content: "Second",
    requestId: randomUUID(),
  });
  await f.service.cancel(f.users[0], first.id, runA.run!.id);
  f.service.kick(second.id);
  await pause(30);
  assert.equal(f.runtime.requests.length, 1);
  assert.equal(
    (await f.service.runs(f.users[0], second.id)).items[0].status,
    "queued",
  );
  canStop = true;
  await f.service.recheckAccess();
  await until(() => f.runtime.pending.has(runB.run!.id));
  await f.runtime.complete(runB.run!.id);
});
test("independent SQLite dispatch connections cannot race past global capacity", async (t) => {
  const f = await fixture(t, 100_000, {
    maxConcurrentRuns: 2,
    maxConcurrentRunsPerOrganization: 2,
  });
  const db2 = await createDatabase(join(f.ctx.config.stateDir, "test.sqlite"));
  const ctx2 = createContext(db2, f.ctx.config);
  const other = await createConversationService(ctx2, f.deps);
  t.after(async () => {
    await other.close();
    await db2.close();
  });
  const conversations = await Promise.all(
    Array.from(
      {
        length: 10,
      },
      () => f.create(),
    ),
  );
  const results = await Promise.all(
    conversations.map((c, i) =>
      (i % 2 ? other : f.service).admit(f.users[0], c.id, {
        content: `Concurrent ${i}`,
        requestId: randomUUID(),
      }),
    ),
  );
  await until(() => f.runtime.pending.size === 2);
  await pause(40);
  assert.equal(f.runtime.requests.length, 2);
  const count = await f.db.get<{
    count: number;
  }>(
    "SELECT COUNT(*) count FROM conversation_runs WHERE status IN ('dispatching','running','cancelling')",
  );
  assert.equal(count!.count, 2);
  // Let each owner shut down its own executions; queued requests stay durable.
  await other.close();
  await f.service.close();
  assert.equal(results.length, 10);
});
test("run concurrency configuration rejects zero, fractions, and unbounded values", async (t) => {
  const f = await fixture(t);
  for (const value of [0, -1, 1.5, 65, Number.NaN])
    await assert.rejects(
      createConversationService(f.ctx, {
        ...f.deps,
        maxConcurrentRuns: value,
      }),
      /integer from 1 to 64/,
    );
  await assert.rejects(
    createConversationService(f.ctx, {
      ...f.deps,
      maxConcurrentRunsPerOrganization: 0,
    }),
    /integer from 1 to 64/,
  );
});
test("one unavailable runtime cleanup cannot delay revocation checks for other active conversations", async (t) => {
  const f = await fixture(t, 100_000, {
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerOrganization: 2,
    }),
    first = await f.create(f.users[0], "write"),
    second = await f.create(f.users[1], "write");
  const a = await f.service.admit(f.users[0], first.id, {
      content: "A",
      requestId: randomUUID(),
    }),
    b = await f.service.admit(f.users[1], second.id, {
      content: "B",
      requestId: randomUUID(),
    });
  await until(() => f.runtime.pending.size === 2);
  const cancel = f.runtime.cancel.bind(f.runtime);
  let mode: "fail" | "wait" | "done" = "fail",
    release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.runtime.cancel = async (id) => {
    if (id === a.run!.id) {
      if (mode === "fail") throw new Error("Temporary failure");
      if (mode === "wait") await waiting;
    }
    await cancel(id);
  };
  await f.service.cancel(f.users[0], first.id, a.run!.id);
  mode = "wait";
  const firstCheck = f.service.recheckAccess();
  await pause(10);
  await f.db.run("DELETE FROM project_members WHERE user_id=?", [
    f.users[1].id,
  ]);
  await f.service.recheckAccess();
  assert.ok(f.runtime.cancelled.includes(b.run!.id));
  mode = "done";
  release();
  await firstCheck;
});
test("cancelling a queued snapshot cannot dispatch a run claimed during cancellation", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  const originalKick = f.service.kick.bind(f.service);
  f.service.kick = () => {};
  const admitted = await f.service.admit(f.users[0], c.id, {
    content: "Stop before dispatch",
    requestId: randomUUID(),
  });
  const originalBatch = f.db.batch.bind(f.db);
  let entered!: () => void, release!: () => void;
  const cancelling = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const continueCancel = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  f.db.batch = async (statements: any) => {
    if (
      !intercepted &&
      statements.some(
        (statement: any) =>
          statement.sql.startsWith("UPDATE conversation_runs SET status=") &&
          statement.params?.[0] === "cancelled",
      )
    ) {
      intercepted = true;
      entered();
      await continueCancel;
    }
    return originalBatch(statements);
  };
  const stop = f.service.cancel(f.users[0], c.id, admitted.run!.id);
  // The database write can yield before retiring the queued snapshot. The
  // scheduler can claim and launch that same run while cancellation is waiting.
  try {
    const reached = await Promise.race([
      cancelling.then(() => true),
      stop.then(() => false),
    ]);
    if (reached) {
      originalKick();
      await until(() => f.runtime.pending.has(admitted.run!.id));
      release();
    }
    await stop;
    assert.equal(f.runtime.pending.has(admitted.run!.id), false);
    assert.equal(
      (await f.service.runs(f.users[0], c.id)).items[0].status,
      "cancelled",
    );
  } finally {
    release();
    f.db.batch = originalBatch;
    f.service.kick = originalKick;
  }
});
test("Comments never start or steer; active input preserves authorship and server order then comments enter later context", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  await f.service.addMember(f.users[0], c.id, f.users[1].id);
  const comment = await f.service.admit(f.users[1], c.id, {
    content: "Background before",
    kind: "comment",
    requestId: randomUUID(),
  });
  assert.equal(comment.run, null);
  await pause(25);
  assert.equal(f.runtime.requests.length, 0);
  const active = await f.service.admit(f.users[0], c.id, {
    content: "Start",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(active.run!.id));
  assert.match(
    f.runtime.requests[0].prompt,
    /Comment.*[\s\S]*Background before/,
  );
  const inputs = await Promise.all(
    Array.from(
      {
        length: 8,
      },
      (_, i) =>
        f.service.admit(f.users[i % 2], c.id, {
          content: `Direction ${i}`,
          requestId: randomUUID(),
        }),
    ),
  );
  await f.service.admit(f.users[1], c.id, {
    content: "Background after",
    kind: "comment",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.steers.length === 8);
  assert.deepEqual(
    f.runtime.steers.map((s) => s.input.sequence),
    inputs.map((i) => i.message.sequence),
  );
  assert.deepEqual(
    f.runtime.steers.map((s) => s.input.authorId),
    inputs.map((i) => i.message.authorId),
  );
  assert.equal(f.runtime.requests.length, 1);
  await f.runtime.complete(active.run!.id);
  const next = await f.service.admit(f.users[0], c.id, {
    content: "Next",
    requestId: randomUUID(),
  });
  await until(() => f.runtime.pending.has(next.run!.id));
  assert.match(f.runtime.requests[1].prompt, /Background after/);
  await f.runtime.complete(next.run!.id);
});
test("preflight failure rejects undelivered initial input; dispatch without native receipt remains uncertain and is never replayed", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  (f.deps.files as any).captureProjectManifest = async () => {
    throw new Error("Manifest unavailable");
  };
  const input = await f.service.admit(f.users[0], c.id, {
    content: "Never dispatched",
    requestId: randomUUID(),
  });
  await until(
    async () =>
      (await f.service.runs(f.users[0], c.id)).items[0].status === "failed",
  );
  assert.equal(f.runtime.requests.length, 0);
  assert.equal(
    (await f.service.messages(f.users[0], c.id)).items.find(
      (m) => m.id === input.message.id,
    )?.delivery,
    "rejected",
  );
  delete (f.deps.files as any).captureProjectManifest;
  f.runtime.execute = async () => {
    throw new Error("Lost dispatch response");
  };
  const uncertain = await f.service.admit(f.users[0], c.id, {
    content: "Uncertain effect",
    requestId: randomUUID(),
  });
  await until(
    async () =>
      (await f.service.runs(f.users[0], c.id)).items[0].status ===
      "interrupted",
  );
  assert.equal(
    (await f.service.messages(f.users[0], c.id)).items.find(
      (m) => m.id === uncertain.message.id,
    )?.delivery,
    "uncertain",
  );
  f.runtime.execute = async (req, emit) => {
    assert.doesNotMatch(req.prompt, /Never dispatched|Uncertain effect/);
    await emit({
      type: "input_accepted",
    });
    await emit({
      type: "completed",
    });
  };
  await f.service.admit(f.users[0], c.id, {
    content: "New instruction",
    requestId: randomUUID(),
  });
  await until(
    async () =>
      (await f.service.runs(f.users[0], c.id)).items[0].status === "completed",
  );
});
test("steering uncertainty is durable and completion race rejects a late input without enqueueing another run", async (t) => {
  const f = await fixture(t),
    c = await f.create(),
    active = await f.service.admit(f.users[0], c.id, {
      content: "Start",
      requestId: randomUUID(),
    });
  await until(() => f.runtime.pending.has(active.run!.id));
  f.runtime.steer = async () => {
    throw Object.assign(new Error("Lost native receipt"), {
      code: "steering_uncertain",
    });
  };
  const requestId = randomUUID(),
    input = await f.service.admit(f.users[0], c.id, {
      content: "Uncertain steering",
      requestId,
    });
  await until(
    async () =>
      (await f.service.messages(f.users[0], c.id)).items.find(
        (m) => m.id === input.message.id,
      )?.delivery === "uncertain",
  );
  const duplicate = await f.service.admit(f.users[0], c.id, {
    content: "Uncertain steering",
    requestId,
  });
  assert.equal(duplicate.duplicate, true);
  await f.runtime.complete(active.run!.id);
  assert.equal(f.runtime.requests.length, 1);
});

test("overlapping Stop completion must not cancel work admitted after the completed fence", async (t) => {
  const durable = await durableRuntime(t),
    f = await fixture(t, 100000, {}, durable.runtime),
    c = await f.create();
  const first = await f.service.admit(f.users[0], c.id, {
    content: "First",
    requestId: "stop-race-first",
  });
  await until(() => durable.requests.length === 1);
  await durable.event(first.run!.id, { type: "completed" });
  await until(
    async () =>
      (await f.service.runs(f.users[0], c.id)).items[0].status === "completed",
  );
  const service: any = f.service,
    original = service.completeThreadStop.bind(service);
  let release!: () => void,
    entered!: () => void,
    calls = 0;
  const wait = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (entered = r));
  service.completeThreadStop = async (...args: any[]) => {
    if (++calls === 1) {
      entered();
      await wait;
    }
    return original(...args);
  };
  const delayed = f.service.cancel(f.users[0], c.id);
  await seen;
  await f.service.cancel(f.users[0], c.id);
  const next = await f.service.admit(f.users[0], c.id, {
    content: "New work after successful Stop",
    requestId: "stop-race-next",
  });
  await until(() => durable.requests.length === 2);
  release();
  await delayed;
  const state = (await f.service.runs(f.users[0], c.id)).items.find(
    (r: any) => r.id === next.run!.id,
  );
  assert.equal(
    state?.status,
    "running",
    "Delayed old Stop cancelled a newer generation in API",
  );
  await durable.event(next.run!.id, { type: "completed" });
});
