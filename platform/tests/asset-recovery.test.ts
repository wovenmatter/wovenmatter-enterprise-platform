import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { platformFixture } from "./fixtures/platform.js";
import { buildApp } from "../apps/api/src/app.js";
import {
  WorkspaceService,
  type WorkspaceWorker,
} from "../packages/runtime/src/workspace-service.js";
import type {
  Runtime,
  RuntimeRequest,
  EventSink,
} from "../packages/runtime/src/types.js";
async function until(check: () => Promise<boolean>) {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Recovery fixture did not settle");
}

test("API restart reattaches an accepted asset turn without resubmission; workspace restart records interruption and permits explicit followup", async (t) => {
  let service: WorkspaceService,
    starts = 0,
    submissions = 0;
  const turns = new Map<
    string,
    { request: RuntimeRequest; emit: EventSink; resolve: () => void }
  >();
  const launch = async (): Promise<WorkspaceWorker> => {
    starts++;
    let closedResolve!: () => void, current: string | undefined;
    const closed = new Promise<void>((resolve) => (closedResolve = resolve));
    return {
      closed,
      turn(request, emit) {
        current = request.runId;
        return new Promise<void>((resolve) =>
          turns.set(request.runId, { request, emit, resolve }),
        );
      },
      async steer() {},
      async stop() {
        if (current) turns.get(current)?.resolve();
        closedResolve();
      },
    };
  };
  const runtime: Runtime = {
    async ensureProject() {},
    async releaseAsset() {},
    async recover() {
      return [];
    },
    async execute(request, emit, signal) {
      submissions++;
      await service.admit(request);
      return runtime.attach!(request.runId, 0, emit, signal);
    },
    async attach(id, after, emit, signal) {
      await service.attach(id);
      await emit({ type: "attached" });
      let cursor = after;
      while (!signal?.aborted) {
        const result = await service.poll(id, cursor, 25);
        for (const event of result.events) {
          await emit(event);
          cursor = event.sequence!;
        }
        if (result.terminal) return;
      }
      throw new DOMException("Detached", "AbortError");
    },
    async acknowledge(id, cursor) {
      await service.acknowledge(id, cursor);
    },
    async cancel(id) {
      await service.cancel(id);
    },
    async stopSession(_id, thread, generation) {
      await service.stopSession(thread, generation);
    },
  };
  const f = await platformFixture(t, { runtime });
  const directory = join(f.stateDir, "synthetic-workspace-service");
  service = new WorkspaceService(directory, launch);
  await service.initialize();
  const configure = (
    system: typeof f | Awaited<ReturnType<typeof buildApp>>,
  ) => {
    system.inference.models = async () => [
      { id: "fixture", name: "Fixture", provider: "openai" },
    ];
    system.inference.validateSelection = async () => {};
    system.inference.options.registry.resolve = async () => ({
      baseUrl: "http://provider.example.test",
      managementKey: "fixture-management",
      clientKey: "fixture-client",
    });
  };
  configure(f);
  let current: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const created = await f.request(
      "admin",
      "POST",
      `/enterprise/api/organizations/${f.orgA}/assets`,
      { name: "Durable asset", draft: true },
    );
    assert.equal(created.statusCode, 201, created.body);
    const a = created.json();
    const c = (
      await f.request("admin", "POST", `/enterprise/api/assets/${a.id}/agent`, {
        model: "fixture",
      })
    ).json();
    const input = {
      requestId: randomUUID(),
      content: "Prepare and save this draft",
    };
    assert.equal(
      (
        await f.request(
          "admin",
          "POST",
          `/enterprise/api/conversations/${c.id}/messages`,
          input,
        )
      ).statusCode,
      202,
    );
    await until(async () => turns.size === 1);
    const turn = [...turns.values()][0];
    await turn.emit({ type: "started" });
    await turn.emit({ type: "input_accepted" });
    await turn.emit({ type: "assistant_delta", delta: "Preparing the asset" });
    await until(
      async () =>
        (await f.db.get<{ runtime_cursor: number }>(
          "SELECT runtime_cursor FROM conversation_runs WHERE id=?",
          [turn.request.runId],
        ))!.runtime_cursor >= 3,
    );
    const config = f.ctx.config;
    await f.app.close();
    assert.equal(starts, 1);
    assert.equal(submissions, 1);
    current = await buildApp(config, {
      runtime,
      jobs: false,
      webRoot: join(f.stateDir, "no-web"),
    });
    configure(current);
    await until(
      async () =>
        (await current!.conversations.get(f.users.admin, c.id)).activeRun
          ?.status === "running",
    );
    const operation = await current.app.inject({
      method: "POST",
      url: new URL(turn.request.gateway.baseUrl).pathname + "/asset",
      headers: {
        host: "portal.test",
        authorization: "Bearer " + turn.request.gateway.token,
      },
      payload: {
        operation: "save",
        operationId: randomUUID(),
        expectedRevision: a.revision,
        document: {
          version: 1,
          blocks: [{ type: "text", text: "Saved after API reattachment" }],
        },
      },
    });
    assert.equal(operation.statusCode, 200, operation.body);
    await turn.emit({ type: "completed" });
    turn.resolve();
    await until(
      async () =>
        (
          await current!.ctx.db.get<{ status: string }>(
            "SELECT status FROM conversation_runs WHERE id=?",
            [turn.request.runId],
          )
        )?.status === "completed",
    );
    assert.equal(starts, 1);
    assert.equal(submissions, 1);
    const receipt = await current.app.inject({
      method: "POST",
      url: `/enterprise/api/conversations/${c.id}/messages`,
      headers: f.headers.admin,
      payload: input,
    });
    assert.equal(receipt.statusCode, 202, receipt.body);
    assert.equal(receipt.json().duplicate, true);
    assert.equal(submissions, 1);
    const preview = await current.app.inject({
      url: a.url + "/preview",
      headers: f.headers.admin,
    });
    assert.match(preview.body, /Saved after API reattachment/);
    const second = await current.app.inject({
      method: "POST",
      url: `/enterprise/api/conversations/${c.id}/messages`,
      headers: f.headers.admin,
      payload: { requestId: randomUUID(), content: "Continue explicitly" },
    });
    assert.equal(second.statusCode, 202);
    await until(async () => turns.size === 2);
    assert.equal(starts, 1, "retained native worker survives successive turns");
    await current.app.close();
    current = undefined;
    // Closing the real durable workspace service interrupts live work. Its journal
    // is re-opened by a fresh service; no API attachment can replay native input.
    await service.close();
    service = new WorkspaceService(directory, launch);
    await service.initialize();
    current = await buildApp(config, {
      runtime,
      jobs: false,
      webRoot: join(f.stateDir, "no-web"),
    });
    configure(current);
    await until(
      async () =>
        (
          await current!.ctx.db.get<{ status: string }>(
            "SELECT status FROM conversation_runs WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
            [c.id],
          )
        )?.status === "interrupted",
    );
    assert.equal(submissions, 2);
    assert.equal(starts, 1);
    const detail = await current.assetAgents.detail(f.users.admin, a.id);
    assert.equal(detail.conversation!.id, c.id);
    const retry = await current.app.inject({
      method: "POST",
      url: `/enterprise/api/conversations/${c.id}/messages`,
      headers: f.headers.admin,
      payload: {
        requestId: randomUUID(),
        content: "Resume from the retained draft",
      },
    });
    assert.equal(retry.statusCode, 202, retry.body);
    await until(async () => turns.size === 3);
    assert.equal(starts, 2);
    assert.equal(submissions, 3);
    const final = [...turns.values()][2];
    assert.match(final.request.prompt, /Saved after API reattachment/);
    await final.emit({ type: "completed" });
    final.resolve();
  } finally {
    await current?.app.close();
    await service.close();
  }
});
