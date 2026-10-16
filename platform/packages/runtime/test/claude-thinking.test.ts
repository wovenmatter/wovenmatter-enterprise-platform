import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
// @ts-expect-error The embedded runtime is shipped as native ESM.
import { registerClaudeProviders } from "../src/embedded/default-agent/src/claude-provider.mjs";

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const map = (enabled: Record<string, string>) => Object.fromEntries(levels.map(level => [level, enabled[level] ?? null]));

function response() {
  const events = [
    { type: "message_start", message: { id: "fixture-response", role: "assistant", model: "fixture-claude", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture complete" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function fixture(metadata: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wme-claude-thinking-"));
  const captured: { body: any; env: any }[] = [];
  const providers: any[] = [];
  let sdkCalls = 0;
  const claude = {
    models: [{ value: "fixture-claude", displayName: "Fixture", supportedEffortLevels: ["low", "medium", "high"], ...metadata }],
    environment: async () => ({}),
    providerDependencies: () => ({ admission: { upstream: "https://fixture.invalid", fetcher: async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).origin, "https://fixture.invalid");
      captured.at(-1)!.body = JSON.parse(String(init.body));
      return response();
    } } }),
    // Replace only the SDK subprocess. The real native stream, session store,
    // loopback admission server and request forwarding run unchanged.
    sdkQuery: async ({ prompt, options: sdkOptions }: any) => {
      sdkCalls++;
      captured.push({ body: undefined, env: sdkOptions.env });
      return { close() {}, async *[Symbol.asyncIterator]() {
        for await (const frame of prompt) {
          assert.equal(frame.type, "user");
          const target = new URL(`${sdkOptions.env.ANTHROPIC_BASE_URL}/v1/messages`);
          assert.equal(target.hostname, "127.0.0.1", "fixture cannot contact a provider");
          const result = await fetch(target, { method: "POST", body: sdkOptions.env.CLAUDE_CODE_EXTRA_BODY });
          assert.equal(result.status, 200);
          await result.text();
          break;
        }
        yield { type: "result", is_error: false };
      } };
    },
  };
  registerClaudeProviders({ registerNativeProvider: (provider: any) => providers.push(provider) }, claude, { read: async () => ({ key: "fixture-only" }) });
  const provider = providers.find(provider => provider.id === "anthropic");
  const model = provider.getModels()[0];
  try {
    const result = await provider.streamSimple(model, { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] }, {
      ...options,
      wovenNativeContext: { directory, sessionID: randomUUID(), provider: "anthropic", modelID: model.id, accountID: "fixture-account" },
    }).result();
    return { model, result, captured, sdkCalls };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Claude native transport preserves exact capabilities and maps adaptive effort", async () => {
  const thinkingLevelMap = map({ minimal: "low", high: "high", xhigh: "xhigh", max: "max" });
  const value = await fixture({ thinkingLevelMap, compat: { forceAdaptiveThinking: true }, contextWindow: 131072, maxTokens: 24000 }, { reasoning: "minimal" });
  assert.equal(value.result.stopReason, "stop", value.result.errorMessage);
  assert.deepEqual(value.model.thinkingLevelMap, thinkingLevelMap);
  assert.deepEqual(getSupportedThinkingLevels(value.model), ["minimal", "high", "xhigh", "max"]);
  assert.equal(value.model.contextWindow, 131072);
  assert.equal(value.model.maxTokens, 24000);
  assert.deepEqual(value.captured[0].body.thinking, { type: "adaptive" });
  assert.deepEqual(value.captured[0].body.output_config, { effort: "low" });
  assert.equal(value.captured[0].body.max_tokens, 24000);
  assert.equal(value.captured[0].env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "24000");
});

test("Claude native transport sends xhigh and max without narrowing", async () => {
  for (const effort of ["xhigh", "max"]) {
    const value = await fixture({ thinkingLevelMap: map({ [effort]: effort }), compat: { forceAdaptiveThinking: true } }, { reasoning: effort });
    assert.equal(value.result.stopReason, "stop", value.result.errorMessage);
    assert.deepEqual(value.captured[0].body.output_config, { effort });
  }
});

test("Claude native transport uses bounded token budgets for non-adaptive models", async () => {
  const value = await fixture({ thinkingLevelMap: map({ off: "off", high: "high" }), compat: {}, contextWindow: 200000, maxTokens: 12000 }, { reasoning: "high", maxTokens: 1000 });
  assert.equal(value.result.stopReason, "stop", value.result.errorMessage);
  assert.deepEqual(value.captured[0].body.thinking, { type: "enabled", budget_tokens: 10976 });
  assert.equal(value.captured[0].body.max_tokens, 12000);
  assert.equal(value.captured[0].env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "12000");
  assert.equal(value.captured[0].body.output_config, undefined);
});

test("Claude native transport refuses unsupported effort before starting the SDK", async () => {
  for (const reasoning of ["off", "minimal", "max"]) {
    const value = await fixture({ thinkingLevelMap: map({ high: "high" }), compat: { forceAdaptiveThinking: true } }, { reasoning });
    assert.equal(value.result.stopReason, "error");
    assert.match(value.result.errorMessage, /unavailable/);
    assert.equal(value.sdkCalls, 0);
  }
});

test("Claude mandatory and provider-default thinking omit disabling overrides", async () => {
  const mandatory = await fixture({ thinkingLevelMap: map({ high: "high" }), compat: { forceAdaptiveThinking: true } });
  assert.equal(mandatory.result.stopReason, "stop", mandatory.result.errorMessage);
  assert.equal(mandatory.captured[0].body.thinking, undefined);
  assert.equal(mandatory.captured[0].body.output_config, undefined);
  const defaultOnly = await fixture({ thinkingLevelMap: map({}), useProviderDefaultThinking: true, compat: {} });
  assert.equal(defaultOnly.result.stopReason, "stop", defaultOnly.result.errorMessage);
  assert.deepEqual(getSupportedThinkingLevels(defaultOnly.model), []);
  assert.equal(defaultOnly.captured[0].body.thinking, undefined);
  assert.equal(defaultOnly.captured[0].body.output_config, undefined);
});

test("Claude SDK-discovered effort metadata keeps adaptive and off behavior", async () => {
  const adaptive = await fixture({}, { reasoning: "medium" });
  assert.equal(adaptive.result.stopReason, "stop", adaptive.result.errorMessage);
  assert.deepEqual(getSupportedThinkingLevels(adaptive.model), ["off", "low", "medium", "high"]);
  assert.deepEqual(adaptive.captured[0].body.thinking, { type: "adaptive" });
  assert.deepEqual(adaptive.captured[0].body.output_config, { effort: "medium" });
  const off = await fixture({});
  assert.deepEqual(off.captured[0].body.thinking, { type: "disabled" });
});
