// Adapted from WovenMatter default-agent/test/claude-native-session.test.mjs
// at 5542b83ab2e11cc3c24037552883e2c6814bd596. Real SDK, synthetic gateway only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { runEnterprisePi } from "../dist/packages/runtime/src/embedded/enterprise-pi.js";

function response(content) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg-" + randomUUID(),
        type: "message",
        model: "claude-sonnet-4-6",
        role: "assistant",
        content: [],
        usage: {
          input_tokens: 13,
          output_tokens: 0,
          cache_read_input_tokens: 2,
        },
      },
    },
  ];
  for (const [index, block] of content.entries()) {
    events.push({
      type: "content_block_start",
      index,
      content_block:
        block.type === "tool_use"
          ? { ...block, input: {} }
          : { ...block, text: "" },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta:
        block.type === "tool_use"
          ? {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            }
          : { type: "text_delta", text: block.text },
    });
    events.push({ type: "content_block_stop", index });
  }
  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: content.some((block) => block.type === "tool_use")
          ? "tool_use"
          : "end_turn",
      },
      usage: { output_tokens: 7, cache_creation_input_tokens: 3 },
    },
    { type: "message_stop" },
  );
  return new Response(
    events
      .map(
        (event) =>
          "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n",
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
test(
  "real Claude SDK uses refreshed gateway capability for tools, native compaction and continuation",
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "wme-claude-sdk-"));
    const retained = {},
      requests = [],
      captures = [];
    const originalFetch = globalThis.fetch;
    let blocks = [
      {
        type: "tool_use",
        id: "toolu_fixture",
        name: "mcp__woven__read",
        input: { path: join(root, "note.txt") },
      },
    ];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(
        url.origin,
        "https://gateway.example.invalid",
        "no direct provider request may escape",
      );
      assert.equal(url.pathname, "/v1/messages");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("x-api-key"), null);
      const body = JSON.parse(String(init.body));
      requests.push({ body, token: headers.get("authorization") });
      const value = blocks;
      blocks = [{ type: "text", text: "HOST_TOOL_RESULT_RECEIVED" }];
      return response(value);
    };
    t.after(async () => {
      globalThis.fetch = originalFetch;
      for (const record of retained.pi?.engine.sessions.values() ?? [])
        await record.session.dispose();
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(join(root, "note.txt"), "EXACT_ENTERPRISE_TOOL_CONTENT");
    const base = {
      projectId: "project",
      harness: "pi",
      model: "claude-sonnet-4-6",
      access: "write",
      gateway: {
        baseUrl: "https://gateway.example.invalid",
        token: "fixture-capability-one",
      },
      pi: {
        provider: "anthropic",
        api: "anthropic-messages",
        codeMode: "off",
        routeIdentity: "anthropic:fixture-route",
        supportsReasoning: false,
      },
    };
    const run = async (prompt, token) => {
      const events = [];
      await runEnterprisePi(
        {
          ...base,
          runId: randomUUID(),
          prompt,
          gateway: { ...base.gateway, token },
        },
        async (event) => {
          events.push(event);
          if (event.type === "native_records") captures.push(event.batch);
        },
        AbortSignal.timeout(60000),
        undefined,
        retained,
        { sessionDirectory: root, cwd: root },
      );
      assert.equal(
        events.at(-1)?.type,
        "completed",
        JSON.stringify(
          events.filter((event) =>
            ["failed", "cancelled"].includes(event.type),
          ),
        ),
      );
      return events;
    };
    await run("Read note.txt", "fixture-capability-one");
    assert.equal(requests.length, 2);
    assert.ok(
      JSON.stringify(requests[1].body).includes(
        "EXACT_ENTERPRISE_TOOL_CONTENT",
      ),
    );
    assert.ok(
      requests.every(
        (request) => request.token === "Bearer fixture-capability-one",
      ),
    );
    const sessionId = retained.pi.sessionId;
    const record = retained.pi.engine.sessions.get(sessionId);
    await record.conversation.commit(async (tx) => {
      for (let i = 0; i < 10; i++) {
        await tx.appendEntry(record.conversation.id, {
          kind: "pi.user",
          model: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "ORIGINAL_FACT_" +
                    i +
                    ": iridescent octopus. " +
                    "Detailed history ".repeat(500),
                },
              ],
              timestamp: i,
            },
          ],
        });
        await tx.appendEntry(record.conversation.id, {
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              api: "woven-claude-native",
              provider: "anthropic",
              model: base.model,
              content: [
                {
                  type: "text",
                  text:
                    "Prior conclusion " + i + ". " + "Conclusion ".repeat(100),
                },
              ],
              stopReason: "stop",
              timestamp: i,
            },
          ],
        });
      }
    }, ctx);
    blocks = [
      {
        type: "text",
        text: "NATIVE_COMPACT_SUMMARY_FACT: iridescent octopus.",
      },
    ];
    const before = requests.length;
    const compactEvents = await run(
      "/compact Preserve the fact.",
      "fixture-capability-two",
    );
    assert.ok(
      requests.length > before,
      "manual compaction must make a real scoped gateway request",
    );
    assert.ok(
      requests
        .slice(before)
        .every((request) => request.token === "Bearer fixture-capability-two"),
    );
    assert.ok(JSON.stringify(captures).includes("compact_boundary"));
    assert.ok(JSON.stringify(captures).includes("isCompactSummary"));
    assert.ok(
      !compactEvents.some(
        (event) =>
          event.type === "assistant_delta" &&
          event.delta.includes("NATIVE_COMPACT_SUMMARY_FACT"),
      ),
    );
    blocks = [{ type: "text", text: "Fact preserved after native restore." }];
    await run("Continue with the fact.", "fixture-capability-three");
    assert.equal(retained.pi.sessionId, sessionId);
    assert.equal(requests.at(-1).token, "Bearer fixture-capability-three");
    assert.ok(
      JSON.stringify(requests.at(-1).body.messages).includes(
        "NATIVE_COMPACT_SUMMARY_FACT",
      ),
    );
    assert.ok(!JSON.stringify(captures).includes("fixture-capability-"));
  },
);
