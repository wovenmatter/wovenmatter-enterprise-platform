import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceService,
  type WorkspaceWorker,
} from "../src/workspace-service.js";
import type {
  RuntimeEvent,
  RuntimeRequest,
  SteeringInput,
} from "../src/types.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const request = (
  runId: string,
  conversationId = "thread-a",
  generation = 0,
): RuntimeRequest => ({
  runId,
  conversationId,
  generation,
  userId: "user-a",
  organizationId: "org",
  projectId: "project",
  harness: "codex",
  model: "model",
  prompt: "Work",
  access: "write",
  mounts: [{ source: "/project/files", target: "/workspace", access: "write" }],
  sessionDirectory: "/state/session",
  gateway: {
    baseUrl: "http://gateway/inference",
    token: "synthetic-token-for-workspace-tests",
  },
});
async function fixture(
  t: test.TestContext,
  limits?: { replayBytes: number; retentionMs: number },
) {
  const directory = await mkdtemp(join(tmpdir(), "wme-workspace-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workers: {
    worker: WorkspaceWorker;
    turns: RuntimeRequest[];
    inputs: SteeringInput[];
    stopped: boolean;
    emit?: (event: RuntimeEvent) => Promise<void>;
    completion?: ReturnType<typeof deferred<void>>;
    steering?: ReturnType<typeof deferred<void>>;
  }[] = [];
  const launch = async () => {
    const closed = deferred();
    const record: (typeof workers)[number] = {
      turns: [],
      inputs: [],
      stopped: false,
      worker: undefined!,
    };
    record.worker = {
      closed: closed.promise,
      turn(input, emit) {
        record.turns.push(input);
        record.emit = emit;
        record.completion = deferred();
        return record.completion.promise;
      },
      async steer(input) {
        record.inputs.push(input);
        await record.steering?.promise;
      },
      async stop() {
        record.stopped = true;
        closed.resolve();
        record.completion?.resolve();
      },
    };
    workers.push(record);
    return record.worker;
  };
  const service = new WorkspaceService(directory, launch, limits);
  await service.initialize();
  return { service, workers, directory, launch };
}

test("workspace owns concurrent sessions, retained turns and cursor replay independent of attachments", async (t) => {
  const { service, workers } = await fixture(t);
  await Promise.all([
    service.admit(request("run-a")),
    service.admit(request("run-b", "thread-b")),
  ]);
  assert.equal(workers.length, 2);
  await workers[0]!.emit!({ type: "started" });
  await workers[0]!.emit!({ type: "assistant_delta", delta: "shared result" });
  await service.attach("run-a");
  const replacement = await service.attach("run-a");
  assert.ok(replacement.attachment);
  assert.deepEqual((await service.poll("run-a", 1)).events, [
    { type: "assistant_delta", delta: "shared result", sequence: 2 },
  ]);
  await service.admit(request("run-a"));
  assert.equal(workers[0]!.turns.length, 1);
  await assert.rejects(
    service.admit({ ...request("run-a"), prompt: "changed" }),
    { code: "request_conflict" },
  );
  await assert.rejects(service.admit(request("competing")), {
    code: "thread_busy",
  });
  await workers[0]!.emit!({ type: "completed" });
  workers[0]!.completion!.resolve();
  await service.admit(request("next-turn"));
  assert.equal(workers.length, 2);
  assert.equal(workers[0]!.turns.length, 2);
  assert.equal(workers[0]!.stopped, false);
  await service.close();
});

test("fenced ordered steering is delivered once and receipts survive attachment replacement", async (t) => {
  const { service, workers } = await fixture(t);
  await service.admit(request("run"));
  const old = await service.attach("run"),
    current = await service.attach("run");
  const input = {
    id: "message",
    sequence: 3,
    authorId: "user-b",
    authorName: "Colleague",
    content: "Change direction",
  };
  await assert.rejects(service.steer("run", old.attachment, input), {
    code: "attachment_replaced",
  });
  await service.steer("run", current.attachment, input);
  await service.steer("run", current.attachment, input);
  assert.equal(workers[0]!.inputs.length, 1);
  await assert.rejects(
    service.steer("run", current.attachment, {
      ...input,
      content: "different",
    }),
    { code: "request_conflict" },
  );
  await assert.rejects(
    service.steer("run", current.attachment, {
      ...input,
      id: "earlier",
      sequence: 2,
    }),
    { code: "input_order" },
  );
  await service.close();
});

test("idle thread stop retains siblings and fences stale admissions across service restart", async (t) => {
  const { service, workers, directory, launch } = await fixture(t);
  await service.admit(request("run"));
  await service.admit(request("sibling", "thread-b"));
  await workers[0]!.emit!({ type: "completed" });
  workers[0]!.completion!.resolve();
  await service.stopSession("thread-a", 1);
  assert.equal(workers[0]!.stopped, true);
  assert.equal(workers[1]!.stopped, false);
  await assert.rejects(service.admit(request("stale")), {
    code: "authority_revoked",
  });
  await service.close();
  const restarted = new WorkspaceService(directory, launch);
  await restarted.initialize();
  await assert.rejects(restarted.admit(request("stale-after-restart")), {
    code: "authority_revoked",
  });
  const before = workers.length;
  await restarted.attach("run");
  assert.equal((await restarted.poll("run", 0)).terminal, true);
  assert.equal(workers.length, before);
  await restarted.admit(request("authorized-new-turn", "thread-a", 1));
  assert.equal(workers.length, before + 1);
  await restarted.close();
});

test("service restart exposes interruption without launching or replaying accepted input", async (t) => {
  const { service, directory, workers, launch } = await fixture(t);
  await service.admit(request("interrupted"));
  await workers[0]!.emit!({ type: "input_accepted" });
  // Model loss of process memory after durable admission. The old owner does no more work.
  const restarted = new WorkspaceService(directory, launch);
  await restarted.initialize();
  await restarted.admit(request("interrupted"));
  assert.equal(workers.length, 1);
  const snapshot = await restarted.poll("interrupted", 0);
  assert.equal(snapshot.terminal, true);
  assert.equal(snapshot.events.at(-1)!.type, "failed");
  assert.equal(
    (snapshot.events.at(-1) as { code: string }).code,
    "workspace_restarted",
  );
});

test("idle polling does not hold another session's admission lane", async (t) => {
  const { service, workers } = await fixture(t);
  await service.admit(request("waiting"));
  const poll = service.poll("waiting", 0, 10000);
  await service.admit(request("parallel", "thread-b"));
  assert.equal(workers.length, 2);
  await workers[0]!.emit!({ type: "started" });
  assert.equal((await poll).events.length, 1);
  await service.close();
});
test("graceful workspace shutdown records interruption before native teardown", async (t) => {
  const { service, directory, launch } = await fixture(t);
  await service.admit(request("shutdown"));
  await service.close();
  const restarted = new WorkspaceService(directory, launch);
  await restarted.initialize();
  const result = await restarted.poll("shutdown", 0);
  assert.equal(result.terminal, true);
  assert.equal(
    (result.events.at(-1) as { code: string }).code,
    "workspace_restarted",
  );
  await restarted.close();
});

test("terminal output does not admit the next turn before native finalization", async (t) => {
  const { service, workers } = await fixture(t);
  await service.admit(request("first"));
  await workers[0]!.emit!({ type: "completed" });
  let admitted = false;
  const next = service.admit(request("next")).then(() => {
    admitted = true;
  });
  await service.admit(request("sibling", "thread-b"));
  assert.equal(admitted, false);
  assert.equal(workers[0]!.turns.length, 1);
  workers[0]!.completion!.resolve();
  await next;
  assert.equal(workers[0]!.turns.length, 2);
  await service.close();
});

test("concurrent thread revocation fences persist independently after restart", async (t) => {
  const { service, directory, launch, workers } = await fixture(t);
  await Promise.all(
    Array.from({ length: 64 }, (_, i) =>
      service.stopSession(`thread-${i}`, i + 1),
    ),
  );
  await service.close();
  const restored = new WorkspaceService(directory, launch);
  await restored.initialize();
  for (let i = 0; i < 64; i++)
    await assert.rejects(
      restored.admit(request(`stale-${i}`, `thread-${i}`, i)),
      { code: "authority_revoked" },
    );
  assert.equal(workers.length, 0);
  await restored.close();
});

test("offline results survive storage pressure until the API explicitly acknowledges its durable cursor", async (t) => {
  const { service, workers, directory, launch } = await fixture(t, {
    replayBytes: 500,
    retentionMs: 0,
  });
  await service.admit(request("offline"));
  await workers[0]!.emit!({ type: "assistant_delta", delta: "a".repeat(300) });
  await workers[0]!.emit!({ type: "completed" });
  workers[0]!.completion!.resolve();
  await service.admit(request("pressure", "thread-b"));
  await assert.rejects(
    workers[1]!.emit!({ type: "assistant_delta", delta: "b".repeat(300) }),
    { code: "journal_full" },
  );
  await workers[1]!.emit!({
    type: "failed",
    code: "journal_full",
    message: "Output storage is full.",
  });
  workers[1]!.completion!.resolve();
  assert.equal(
    (await service.poll("offline", 0)).events[0]!.type,
    "assistant_delta",
  );
  await assert.rejects(service.admit(request("too-much", "thread-c")), {
    code: "journal_full",
  });
  await service.acknowledge("offline", 2);
  await assert.rejects(service.poll("offline", 0), { code: "replay_expired" });
  await service.close();
  const restored = new WorkspaceService(directory, launch);
  await restored.initialize();
  await restored.admit(request("offline"));
  assert.equal(workers.length, 2, "expired identity is never dispatched again");
  assert.equal((await restored.poll("offline", 2)).terminal, true);
  await restored.close();
});
