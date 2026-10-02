import test from "node:test";
import assert from "node:assert/strict";
import {
  codexConfig,
  grokConfig,
  runCodex,
  runGrok,
  egressEnvironment,
  applyEgressEnvironment,
  type RpcFactory,
} from "../src/native.ts";
import { JsonRpcProcess, type RpcMessage } from "../src/rpc.ts";
import { validateContainerRequest, validateEvent } from "../src/validation.ts";
import type { ContainerRequest, RuntimeEvent } from "../src/types.ts";
const request: ContainerRequest = {
  runId: "run1",
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
  calls: {
    method: string;
    params: any;
  }[] = [];
  sent: RpcMessage[] = [];
  closed = new Promise<void>(() => {});
  stopped = false;
  failTurn = false;
  loadSession = true;
  serverRequest = false;
  async request(method: string, params: any): Promise<any> {
    this.calls.push({
      method,
      params,
    });
    if (method === "initialize")
      return {
        agentCapabilities: {
          loadSession: this.loadSession,
        },
      };
    if (["thread/start", "thread/resume"].includes(method))
      return {
        thread: {
          id: "thread1",
        },
      };
    if (method === "turn/start") {
      if (this.serverRequest)
        await this.onMessage({
          id: "permission1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread1",
          },
        });
      else {
        await this.onMessage({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread1",
            delta: "Observed answer",
          },
        });
        await this.onMessage({
          method: "turn/completed",
          params: {
            threadId: "thread1",
            turn: {
              status: this.failTurn ? "failed" : "completed",
            },
          },
        });
      }
      return {
        turn: {
          id: "turn1",
        },
      };
    }
    if (method === "session/new")
      return {
        sessionId: "session1",
      };
    if (method === "session/load") return {};
    if (method === "session/prompt") {
      await this.onMessage({
        method: "session/request_permission",
        id: 999,
        params: {
          options: [
            {
              kind: "allow_once",
              optionId: "once",
            },
            {
              kind: "allow_always",
              optionId: "always",
            },
          ],
        },
      });
      await this.onMessage({
        method: "session/update",
        params: {
          sessionId: "session1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "ACP answer",
            },
          },
        },
      });
      return {
        stopReason: this.failTurn ? "max_tokens" : "end_turn",
      };
    }
    return {};
  }
  send(message: RpcMessage) {
    this.sent.push(message);
  }
  async flush() {}
  close() {
    this.stopped = true;
  }
}
const factory =
  (fixture: FixtureRpc): RpcFactory =>
  () =>
    fixture as unknown as JsonRpcProcess;
test("Codex and Grok retain native transports across explicit successive turns", async () => {
  for (const [harness, run] of [
    ["codex", runCodex],
    ["grok", runGrok],
  ] as const) {
    const rpc = new FixtureRpc(),
      retained = {};
    let launches = 0;
    const create: RpcFactory = () => {
      launches++;
      return rpc as unknown as JsonRpcProcess;
    };
    const first: RuntimeEvent[] = [],
      second: RuntimeEvent[] = [];
    await run(
      { ...request, harness },
      async (e) => {
        first.push(e);
      },
      new AbortController().signal,
      create,
      undefined,
      retained,
    );
    await run(
      {
        ...request,
        harness,
        runId: "next-turn",
        prompt: "Continue explicitly",
      },
      async (e) => {
        second.push(e);
      },
      new AbortController().signal,
      create,
      undefined,
      retained,
    );
    assert.equal(launches, 1);
    assert.equal(rpc.calls.filter((c) => c.method === "initialize").length, 1);
    assert.equal(
      rpc.calls.filter(
        (c) =>
          c.method === (harness === "codex" ? "turn/start" : "session/prompt"),
      ).length,
      2,
    );
    assert.equal(rpc.stopped, false);
    assert.deepEqual(
      second.find((e) => e.type === "native_session"),
      first.find((e) => e.type === "native_session"),
    );
  }
});

