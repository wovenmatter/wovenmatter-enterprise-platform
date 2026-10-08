import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodex, runGrok, type RpcFactory } from "../src/native.ts";
import { runClaude } from "../src/sdk.ts";
import { JsonRpcProcess, type RpcMessage } from "../src/rpc.ts";
import type { ContainerRequest, RuntimeEvent } from "../src/types.ts";

const request: ContainerRequest = {
  runId: "run-normalize",
  projectId: "project1",
  harness: "codex",
  model: "example-model",
  prompt: "Inspect files",
  access: "read",
  gateway: {
    baseUrl: "http://api:4100/enterprise/api/runtime/inference/project1",
    token: "synthetic-run-scoped-token-only",
  },
};

class FixtureRpc {
  onMessage: (message: RpcMessage) => Promise<void> = async () => {};
  calls: { method: string; params: any }[] = [];
  sent: RpcMessage[] = [];
  closed = new Promise<void>(() => {});
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === "initialize")
      return { agentCapabilities: { loadSession: true } };
    if (["thread/start", "thread/resume"].includes(method))
      return { thread: { id: "thread1" } };
    if (method === "turn/start") {
      await this.onMessage({
        method: "item/agentMessage/delta",
        params: { threadId: "thread1", itemId: "msg1", delta: "Codex text" },
      });
      await this.onMessage({
        method: "item/started",
        params: {
          threadId: "thread1",
          item: { id: "tool1", type: "commandExecution", status: "running" },
        },
      });
      await this.onMessage({
        method: "item/completed",
        params: {
          threadId: "thread1",
          item: { id: "tool1", type: "commandExecution", status: "completed" },
        },
      });
      await this.onMessage({
        method: "turn/completed",
        params: { threadId: "thread1", turn: { status: "completed" } },
      });
      return { turn: { id: "turn1" } };
    }
    if (method === "session/new") return { sessionId: "session1" };
    if (method === "session/prompt") {
      await this.onMessage({
        method: "session/update",
        params: {
          sessionId: "session1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Grok text" },
          },
        },
      });
      await this.onMessage({
        method: "session/update",
        params: {
          sessionId: "session1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "grok-tool",
            title: "shell",
          },
        },
      });
      await this.onMessage({
        method: "session/update",
        params: {
          sessionId: "session1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "grok-tool",
            title: "shell",
            status: "completed",
          },
        },
      });
      return { stopReason: "end_turn" };
    }
    return {};
  }
  send(message: RpcMessage) {
    this.sent.push(message);
  }
  async flush() {}
  close() {}
}

const factory =
  (fixture: FixtureRpc): RpcFactory =>
  () =>
    fixture as unknown as JsonRpcProcess;

test("Codex emits ordered native updates while preserving assistant_delta compatibility", async () => {
  const rpc = new FixtureRpc();
  const events: RuntimeEvent[] = [];
  await runCodex(
    request,
    (event) => {
      events.push(event);
    },
    new AbortController().signal,
    factory(rpc),
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "native_update")
      .map((event) => event.update.sessionUpdate),
    ["agent_message_chunk", "tool_call", "tool_call_update"],
  );
  assert.equal(
    events.find((event) => event.type === "assistant_delta")?.delta,
    "Codex text",
  );
});

test("Grok forwards native ACP updates and legacy events in order", async () => {
  const rpc = new FixtureRpc();
  const events: RuntimeEvent[] = [];
  await runGrok(
    { ...request, harness: "grok" },
    (event) => {
      events.push(event);
    },
    new AbortController().signal,
    factory(rpc),
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "native_update")
      .map((event) => event.update.sessionUpdate),
    ["agent_message_chunk", "tool_call", "tool_call_update"],
  );
  assert.equal(
    events.find((event) => event.type === "assistant_delta")?.delta,
    "Grok text",
  );
});

