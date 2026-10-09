import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enterprisePiRoute,
  runEnterprisePi,
} from "../src/embedded/enterprise-pi.ts";
import { SteeringChannel } from "../src/steering.ts";
import type { ContainerRequest, RuntimeEvent } from "../src/types.ts";

function textStream(text: string, responseId: string) {
  const message = {
    id: `${responseId}_msg`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text,
        annotations: [],
      },
    ],
  };
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        model: "fixture-model",
        output: [],
      },
    },
    { type: "response.output_item.added", output_index: 0, item: message },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        model: "fixture-model",
        output: [message],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
        },
      },
    },
  ];
}

function functionCallStream(
  name: string,
  args: Record<string, unknown>,
  responseId: string,
) {
  const item = {
    id: `fc_${responseId}`,
    type: "function_call",
    call_id: `call_${responseId}`,
    name,
    arguments: JSON.stringify(args),
  };
  return [
    {
      type: "response.created",
      response: {
        id: `resp_${responseId}`,
        object: "response",
        status: "in_progress",
        model: "fixture-model",
        output: [],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${responseId}`,
        object: "response",
        status: "completed",
        model: "fixture-model",
        output: [item],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
        },
      },
    },
  ];
}

function readToolStream(path: string) {
  return functionCallStream("read", { path }, "read_1");
}

function gateway(t: test.TestContext, scripts?: unknown[][]) {
  const requests: { url: string; body: unknown; authorization?: string }[] = [];
  const original = globalThis.fetch;
  const sse = (events: unknown[]) =>
    new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
        "data: [DONE]\n\n",
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    requests.push({
      url: url.pathname,
      body,
      authorization: headers.get("authorization") ?? undefined,
    });
    if (url.pathname === "/v1/models")
      return Response.json({
        data: [{ id: "fixture-model", object: "model" }],
      });
    const next = scripts?.shift() ?? textStream("Durable answer", "resp_1");
    return sse(next);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return {
    baseUrl: "https://gateway.example.test",
    requests,
  };
}

function anthropicEvents(text: string, id = "msg_fixture") {
  return [
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-fixture",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
}

function anthropicGateway(t: test.TestContext, scripts?: unknown[][]) {
  const requests: {
    url: string;
    body: unknown;
    authorization?: string;
    apiKey?: string;
    beta?: string;
  }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    requests.push({
      url: url.pathname,
      body,
      authorization: headers.get("authorization") ?? undefined,
      apiKey: headers.get("x-api-key") ?? undefined,
      beta: headers.get("anthropic-beta") ?? undefined,
    });
    const next = scripts?.shift() ?? anthropicEvents("Claude durable answer");
    return new Response(
      next
        .map((event) => {
          const value = event as { type: string };
          return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
        })
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return {
    baseUrl: "https://gateway.example.test",
    requests,
    nativeFetch: original,
  };
}

function claudeQueryFixture(nativeFetch: typeof fetch) {
  return async (input: unknown) => {
    const { prompt, options } = input as {
      prompt: AsyncIterable<unknown>;
      options: {
        env: Record<string, string>;
        model: string;
        hooks?: Record<
          string,
          Array<{ hooks: Array<(event?: unknown) => unknown> }>
        >;
      };
    };
    return {
      async *[Symbol.asyncIterator]() {
        let compact = false;
        for await (const frame of prompt) {
          const text = (
            frame as { message?: { content?: Array<{ text?: string }> } }
          ).message?.content?.find(
            (block) => typeof block.text === "string",
          )?.text;
          if (text?.startsWith("/compact")) compact = true;
          if (compact) break;
        }
        if (compact)
          for (const group of options.hooks?.PreCompact ?? [])
            for (const hook of group.hooks) await hook();
        const response = await nativeFetch(
          `${options.env.ANTHROPIC_BASE_URL}/v1/messages`,
          {
            method: "POST",
            headers: {
              accept: "text/event-stream",
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
              "x-api-key": options.env.ANTHROPIC_API_KEY,
            },
            body: JSON.stringify({
              model: options.model,
              max_tokens: 1024,
              stream: true,
              messages: [{ role: "user", content: "fixture" }],
            }),
          },
        );
        const text = await response.text();
        for (const frame of text.split(/\r?\n\r?\n/)) {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) yield JSON.parse(data);
        }
        if (compact)
          for (const group of options.hooks?.PostCompact ?? [])
            for (const hook of group.hooks)
              await hook({ compact_summary: "fixture summary" });
        if (compact)
          yield {
            type: "system",
            subtype: "compact_boundary",
            uuid: "compact-boundary-fixture",
          };
        yield { type: "result", is_error: false, num_turns: compact ? 1 : 0 };
      },
      close() {},
    };
  };
}

function deferredGateway(t: test.TestContext) {
  const requests: { url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ url: url.pathname, body });
    if (url.pathname === "/v1/models")
      return Response.json({
        data: [{ id: "fixture-model", object: "model" }],
      });
    await released;
    return new Response("", { status: 499 });
  };
  t.after(() => {
    release();
    globalThis.fetch = original;
  });
  return {
    baseUrl: "https://gateway.example.test",
    release,
    requests,
  };
}

function request(baseUrl: string): ContainerRequest {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    projectId: "project",
    harness: "pi",
    model: "fixture-model",
    prompt: "Use durable execution",
    access: "write",
    gateway: { baseUrl, token: "synthetic-token" },
    pi: {},
  };
}

test("runPi executes embedded durable runtime through scoped gateway", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-enterprise-pi-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "fixture.txt"), "tool-visible\n");
  const g = gateway(t);
  const events: RuntimeEvent[] = [];
  await runEnterprisePi(
    request(g.baseUrl),
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    undefined,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  assert.ok(events.some((event) => event.type === "native_session"));
  assert.ok(events.some((event) => event.type === "native_update"));
  assert.ok(events.some((event) => event.type === "native_records"));
  assert.ok(
    events.some((event) => event.type === "assistant_delta"),
    JSON.stringify(events),
  );
  assert.ok(
    events.findIndex((event) => event.type === "input_accepted") <
      events.findIndex((event) => event.type === "assistant_delta"),
    JSON.stringify(events),
  );
  assert.equal(events.at(-1)?.type, "completed");
  assert.ok(g.requests.some((entry) => entry.url.includes("/v1/responses")));
  assert.match(
    await readFile(
      join(
        directory,
        "pi-enterprise",
        "durable",
        events.find((event) => event.type === "native_session")!.sessionId,
        "woven-session.json",
      ),
      "utf8",
    ),
    new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("runPi uses provider-native OpenAI route when resolver metadata is present", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-enterprise-pi-openai-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const g = gateway(t);
  const events: RuntimeEvent[] = [];
  await runEnterprisePi(
    {
      ...request(g.baseUrl),
      pi: {
        provider: "openai",
        api: "openai-responses",
        routeIdentity: "openai:fixture-model",
        supportsNativeCompaction: true,
      },
    },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    undefined,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  assert.equal(events.at(-1)?.type, "completed");
  assert.ok(g.requests.some((entry) => entry.url === "/v1/responses"));
  assert.doesNotMatch(JSON.stringify(g.requests), /local-server-/);
  assert.match(JSON.stringify(g.requests), /"model":"fixture-model"/);
});

test("Pi provider metadata maps Anthropic and xAI to native gateway APIs", () => {
  const base = request("https://gateway.example.test");
  assert.deepEqual(
    {
      provider: enterprisePiRoute({
        ...base,
        pi: { provider: "anthropic", api: "anthropic-messages" },
      }).provider,
      api: enterprisePiRoute({
        ...base,
        pi: { provider: "anthropic", api: "anthropic-messages" },
      }).api,
      baseUrl: enterprisePiRoute({
        ...base,
        pi: { provider: "anthropic", api: "anthropic-messages" },
      }).baseUrl,
    },
    {
      provider: "anthropic",
      api: "woven-claude-native",
      baseUrl: "https://gateway.example.test",
    },
  );
  assert.equal(
    enterprisePiRoute({
      ...base,
      pi: { provider: "xai", api: "openai-responses" },
    }).provider,
    "xai-api",
  );
  assert.equal(
    enterprisePiRoute({
      ...base,
      pi: { provider: "custom", api: "openai-compatible" },
    }).nativeCompaction,
    false,
  );
});

test("runPi uses Woven Claude native runtime through scoped Enterprise gateway", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-enterprise-pi-claude-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const g = anthropicGateway(t);
  const events: RuntimeEvent[] = [];
  await runEnterprisePi(
    {
      ...request(g.baseUrl),
      model: "claude-fixture",
      pi: {
        provider: "anthropic",
        api: "anthropic-messages",
        routeIdentity: "anthropic:fixture-route",
        supportsNativeCompaction: true,
        supportsReasoning: true,
      },
    },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    undefined,
    undefined,
    {
      sessionDirectory: directory,
      cwd: directory,
      claudeQuery: claudeQueryFixture(g.nativeFetch),
    },
  );
  assert.equal(events.at(-1)?.type, "completed", JSON.stringify(events));
  assert.ok(
    events.some(
      (event) =>
        event.type === "assistant_delta" &&
        event.delta.includes("Claude durable answer"),
    ),
    JSON.stringify(events),
  );
  const generation = g.requests.find((entry) => entry.url === "/v1/messages");
  assert.ok(generation, JSON.stringify(g.requests));
  assert.equal(generation.authorization, "Bearer synthetic-token");
  assert.equal(generation.apiKey, undefined);
  assert.equal(generation.beta, "fine-grained-tool-streaming-2025-05-14");
  assert.match(JSON.stringify(generation.body), /"model":"claude-fixture"/);
  assert.match(
    JSON.stringify(events.filter((event) => event.type === "native_records")),
    /claude-sdk/,
  );
});

for (const baseUrl of [
  "https://api.example.test/enterprise/api/runtime/inference/project/v1",
  "http://127.0.0.1:4101/inference/v1",
])
  test(`provider compaction and continuation use scoped gateway ${baseUrl}`, async () => {
    const { compactProviderContext, providerContinuationOptions } =
      await import(
        // @ts-ignore Copied WovenMatter runtime modules are authored as .mjs.
        "../src/embedded/default-agent/src/provider-compaction.mjs"
      );
    const requests: Array<{
      url: string;
      authorization?: string;
      body: Record<string, unknown>;
    }> = [];
    const model = {
      provider: "openai",
      id: "gpt-5-fixture",
      api: "openai-responses",
      baseUrl,
      contextWindow: 128000,
      maxTokens: 16384,
      input: ["text"],
      compat: {},
    };
    const route = {
      provider: "openai",
      accountID: "default",
      modelID: "gpt-5-fixture",
      authIdentity: "enterprise-route",
    };
    const runtime = {
      async getAuth() {
        return {
          auth: {
            apiKey: "scoped-run-token",
            baseUrl: model.baseUrl,
            enterpriseGateway: true,
          },
        };
      },
    };
    const fetchRequest = async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push({
        url: new URL(String(url)).pathname,
        authorization:
          new Headers(init?.headers).get("authorization") ?? undefined,
        body,
      });
      assert.equal(body.model, "gpt-5-fixture");
      return Response.json({
        id: "compact_1",
        model: "gpt-5-fixture",
        output: [
          { type: "message", role: "system", opaque_provider_state: "kept" },
          { type: "compaction", encrypted_content: "opaque-window" },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
        },
      });
    };
    const first = await compactProviderContext({
      model,
      route,
      runtime,
      fetchRequest,
      context: {
        messages: [
          { role: "user", content: [{ type: "text", text: "remember alpha" }] },
        ],
      },
    });
    assert.equal(
      requests[0].url,
      new URL(baseUrl).pathname + "/responses/compact",
    );
    assert.equal(requests[0].authorization, "Bearer scoped-run-token");
    assert.equal(first.continuation.windowJSON, first.responseJSON);
    assert.deepEqual(first.continuation.output.at(-1), {
      type: "compaction",
      encrypted_content: "opaque-window",
    });
    await compactProviderContext({
      model,
      route,
      runtime,
      fetchRequest,
      continuation: first.continuation,
      context: {
        messages: [
          { role: "user", content: [{ type: "text", text: "continue beta" }] },
        ],
      },
    });
    assert.deepEqual(
      (requests[1].body.input as unknown[]).slice(0, 2),
      first.continuation.output,
    );
    const continuation = await providerContinuationOptions({
      model,
      route,
      runtime,
      continuation: first.continuation,
    });
    const payload = {
      model: model.id,
      input: [{ role: "user", content: "continue" }],
    };
    assert.deepEqual(
      continuation.onPayload(payload, model).input.slice(0, 2),
      first.continuation.output,
    );
    assert.throws(
      () =>
        continuation.onPayload(payload, {
          ...model,
          baseUrl: "https://another.example.test/v1",
        }),
      /different|route|request/i,
    );
    for (const rejectedUrl of [
      "http://127.0.0.1:4102/inference/v1",
      "http://127.0.0.1:4101/other/v1",
      "http://external.example.test/v1",
      "http://user:password@127.0.0.1:4101/inference/v1",
      "http://127.0.0.1:4101/inference/v1?query=1",
    ]) {
      await assert.rejects(
        compactProviderContext({
          model: { ...model, baseUrl: rejectedUrl },
          route,
          runtime: {
            getAuth: async () => ({
              auth: {
                apiKey: "synthetic",
                baseUrl: rejectedUrl,
                enterpriseGateway: true,
              },
            }),
          },
          context: { messages: [] },
          fetchRequest: () => {
            throw Error("Rejected routes must never dispatch");
          },
        }),
        /secure provider endpoint/i,
      );
    }
    await assert.rejects(
      compactProviderContext({
        model: { ...model, baseUrl: "http://127.0.0.1:4101/inference/v1" },
        route,
        runtime: {
          getAuth: async () => ({
            auth: {
              apiKey: "synthetic",
              baseUrl: "http://127.0.0.1:4101/inference/v1",
            },
          }),
        },
        context: { messages: [] },
      }),
      /secure provider endpoint/i,
    );
    await assert.rejects(
      () =>
        providerContinuationOptions({
          model: { ...model, id: "other-model" },
          route,
          runtime,
          signal: undefined,
          continuation: first.continuation,
        }),
      /different|route|model|account/i,
    );
  });

test("runPi cancels after native acceptance without reporting completion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-enterprise-pi-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const g = deferredGateway(t);
  const abort = new AbortController();
  const events: RuntimeEvent[] = [];
  await runEnterprisePi(
    request(g.baseUrl),
    async (event) => {
      events.push(event);
      if (event.type === "input_accepted") abort.abort();
    },
    abort.signal,
    undefined,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  g.release();
  assert.ok(events.some((event) => event.type === "input_accepted"));
  assert.equal(events.at(-1)?.type, "cancelled", JSON.stringify(events));
  assert.ok(!events.some((event) => event.type === "completed"));
});

test("runPi rejects duplicate run id with different content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-enterprise-pi-dedupe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstGateway = gateway(t, [textStream("Stable answer", "resp_stable")]);
  const firstEvents: RuntimeEvent[] = [];
  const firstRequest = {
    ...request(firstGateway.baseUrl),
    runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  };
  await runEnterprisePi(
    firstRequest,
    async (event) => {
      firstEvents.push(event);
    },
    new AbortController().signal,
    undefined,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  const sessionId = firstEvents.find(
    (event) => event.type === "native_session",
  )!.sessionId;
  const secondGateway = gateway(t, [textStream("Should not run", "resp_bad")]);
  const secondEvents: RuntimeEvent[] = [];
  await runEnterprisePi(
    {
      ...firstRequest,
      gateway: { baseUrl: secondGateway.baseUrl, token: "synthetic-token" },
      prompt: "Different content for same id",
      resumeId: sessionId,
    },
    async (event) => {
      secondEvents.push(event);
    },
    new AbortController().signal,
    undefined,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  assert.equal(
    secondEvents.at(-1)?.type,
    "failed",
    JSON.stringify(secondEvents),
  );
  assert.equal(
    secondGateway.requests.filter((entry) =>
      entry.url.includes("/v1/responses"),
    ).length,
    0,
    JSON.stringify(secondGateway.requests),
  );
});

test("runPi accepts steering through the durable native session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-enterprise-pi-steer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: { url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let responseCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ url: url.pathname, body });
    if (url.pathname === "/v1/models")
      return Response.json({
        data: [{ id: "fixture-model", object: "model" }],
      });
    responseCount++;
    if (responseCount === 1) await firstGate;
    const events = textStream(
      responseCount === 1 ? "Initial answer" : "Steered answer",
      responseCount === 1 ? "resp_initial" : "resp_steered",
    );
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  t.after(() => {
    releaseFirst();
    globalThis.fetch = original;
  });
  const channel = new SteeringChannel();
  const events: RuntimeEvent[] = [];
  let steeringReceipt: Promise<void> | undefined;
  await runEnterprisePi(
    request("https://gateway.example.test"),
    async (event) => {
      events.push(event);
      if (event.type === "input_accepted" && !steeringReceipt) {
        steeringReceipt = channel.submit({
          id: "steer-1",
          sequence: 2,
          authorId: "person",
          authorName: "Named author",
          content: "Please steer now",
        });
        releaseFirst();
      }
    },
    new AbortController().signal,
    channel,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  await steeringReceipt;
  assert.equal(events.at(-1)?.type, "completed");
  assert.ok(
    requests.some((entry) =>
      JSON.stringify(entry.body).includes("Named author"),
    ),
    JSON.stringify(requests),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "assistant_delta" && event.delta.includes("Steered"),
    ),
    JSON.stringify(events),
  );
});

test("runPi refreshes retained gateway token while preserving native session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-enterprise-pi-token-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const retained: { pi?: unknown } = {};
  const firstGateway = gateway(t, [textStream("First token", "resp_token_1")]);
  const firstEvents: RuntimeEvent[] = [];
  await runEnterprisePi(
    {
      ...request(firstGateway.baseUrl),
      gateway: { baseUrl: firstGateway.baseUrl, token: "token-one" },
    },
    async (event) => {
      firstEvents.push(event);
    },
    new AbortController().signal,
    undefined,
    retained,
    { sessionDirectory: directory, cwd: directory },
  );
  const sessionId = firstEvents.find(
    (event) => event.type === "native_session",
  )!.sessionId;
  const secondGateway = gateway(t, [
    textStream("Second token", "resp_token_2"),
  ]);
  const secondEvents: RuntimeEvent[] = [];
  await runEnterprisePi(
    {
      ...request(secondGateway.baseUrl),
      runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      prompt: "Continue after token refresh",
      gateway: { baseUrl: secondGateway.baseUrl, token: "token-two" },
    },
    async (event) => {
      secondEvents.push(event);
    },
    new AbortController().signal,
    undefined,
    retained,
    { sessionDirectory: directory, cwd: directory },
  );
  assert.equal(
    secondEvents.find((event) => event.type === "native_session")!.sessionId,
    sessionId,
  );
  assert.ok(
    secondGateway.requests.some(
      (entry) =>
        entry.url.includes("/v1/responses") &&
        entry.authorization === "Bearer token-two",
    ),
    JSON.stringify(secondGateway.requests),
  );
});

test("runPi applies retained Pi option changes on the next idle turn", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-enterprise-pi-options-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const retained: { pi?: unknown } = {};
  const g = gateway(t, [
    textStream("Code mode on", "resp_options_1"),
    textStream("Code mode off", "resp_options_2"),
  ]);
  await runEnterprisePi(
    {
      ...request(g.baseUrl),
      pi: { codeMode: "on", subagentConcurrency: 2 },
    },
    async () => {},
    new AbortController().signal,
    undefined,
    retained,
    { sessionDirectory: directory, cwd: directory },
  );
  await runEnterprisePi(
    {
      ...request(g.baseUrl),
      runId: "99999999-9999-4999-8999-999999999999",
      prompt: "Continue with code mode disabled",
      pi: { codeMode: "off", subagentConcurrency: 3 },
    },
    async () => {},
    new AbortController().signal,
    undefined,
    retained,
    { sessionDirectory: directory, cwd: directory },
  );
  const responseBodies = g.requests
    .filter((entry) => entry.url === "/v1/responses")
    .map((entry) => entry.body as { tools?: Array<{ name?: string }> });
  assert.ok(
    responseBodies[0]?.tools?.some((tool) => tool.name === "codemode"),
    JSON.stringify(responseBodies[0]),
  );
  assert.ok(
    !responseBodies[1]?.tools?.some((tool) => tool.name === "codemode"),
    JSON.stringify(responseBodies[1]),
  );
});

test("runPi reopens native session with stable gateway route across run ids", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-enterprise-pi-reopen-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstGateway = gateway(t, [
    textStream("First durable answer", "resp_first"),
  ]);
  const firstEvents: RuntimeEvent[] = [];
  await runEnterprisePi(
    {
      ...request(firstGateway.baseUrl),
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
    async (event) => {
      firstEvents.push(event);
    },
    new AbortController().signal,
    undefined,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  const sessionId = firstEvents.find(
    (event) => event.type === "native_session",
  )!.sessionId;
  const providerBefore = JSON.stringify(firstGateway.requests).match(
    /local-server-[a-f0-9-]{36}/,
  )?.[0];
  const secondGateway = gateway(t, [
    textStream("Second durable answer", "resp_second"),
  ]);
  const secondEvents: RuntimeEvent[] = [];
  await runEnterprisePi(
    {
      ...request(secondGateway.baseUrl),
      runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      prompt: "Continue with prior context",
      resumeId: sessionId,
    },
    async (event) => {
      secondEvents.push(event);
    },
    new AbortController().signal,
    undefined,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  assert.equal(
    secondEvents.find((event) => event.type === "native_session")!.sessionId,
    sessionId,
  );
  assert.match(JSON.stringify(secondGateway.requests), /First durable answer/);
  assert.equal(
    JSON.stringify(secondGateway.requests).match(
      /local-server-[a-f0-9-]{36}/,
    )?.[0],
    providerBefore,
  );
});

test("runPi keeps one durable session through model A to B to A across worker reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-enterprise-pi-aba-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstGateway = gateway(t, [
    textStream("Alpha from model A", "resp_a1"),
  ]);
  const firstEvents: RuntimeEvent[] = [];
  await runEnterprisePi(
    {
      ...request(firstGateway.baseUrl),
      runId: "10000000-0000-4000-8000-000000000001",
      model: "fixture-model-a",
      pi: { provider: "openai", routeIdentity: "route-a" },
    },
    (event) => {
      firstEvents.push(event);
    },
    new AbortController().signal,
    undefined,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  assert.equal(firstEvents.at(-1)?.type, "completed");
  const sessionId = firstEvents.find(
    (event) => event.type === "native_session",
  )!.sessionId;
  const secondGateway = gateway(t, [
    textStream("Beta from model B", "resp_b1"),
  ]);
  const secondEvents: RuntimeEvent[] = [];
  await runEnterprisePi(
    {
      ...request(secondGateway.baseUrl),
      runId: "10000000-0000-4000-8000-000000000002",
      model: "grok-4",
      prompt: "Continue on model B",
      resumeId: sessionId,
      pi: { provider: "xai", routeIdentity: "route-b" },
    },
    (event) => {
      secondEvents.push(event);
    },
    new AbortController().signal,
    undefined,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  assert.equal(secondEvents.at(-1)?.type, "completed");
  assert.equal(
    secondEvents.find((event) => event.type === "native_session")!.sessionId,
    sessionId,
  );
  assert.match(JSON.stringify(secondGateway.requests), /Alpha from model A/);
  assert.match(JSON.stringify(secondGateway.requests), /"model":"grok-4"/);
  const thirdGateway = gateway(t, [
    textStream("Gamma from model A", "resp_a2"),
  ]);
  const thirdEvents: RuntimeEvent[] = [];
  await runEnterprisePi(
    {
      ...request(thirdGateway.baseUrl),
      runId: "10000000-0000-4000-8000-000000000003",
      model: "fixture-model-a",
      prompt: "Return to model A",
      resumeId: sessionId,
      pi: { provider: "openai", routeIdentity: "route-a" },
    },
    (event) => {
      thirdEvents.push(event);
    },
    new AbortController().signal,
    undefined,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  assert.equal(thirdEvents.at(-1)?.type, "completed");
  assert.equal(
    thirdEvents.find((event) => event.type === "native_session")!.sessionId,
    sessionId,
  );
  const thirdPayload = JSON.stringify(thirdGateway.requests);
  assert.match(thirdPayload, /Alpha from model A/);
  assert.match(thirdPayload, /Beta from model B/);
});

test("runPi clears explicit thinking override back to model default", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "wme-enterprise-pi-thinking-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const retained: { pi?: unknown } = {};
  const firstGateway = gateway(t, [textStream("High thinking", "resp_high")]);
  const firstEvents: RuntimeEvent[] = [];
  await runEnterprisePi(
    {
      ...request(firstGateway.baseUrl),
      runId: "20000000-0000-4000-8000-000000000001",
      pi: { provider: "openai", supportsReasoning: true, thinking: "high" },
    },
    (event) => {
      firstEvents.push(event);
    },
    new AbortController().signal,
    undefined,
    retained,
    { sessionDirectory: directory, cwd: directory },
  );
  const sessionId = firstEvents.find(
    (event) => event.type === "native_session",
  )!.sessionId;
  const secondGateway = gateway(t, [
    textStream("Default thinking", "resp_default"),
  ]);
  await runEnterprisePi(
    {
      ...request(secondGateway.baseUrl),
      runId: "20000000-0000-4000-8000-000000000002",
      prompt: "Clear thinking override",
      resumeId: sessionId,
      pi: { provider: "openai", supportsReasoning: true },
    },
    async () => {},
    new AbortController().signal,
    undefined,
    retained,
    { sessionDirectory: directory, cwd: directory },
  );
  const payload = JSON.stringify(
    secondGateway.requests.filter((entry) => entry.url === "/v1/responses"),
  );
  assert.match(payload, /medium/);
});

test("runPi executes embedded read tool and returns tool result to the model", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-enterprise-pi-tool-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "fixture.txt"), "tool-visible\n");
  const g = gateway(t, [
    readToolStream("fixture.txt"),
    textStream("I read tool-visible", "resp_final"),
  ]);
  const events: RuntimeEvent[] = [];
  await runEnterprisePi(
    request(g.baseUrl),
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    undefined,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  assert.equal(events.at(-1)?.type, "completed");
  assert.ok(
    g.requests.some((entry) =>
      JSON.stringify(entry.body).includes("tool-visible"),
    ),
    JSON.stringify(g.requests),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "native_update" &&
        JSON.stringify(event.update).includes('"tool_call"'),
    ),
    JSON.stringify(events),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "assistant_delta" &&
        event.delta.includes("I read tool-visible"),
    ),
    JSON.stringify(events),
  );
});

test("runPi executes attached native subagent and retains reports", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-enterprise-pi-child-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const g = gateway(t, [
    functionCallStream(
      "subagent",
      { action: "spawn", name: "helper", task: "Say child result" },
      "spawn_1",
    ),
    textStream("child result", "resp_child"),
    textStream("parent saw child result", "resp_parent"),
  ]);
  const events: RuntimeEvent[] = [];
  await runEnterprisePi(
    {
      ...request(g.baseUrl),
      prompt: "Delegate to a helper",
      pi: { subagentConcurrency: 2 },
    },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    undefined,
    undefined,
    { sessionDirectory: directory, cwd: directory },
  );
  assert.equal(events.at(-1)?.type, "completed");
  const responseCalls = g.requests.filter((entry) =>
    entry.url.includes("/v1/responses"),
  );
  assert.ok(responseCalls.length >= 3, JSON.stringify(g.requests));
  assert.ok(
    events.some(
      (event) =>
        event.type === "native_update" &&
        event.update.sessionUpdate === "woven_subagents",
    ),
    JSON.stringify(events),
  );
  assert.ok(
    JSON.stringify(events).includes("child result"),
    JSON.stringify(events),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "native_records" &&
        JSON.stringify(event.batch).includes("parent saw child result"),
    ),
    JSON.stringify(events),
  );
});
