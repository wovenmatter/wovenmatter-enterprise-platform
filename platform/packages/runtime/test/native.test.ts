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
    baseUrl: "http://api:4100/api/runtime/inference/project1",
    token: "synthetic-run-scoped-token-only",
  },
};
class FixtureRpc {
  onMessage: (message: RpcMessage) => Promise<void> = async () => {};
  calls: { method: string; params: any }[] = [];
  sent: RpcMessage[] = [];
  closed = new Promise<void>(() => {});
  stopped = false;
  failTurn = false;
  loadSession = true;
  serverRequest = false;
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === "initialize")
      return { agentCapabilities: { loadSession: this.loadSession } };
    if (["thread/start", "thread/resume"].includes(method))
      return { thread: { id: "thread1" } };
    if (method === "turn/start") {
      if (this.serverRequest)
        await this.onMessage({
          id: "permission1",
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread1" },
        });
      else {
        await this.onMessage({
          method: "item/agentMessage/delta",
          params: { threadId: "thread1", delta: "Observed answer" },
        });
        await this.onMessage({
          method: "turn/completed",
          params: {
            threadId: "thread1",
            turn: { status: this.failTurn ? "failed" : "completed" },
          },
        });
      }
      return { turn: { id: "turn1" } };
    }
    if (method === "session/new") return { sessionId: "session1" };
    if (method === "session/load") return {};
    if (method === "session/prompt") {
      await this.onMessage({
        method: "session/request_permission",
        id: 999,
        params: {
          options: [
            { kind: "allow_once", optionId: "once" },
            { kind: "allow_always", optionId: "always" },
          ],
        },
      });
      await this.onMessage({
        method: "session/update",
        params: {
          sessionId: "session1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ACP answer" },
          },
        },
      });
      return { stopReason: this.failTurn ? "max_tokens" : "end_turn" };
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

test("Codex resumes native identity and emits actual ordered deltas", async () => {
  const rpc = new FixtureRpc(),
    events: RuntimeEvent[] = [];
  let environment: Record<string, string> = {};
  await runCodex(
    { ...request, resumeId: "thread1" },
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
    { type: "native_session", sessionId: "thread1" },
    { type: "assistant_delta", delta: "Observed answer" },
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
    { ...request, harness: "grok", resumeId: "session1" },
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
  assert.equal(events.at(-1)?.type, "assistant_delta");
});
test("Grok never silently restarts when native resume is unsupported", async () => {
  const rpc = new FixtureRpc();
  rpc.loadSession = false;
  await assert.rejects(
    runGrok(
      { ...request, harness: "grok", resumeId: "session1" },
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
      validateContainerRequest({ ...request, model: 'model"\ninjected=true' }),
    /Invalid model/,
  );
  assert.throws(
    () =>
      validateContainerRequest({
        ...request,
        gateway: { ...request.gateway, baseUrl: "http://token@api/path" },
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
  validateContainerRequest({ ...request, egressProxyUrl: "http://api:4101" });
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
      () => validateContainerRequest({ ...request, egressProxyUrl }),
      /egress/,
    );
  }
});
test("native child proxy environments contain only scoped credentials and the explicit variable list", async () => {
  const enabled = { ...request, egressProxyUrl: "http://api:4101" };
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
  const enabled = { ...request, egressProxyUrl: "http://api:4101" };
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
    validateEvent({ type: "completed", token: "must-not-cross" }),
    { type: "completed" },
  );
  assert.throws(
    () => validateEvent({ type: "native_session", sessionId: "../../escape" }),
    /Invalid/,
  );
  assert.throws(
    () => validateEvent({ type: "assistant_delta", delta: {} }),
    /Invalid/,
  );
});
test("real stdio transport supports interleaved notifications and responses", async () => {
  const program = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){let m=JSON.parse(b.slice(0,n));b=b.slice(n+1);process.stdout.write(JSON.stringify({method:'notice',params:{value:m.params.value}})+'\\n');process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n')}});`;
  const rpc = new JsonRpcProcess(
    process.execPath,
    ["-e", program],
    { PATH: process.env.PATH ?? "" },
    process.cwd(),
  );
  const events: unknown[] = [];
  rpc.onMessage = async (m) => {
    events.push(m.params.value);
  };
  try {
    assert.deepEqual(await rpc.request("test", { value: 4 }), { ok: true });
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