test("Claude SDK stream is normalized without invented checklist data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-claude-normalize-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const query = (({ prompt }: any) =>
    Object.assign(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "claude-session" };
        yield {
          type: "stream_event",
          event: { type: "message_start", message: { id: "message1" } },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Claude text" },
          },
        };
        yield {
          type: "assistant",
          message: {
            id: "message1",
            content: [
              { type: "text", text: "Claude text" },
              {
                type: "tool_use",
                id: "tool1",
                name: "Read",
                input: { file_path: "record.txt" },
              },
            ],
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool1",
                is_error: false,
                content: "Complete retained output.",
              },
            ],
          },
        };
        for await (const input of prompt)
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            user_message_uuids: [input.uuid],
          };
      })(),
      { close() {} },
    )) as any;
  const events: RuntimeEvent[] = [];
  await runClaude(
    { ...request, harness: "claude" },
    (event) => {
      events.push(event);
    },
    new AbortController().signal,
    undefined,
    { query, sessionDirectory: directory },
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "native_update")
      .map((event) => event.update.sessionUpdate),
    [
      "agent_message_chunk",
      "tool_call",
      "woven_assistant_boundary",
      "tool_call_update",
    ],
  );
  assert.equal(
    events.find((event) => event.type === "assistant_delta")?.delta,
    "Claude text",
  );
  const tool = events.find(
    (event) =>
      event.type === "native_update" &&
      event.update.sessionUpdate === "tool_call",
  );
  assert.deepEqual(tool?.type === "native_update" && tool.update.rawInput, {
    file_path: "record.txt",
  });
  const result = events.find(
    (event) =>
      event.type === "native_update" &&
      event.update.sessionUpdate === "tool_call_update",
  );
  assert.match(JSON.stringify(result), /Complete retained output/);
  assert.equal(
    events.some(
      (event) =>
        event.type === "native_update" &&
        event.update.sessionUpdate === "checklist",
    ),
    false,
  );
});

test("Codex keeps native thought/output deltas and reconciles final text by message identity", async () => {
  const rpc = new FixtureRpc(),
    original = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    if (method !== "turn/start") return original(method, params);
    const frames = [
      {
        method: "item/agentMessage/delta",
        params: { itemId: "m1", delta: "draft" },
      },
      {
        method: "item/reasoning/summaryTextDelta",
        params: { itemId: "r1", summaryIndex: 0, delta: "Check the source" },
      },
      {
        method: "item/started",
        params: {
          item: {
            id: "t1",
            type: "commandExecution",
            command: "pwd",
            status: "in_progress",
          },
        },
      },
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: "t1", delta: "partial" },
      },
      {
        method: "item/completed",
        params: {
          item: {
            id: "t1",
            type: "commandExecution",
            command: "pwd",
            status: "completed",
            aggregatedOutput: "complete output",
          },
        },
      },
      {
        method: "item/completed",
        params: { item: { id: "m1", type: "agentMessage", text: "corrected" } },
      },
      {
        method: "item/agentMessage/delta",
        params: { itemId: "m2", delta: "Final answer" },
      },
      {
        method: "item/completed",
        params: {
          item: { id: "m2", type: "agentMessage", text: "Final answer" },
        },
      },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    ];
    for (const frame of frames)
      await rpc.onMessage({
        ...frame,
        params: { ...frame.params, threadId: "thread1" },
      });
    return { turn: { id: "turn1" } };
  };
  const events: RuntimeEvent[] = [];
  await runCodex(
    request,
    (event) => {
      events.push(event);
    },
    new AbortController().signal,
    factory(rpc),
  );
  const updates = events
    .filter((event) => event.type === "native_update")
    .map((event) => event.update);
  assert.ok(
    updates.some(
      (update) =>
        update.sessionUpdate === "agent_thought_chunk" &&
        (update.content as any).text === "Check the source",
    ),
  );
  assert.ok(
    updates.some(
      (update) =>
        update.sessionUpdate === "tool_call_update" &&
        (update.rawOutput as any)?.output?.append === "partial",
    ),
  );
  assert.ok(
    updates.some(
      (update) =>
        (update.content as any)?.[0]?.content?.text === "complete output",
    ),
  );
  const correction = updates.find(
    (update) => (update._meta as any)?.nativeMessageSnapshot,
  );
  assert.equal((correction?.content as any).text, "corrected");
  assert.equal((correction?._meta as any).nativeMessageID, "m1");
  assert.equal(
    updates.filter(
      (update) => update.sessionUpdate === "woven_assistant_boundary",
    ).length,
    2,
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "assistant_delta")
      .map((event) => event.delta),
    ["draft", "Final answer"],
  );
});