test("failed retained native turns evict their transport and only a new explicit prompt resumes history", async () => {
  const dead = new FixtureRpc(),
    replacement = new FixtureRpc(),
    retained = {};
  dead.failTurn = true;
  let launches = 0;
  const create: RpcFactory = () =>
    (++launches === 1 ? dead : replacement) as unknown as JsonRpcProcess;
  await assert.rejects(
    runCodex(
      request,
      async () => {},
      new AbortController().signal,
      create,
      undefined,
      retained,
    ),
  );
  assert.equal(launches, 1);
  assert.equal(dead.stopped, true);
  await runCodex(
    {
      ...request,
      runId: "explicit-next",
      resumeId: "thread1",
      prompt: "Review the uncertain result",
    },
    async () => {},
    new AbortController().signal,
    create,
    undefined,
    retained,
  );
  assert.equal(launches, 2);
  assert.ok(replacement.calls.some((c) => c.method === "thread/resume"));
  assert.equal(
    replacement.calls.filter((c) => c.method === "turn/start").length,
    1,
  );
});
test("Codex resumes native identity and emits actual ordered deltas", async () => {
  const rpc = new FixtureRpc(),
    events: RuntimeEvent[] = [];
  let environment: Record<string, string> = {};
  await runCodex(
    {
      ...request,
      resumeId: "thread1",
    },
    (e) => {
      events.push(e);
    },
    new AbortController().signal,
    (_command, _args, env) => {
      environment = env;
      return rpc as unknown as JsonRpcProcess;
    },
  );
  assert.deepEqual(events, [
    {
      type: "native_session",
      sessionId: "thread1",
    },
    {
      type: "assistant_delta",
      delta: "Observed answer",
    },
    {
      type: "input_accepted",
    },
  ]);
  assert.deepEqual(
    rpc.calls.map((c) => c.method),
    ["initialize", "thread/resume", "turn/start"],
  );
  assert.equal(rpc.calls[1].params.approvalPolicy, "never");
  assert.equal(rpc.stopped, true);
  assert.ok(
    !Object.keys(environment).some((key) =>
      key.toLowerCase().includes("proxy"),
    ),
  );
});
test("Claude SDK query and Pi SDK session survive successive completed turns", async (t) => {
  const { runClaude, drivePiSession } = await import("../src/sdk.js");
  const { mkdtemp, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "wme-retained-sdk-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let queries = 0,
    closed = 0;
  const retained: import("../src/native.js").NativeSessionState = {};
  const query = (({ prompt }: any) => {
    queries++;
    return Object.assign(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "retained-sdk" };
        for await (const input of prompt)
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            user_message_uuids: [input.uuid],
          };
      })(),
      {
        close() {
          closed++;
        },
      },
    );
  }) as any;
  for (let i = 0; i < 2; i++) {
    const events: RuntimeEvent[] = [];
    await runClaude(
      { ...request, runId: "sdk-" + i, harness: "claude" },
      async (e) => {
        events.push(e);
      },
      new AbortController().signal,
      undefined,
      { query, sessionDirectory: directory },
      retained,
    );
    assert.ok(
      events.some(
        (e) => e.type === "native_session" && e.sessionId === "retained-sdk",
      ),
    );
    assert.ok(events.some((e) => e.type === "input_accepted"));
  }
  assert.equal(queries, 1);
  assert.equal(closed, 0);
  retained.claude!.input.end();
  await retained.claude!.iterator.return?.();
  let prompts = 0,
    disposed = 0;
  const session = {
    sessionId: "pi-retained",
    subscribe() {
      return () => {};
    },
    async prompt(_text: string, options: any) {
      prompts++;
      await options.onInputAccepted?.();
    },
    async abort() {},
    clearQueue() {},
    dispose() {
      disposed++;
    },
  };
  for (let i = 0; i < 2; i++)
    await drivePiSession(
      session as any,
      { ...request, harness: "pi" },
      async () => {},
      new AbortController().signal,
      undefined,
      true,
    );
  assert.equal(prompts, 2);
  assert.equal(disposed, 0);
});
test("Codex failure is not converted into an answer or retried", async () => {
  const rpc = new FixtureRpc();
  rpc.failTurn = true;
  await assert.rejects(
    runCodex(request, () => {}, new AbortController().signal, factory(rpc)),
    /did not complete/,
  );
  assert.equal(rpc.calls.filter((c) => c.method === "turn/start").length, 1);
});
test("unexpected native authentication or permission requests fail closed", async () => {
  const rpc = new FixtureRpc();
  rpc.serverRequest = true;
  await assert.rejects(
    runCodex(request, () => {}, new AbortController().signal, factory(rpc)),
    /interactive/,
  );
  assert.ok(rpc.sent.some((m) => m.id === "permission1" && m.error));
});
test("Grok ACP is initialized, uses native session loading, and emits deltas", async () => {
  const rpc = new FixtureRpc(),
    events: RuntimeEvent[] = [];
  await runGrok(
    {
      ...request,
      harness: "grok",
      resumeId: "session1",
    },
    (e) => {
      events.push(e);
    },
    new AbortController().signal,
    factory(rpc),
  );
  assert.deepEqual(
    rpc.calls.map((c) => c.method),
    ["initialize", "session/load", "session/prompt"],
  );
  assert.equal(
    (rpc.sent.find((m) => m.id === 999)?.result as any).outcome.optionId,
    "once",
  );
  assert.equal(
    events.find((e) => e.type === "assistant_delta")?.type,
    "assistant_delta",
  );
});
test("Grok never silently restarts when native resume is unsupported", async () => {
  const rpc = new FixtureRpc();
  rpc.loadSession = false;
  await assert.rejects(
    runGrok(
      {
        ...request,
        harness: "grok",
        resumeId: "session1",
      },
      () => {},
      new AbortController().signal,
      factory(rpc),
    ),
    /cannot restore/,
  );
  assert.equal(rpc.calls.length, 1);
});
test("native configs target central gateway and never persist the token", () => {
  for (const config of [codexConfig(request), grokConfig(request)]) {
    assert.ok(config.includes(request.gateway.baseUrl + "/v1"));
    assert.ok(config.includes("WME_INFERENCE_TOKEN"));
    assert.ok(!config.includes(request.gateway.token));
  }
  assert.throws(
    () =>
      validateContainerRequest({
        ...request,
        model: 'model"\ninjected=true',
      }),
    /Invalid model/,
  );
  assert.throws(
    () =>
      validateContainerRequest({
        ...request,
        gateway: {
          ...request.gateway,
          baseUrl: "http://token@api/path",
        },
      }),
    /gateway/,
  );
});
test("public egress uses only the scoped run credential and bypasses only gateway/loopback", () => {
  assert.deepEqual(egressEnvironment(request), {});
  const env = egressEnvironment({
      ...request,
      egressProxyUrl: "http://api:4101",
    }),
    proxy = new URL(env.HTTPS_PROXY);
  assert.equal(proxy.hostname, "api");
  assert.equal(proxy.port, "4101");
  assert.equal(proxy.username, request.projectId);
  assert.equal(proxy.password, request.gateway.token);
  assert.equal(env.NO_PROXY, "api,localhost,127.0.0.1,::1");
  assert.ok(!env.NO_PROXY.includes("*"));
  assert.equal(env.http_proxy, env.HTTP_PROXY);
  assert.equal(env.https_proxy, env.HTTPS_PROXY);
  assert.equal(env.npm_config_https_proxy, env.HTTPS_PROXY);
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
});
test("egress capability accepts only credential-free same-gateway explicit HTTP ports", () => {
  validateContainerRequest({
    ...request,
    egressProxyUrl: "http://api:4101",
  });
  for (const egressProxyUrl of [
    "http://api",
    "http://api:80",
    "https://api:4101",
    "http://other:4101",
    "http://u:p@api:4101",
    "http://api:4101/path",
    "http://api:4101?x=1",
    "http://api:4101#fragment",
    "invalid",
  ]) {
    assert.throws(
      () =>
        validateContainerRequest({
          ...request,
          egressProxyUrl,
        }),
      /egress/,
    );
  }
});
test("native child proxy environments contain only scoped credentials and the explicit variable list", async () => {
  const enabled = {
    ...request,
    egressProxyUrl: "http://api:4101",
  };
  for (const run of [runCodex, runGrok]) {
    const fixture = new FixtureRpc();
    let environment: Record<string, string> = {};
    const previous = process.env.WME_TEST_AMBIENT_SECRET;
    process.env.WME_TEST_AMBIENT_SECRET = "must-not-cross";
    try {
      await run(
        enabled,
        () => {},
        new AbortController().signal,
        (_command, _args, env) => {
          environment = env;
          return fixture as unknown as JsonRpcProcess;
        },
      );
    } finally {
      if (previous === undefined) delete process.env.WME_TEST_AMBIENT_SECRET;
      else process.env.WME_TEST_AMBIENT_SECRET = previous;
    }
    assert.equal(environment.WME_TEST_AMBIENT_SECRET, undefined);
    assert.equal(
      environment.HTTPS_PROXY,
      egressEnvironment(enabled).HTTPS_PROXY,
    );
    assert.equal(environment.NO_PROXY, "api,localhost,127.0.0.1,::1");
  }
  const config = codexConfig(enabled);
  assert.ok(config.includes("include_only ="));
  assert.ok(config.includes('"HTTP_PROXY"'));
  assert.ok(!config.includes('inherit = "all"'));
  assert.ok(!config.includes(enabled.gateway.token));
});
test("embedded runtime enables scoped proxy variables and restores the prior environment", () => {
  const previous = process.env.HTTPS_PROXY;
  const enabled = {
    ...request,
    egressProxyUrl: "http://api:4101",
  };
  const restore = applyEgressEnvironment(enabled);
  try {
    assert.equal(
      process.env.HTTPS_PROXY,
      egressEnvironment(enabled).HTTPS_PROXY,
    );
  } finally {
    restore();
  }
  assert.equal(process.env.HTTPS_PROXY, previous);
  const restoreDisabled = applyEgressEnvironment(request);
  try {
    assert.equal(process.env.HTTPS_PROXY, undefined);
  } finally {
    restoreDisabled();
  }
  assert.equal(process.env.HTTPS_PROXY, previous);
});
test("normalized events reject unknown fields and bound tool metadata", () => {
  assert.deepEqual(
    validateEvent({
      type: "completed",
      token: "must-not-cross",
    }),
    {
      type: "completed",
    },
  );
  assert.throws(
    () =>
      validateEvent({
        type: "native_session",
        sessionId: "../../escape",
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      validateEvent({
        type: "assistant_delta",
        delta: {},
      }),
    /Invalid/,
  );
});
test("real stdio transport supports interleaved notifications and responses", async () => {
  const program = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){let m=JSON.parse(b.slice(0,n));b=b.slice(n+1);process.stdout.write(JSON.stringify({method:'notice',params:{value:m.params.value}})+'\\n');process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n')}});`;
  const rpc = new JsonRpcProcess(
    process.execPath,
    ["-e", program],
    {
      PATH: process.env.PATH ?? "",
    },
    process.cwd(),
  );
  const events: unknown[] = [];
  rpc.onMessage = async (m) => {
    events.push(m.params.value);
  };
  try {
    assert.deepEqual(
      await rpc.request("test", {
        value: 4,
      }),
      {
        ok: true,
      },
    );
    await rpc.flush();
    assert.deepEqual(events, [4]);
  } finally {
    rpc.close();
  }
});
test("real stdio transport rejects oversized native protocol data", async () => {
  const rpc = new JsonRpcProcess(
    process.execPath,
    [
      "-e",
      `process.stdout.write('x'.repeat(1048577));setTimeout(()=>{},10000);`,
    ],
    {},
    process.cwd(),
  );
  await assert.rejects(rpc.closed, /exceeds limit/);
  rpc.close();
});
test("Codex active steering uses expectedTurnId and does not launch a second turn", async () => {
  const { SteeringChannel } = await import("../src/steering.js"),
    rpc = new FixtureRpc(),
    channel = new SteeringChannel(),
    events: RuntimeEvent[] = [];
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    if (method === "turn/start") {
      rpc.calls.push({
        method,
        params,
      });
      return {
        turn: {
          id: "active-turn",
        },
      };
    }
    return original(method, params);
  };
  const run = runCodex(
    request,
    (e) => {
      events.push(e);
    },
    new AbortController().signal,
    (() => rpc) as unknown as RpcFactory,
    channel,
  );
  const input = {
    id: "message-one",
    sequence: 2,
    authorId: "person-2",
    authorName: "Second person",
    content: "Change direction",
  };
  await channel.submit(input);
  const steer = rpc.calls.find((c) => c.method === "turn/steer")!;
  assert.equal(steer.params.expectedTurnId, "active-turn");
  assert.match(steer.params.input[0].text, /Second person/);
  assert.equal(rpc.calls.filter((c) => c.method === "turn/start").length, 1);
  await rpc.onMessage({
    method: "turn/completed",
    params: {
      threadId: "thread1",
      turn: {
        id: "active-turn",
        status: "completed",
      },
    },
  });
  await run;
  assert.ok(events.some((e) => e.type === "input_accepted"));
  await assert.rejects(
    channel.submit({
      ...input,
      id: "late",
    }),
    {
      code: "run_ended",
    },
  );
});
test("Grok interject is native active input and an unsupported provider reports a constraint", async () => {
  const { SteeringChannel } = await import("../src/steering.js"),
    { RuntimeError } = await import("../src/types.js"),
    rpc = new FixtureRpc(),
    channel = new SteeringChannel();
  let end!: () => void;
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    if (method === "session/prompt") {
      rpc.calls.push({
        method,
        params,
      });
      await new Promise<void>((r) => {
        end = r;
      });
      return {
        stopReason: "end_turn",
      };
    }
    if (method === "_x.ai/interject") {
      rpc.calls.push({
        method,
        params,
      });
      throw new RuntimeError("protocol_rejected", "Unsupported");
    }
    return original(method, params);
  };
  const run = runGrok(
    {
      ...request,
      harness: "grok",
    },
    () => {},
    new AbortController().signal,
    (() => rpc) as unknown as RpcFactory,
    channel,
  );
  await assert.rejects(
    channel.submit({
      id: "message",
      sequence: 1,
      authorId: "person",
      authorName: "Person",
      content: "Update",
    }),
    {
      code: "steering_unavailable",
    },
  );
  assert.equal(
    rpc.calls.filter((c) => c.method === "session/prompt").length,
    1,
  );
  assert.equal(
    rpc.calls.find((c) => c.method === "_x.ai/interject")!.params.sessionId,
    "session1",
  );
  end();
  await run;
});
test("Claude owns late admitted input through its matching result, not merely its echo or original result", async (t) => {
  const { runClaude } = await import("../src/sdk.js"),
    { SteeringChannel } = await import("../src/steering.js"),
    { mkdtemp, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "wme-claude-stream-"));
  t.after(() =>
    rm(dir, {
      recursive: true,
      force: true,
    }),
  );
  const channel = new SteeringChannel();
  let release!: () => void, seenInitialResult!: () => void;
  const resultObserved = new Promise<void>((r) => {
      seenInitialResult = r;
    }),
    continuation = new Promise<void>((r) => {
      release = r;
    });
  let closed = false,
    finished = false;
  const events: RuntimeEvent[] = [];
  const query = (({ prompt }: any) => {
    const iterator = prompt[Symbol.asyncIterator]();
    const stream = (async function* () {
      const initial = (await iterator.next()).value;
      yield {
        type: "system",
        subtype: "init",
        session_id: "durable-claude",
      };
      const steer = (await iterator.next()).value;
      assert.equal(steer.priority, "now");
      assert.match(steer.message.content, /Named author/);
      yield {
        type: "user",
        uuid: steer.uuid,
        message: {
          role: "user",
          content: "echo",
        },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        user_message_uuids: [initial.uuid],
      };
      seenInitialResult();
      await continuation;
      yield {
        type: "assistant",
        message: {
          id: "continuation",
          content: [
            {
              type: "text",
              text: "Steering work completed",
            },
          ],
        },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        user_message_uuids: [steer.uuid],
      };
    })();
    return Object.assign(stream, {
      close() {
        closed = true;
      },
    });
  }) as any;
  const run = runClaude(
    {
      ...request,
      harness: "claude",
    },
    (e) => {
      events.push(e);
    },
    new AbortController().signal,
    channel,
    {
      query,
      sessionDirectory: dir,
    },
  ).then(() => {
    finished = true;
  });
  await channel.submit({
    id: "00000000-0000-4000-8000-000000000001",
    sequence: 2,
    authorId: "person",
    authorName: "Named author",
    content: "Act now",
  });
  await resultObserved;
  assert.equal(finished, false);
  assert.equal(closed, false);
  release();
  await run;
  assert.equal(closed, true);
  assert.ok(
    events.some(
      (e) =>
        e.type === "assistant_delta" && e.delta === "Steering work completed",
    ),
  );
});
test("Pi retains its native subscription through steering preflight and a late continuation", async () => {
  const { drivePiSession } = await import("../src/sdk.js"),
    { SteeringChannel } = await import("../src/steering.js"),
    channel = new SteeringChannel();
  let finishInitial!: () => void,
    releasePreflight!: () => void,
    finishContinuation!: () => void,
    notify: (e: any) => void = () => {},
    disposed = false,
    unsubscribed = false,
    finished = false;
  const initial = new Promise<void>((r) => (finishInitial = r)),
    preflight = new Promise<void>((r) => (releasePreflight = r)),
    continuation = new Promise<void>((r) => (finishContinuation = r)),
    events: RuntimeEvent[] = [];
  let calls = 0;
  const session = {
    sessionId: "pi-durable",
    subscribe(cb: any) {
      notify = cb;
      return () => {
        unsubscribed = true;
      };
    },
    async prompt(text: string, options: any) {
      if (++calls === 1) {
        options.preflightResult(true);
        await initial;
      } else {
        assert.equal(options.streamingBehavior, "steer");
        assert.match(text, /Named author/);
        await preflight;
        options.preflightResult(true);
        await continuation;
        notify({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Late work",
          },
        });
      }
    },
    async abort() {
      finishInitial();
      finishContinuation();
    },
    clearQueue() {},
    dispose() {
      disposed = true;
    },
  };
  const run = drivePiSession(
    session as any,
    {
      ...request,
      harness: "pi",
    },
    (e) => {
      events.push(e);
    },
    new AbortController().signal,
    channel,
  ).then(() => {
    finished = true;
  });
  const receipt = channel.submit({
    id: "pi-input",
    sequence: 2,
    authorId: "person",
    authorName: "Named author",
    content: "Steer",
  });
  await new Promise((r) => setImmediate(r));
  finishInitial();
  await new Promise((r) => setImmediate(r));
  assert.equal(unsubscribed, false);
  assert.equal(finished, false);
  releasePreflight();
  await receipt;
  assert.equal(disposed, false);
  finishContinuation();
  await run;
  assert.equal(unsubscribed, true);
  assert.ok(
    events.some((e) => e.type === "assistant_delta" && e.delta === "Late work"),
  );
});
test("Pi Stop crossing steering preflight clears queued native input and does not report acceptance", async () => {
  const { drivePiSession } = await import("../src/sdk.js"),
    { SteeringChannel } = await import("../src/steering.js"),
    channel = new SteeringChannel(),
    abort = new AbortController();
  let release!: () => void,
    finish!: () => void,
    calls = 0,
    cleared = 0,
    performed = false;
  const initial = new Promise<void>((r) => (finish = r)),
    gate = new Promise<void>((r) => (release = r));
  const session = {
    sessionId: "pi-stop",
    subscribe() {
      return () => {};
    },
    async prompt(_text: string, options: any) {
      if (++calls === 1) {
        options.preflightResult(true);
        await initial;
      } else {
        await gate;
        options.preflightResult(true);
        performed = true;
      }
    },
    async abort() {
      finish();
    },
    clearQueue() {
      cleared++;
    },
    dispose() {},
  };
  const run = drivePiSession(
    session as any,
    {
      ...request,
      harness: "pi",
    },
    () => {},
    abort.signal,
    channel,
  );
  void run.catch(() => {});
  const receipt = channel.submit({
    id: "pi-stop-input",
    sequence: 2,
    authorId: "person",
    authorName: "Person",
    content: "Do not replay",
  });
  void receipt.catch(() => {});
  await new Promise((r) => setImmediate(r));
  abort.abort();
  release();
  await assert.rejects(receipt);
  await assert.rejects(run);
  assert.equal(cleared, 1);
  assert.equal(performed, false);
});
