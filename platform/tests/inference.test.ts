import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createDatabase, migrateFoundation } from "../apps/api/src/db/index.js";
import { createContext, AppError, type User } from "../apps/api/src/context.js";
import {
  InferenceService,
  registerInferenceRoutes,
  type RunScope,
} from "../apps/api/src/inference/index.js";
import {
  ProxyClient,
  InferenceError,
} from "../apps/api/src/inference/proxy-client.js";
import {
  isPublicAddress,
  discoverProviderModels,
} from "../apps/api/src/inference/discovery.js";

async function fixture(modelEntries?: Record<string, unknown>[]) {
  const db = await createDatabase(":memory:");
  await migrateFoundation(db);
  const orgId = randomUUID(),
    otherOrg = randomUUID(),
    projectId = randomUUID(),
    userId = randomUUID(),
    otherId = randomUUID(),
    memberId = randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: "INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)",
      params: [orgId, "One", now],
    },
    {
      sql: "INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)",
      params: [otherOrg, "Two", now],
    },
    ...[
      [userId, orgId, "admin"],
      [otherId, otherOrg, "admin"],
      [memberId, orgId, "member"],
    ].map(([id, org, role]) => ({
      sql: "INSERT INTO users(id,org_id,email,name,role,enabled,created_at) VALUES (?,?,?,?,?,1,?)",
      params: [id!, org!, `${id}@example.com`, "Name", role!, now],
    })),
    {
      sql: "INSERT INTO projects(id,org_id,name,description,status,access,created_at) VALUES (?,?,?,?,?,?,?)",
      params: [projectId, orgId, "Project", "", "ready", "write", now],
    },
  ]);
  const ctx = createContext(db, {
    stateDir: "/tmp",
    publicOrigin: "https://app.example.test",
    host: "127.0.0.1",
    port: 4100,
    secureCookies: true,
  });
  const admin: User = {
    id: userId,
    orgId,
    email: `${userId}@example.com`,
    name: "Admin",
    role: "admin",
    enabled: true,
    theme: "green",
  };
  const other: User = { ...admin, id: otherId, orgId: otherOrg };
  const member: User = { ...admin, id: memberId, role: "member" };
  ctx.requireUser = async (req) =>
    req.headers["x-test-user"] === "other"
      ? other
      : req.headers["x-test-user"] === "member"
        ? member
        : admin;
  const requests: { url: string; init: RequestInit }[] = [];
  const groups: Record<string, unknown> = {};
  let active = true;
  let failure = false;
  let failurePath = "";
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url: url.toString(), init });
    if (failure && (!failurePath || url.pathname.includes(failurePath)))
      return Response.json(
        { error: "secret-token-do-not-return", api_key: "upstream-secret" },
        { status: 500 },
      );
    if (url.pathname.endsWith("/credentials"))
      return Response.json({
        files: [
          {
            name: "claude-private-email.json",
            auth_index: "private-index",
            provider: "claude",
            email: "admin@example.com",
            status: "active",
            disabled: false,
            unavailable: false,
            runtime_only: false,
            success: 3,
            failed: 1,
            priority: 5,
            path: "/secrets/provider",
            id_token: { secret: "unsafe" },
            account: "upstream-secret",
            status_message: "Bearer upstream-secret",
            api_key: "upstream-secret",
          },
        ],
      });
    if (url.pathname.endsWith("/observability/usage/api-keys"))
      return Response.json({
        codex: {
          "https://provider|upstream-secret": {
            success: 4,
            failed: 2,
            api_key: "unsafe",
          },
        },
      });
    if (url.pathname.endsWith("/config"))
      return Response.json({ "api-keys": groups });
    if (url.pathname.includes("/config/api-keys/")) {
      groups[url.pathname.split("/").pop()!] = JSON.parse(String(init.body));
      return Response.json({ status: "ok" });
    }
    if (url.pathname.endsWith("/oauth/remote"))
      return Response.json({
        status: "pending",
        flow: "manual_code",
        url: "https://claude.ai/oauth/authorize?state=state-secret",
        expires_at: new Date(Date.now() + 290_000).toISOString(),
        interval: 0,
      });
    if (url.pathname.includes("/oauth/remote/")) {
      if (url.pathname.endsWith("/code"))
        return Response.json({ status: "pending" });
      if (init.method === "DELETE")
        return Response.json({ status: "cancelled" });
      return Response.json({ status: "complete" });
    }
    if (url.pathname.endsWith("/oauth/status"))
      return Response.json({ status: "ok", access_token: "never-return" });
    if (url.pathname.endsWith("/credentials/refresh"))
      return Response.json({
        auth: { access_token: "never-return", refresh_token: "never-return" },
      });
    if (url.pathname === "/v1/models")
      return Response.json({
        data: modelEntries ?? [
          {
            id: "gpt-example",
            owned_by: "openai",
            context_window: 128000,
            max_output_tokens: 16384,
            capabilities: { images: true, reasoning: true },
          },
          {
            id: "claude-example",
            owned_by: "anthropic",
            context_window: 200000,
          },
        ],
      });
    if (url.pathname === "/v1/responses")
      return Response.json({ id: "response", output: [] });
    return Response.json({ status: "ok", secret: "never-return" });
  };
  const registry = {
    resolve: async (id: string) =>
      id === orgId
        ? {
            baseUrl: "http://proxy-one:8317",
            managementKey: "management-one",
            clientKey: "client-one",
          }
        : id === otherOrg
          ? {
              baseUrl: "http://proxy-two:8317",
              managementKey: "management-two",
              clientKey: "client-two",
            }
          : undefined,
  };
  const service = new InferenceService(ctx, {
    registry,
    canUseRun: async (scope) =>
      active &&
      scope.orgId === orgId &&
      scope.projectId === projectId &&
      scope.userId === userId,
    fetcher: fakeFetch,
    discoverModels: async () => ["gpt-example", "claude-example"],
    runtimeApiOrigin: "http://api.internal:4100",
  });
  await service.initialize();
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const e = error as AppError;
    reply
      .code(e.statusCode ?? 500)
      .send({ error: { code: e.code, message: e.message } });
  });
  await registerInferenceRoutes(app, ctx, service);
  await app.ready();
  return {
    db,
    ctx,
    admin,
    other,
    orgId,
    otherOrg,
    projectId,
    userId,
    app,
    service,
    requests,
    groups,
    setActive: (value: boolean) => {
      active = value;
    },
    setFailure: (value: boolean, path = "") => {
      failure = value;
      failurePath = path;
    },
    scope: {
      orgId,
      projectId,
      userId,
      runId: randomUUID(),
      model: "gpt-example",
      harness: "pi",
    } satisfies RunScope,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

test("admin account/usage DTOs omit credentials, paths, opaque claims and composite API keys", async () => {
  const f = await fixture();
  try {
    const account = await f.app.inject(
      `/enterprise/api/organizations/${f.orgId}/inference/accounts`,
    );
    assert.equal(account.statusCode, 200);
    const data = account.json();
    assert.equal(data.items[0].label, "admin@example.com");
    assert.equal(data.items[0].priority, 5);
    const usage = await f.app.inject(
      `/enterprise/api/organizations/${f.orgId}/inference/usage`,
    );
    assert.deepEqual(usage.json().items, [
      { provider: "openai", successes: 4, failures: 2 },
      { provider: "anthropic", successes: 3, failures: 1 },
    ]);
    for (const forbidden of [
      "upstream-secret",
      "private-index",
      "private-email",
      "/secrets",
      "id_token",
      "status_message",
      "api_key",
    ]) {
      assert.ok(!account.body.includes(forbidden));
      assert.ok(!usage.body.includes(forbidden));
    }
    const refresh = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgId}/inference/accounts/${data.items[0].id}/refresh`,
    });
    assert.equal(refresh.body, '{"ok":true}');
  } finally {
    await f.close();
  }
});
test("other organizations and ordinary employees cannot administer accounts or start OAuth", async () => {
  const f = await fixture();
  try {
    for (const role of ["other", "member"])
      for (const path of ["accounts", "usage"]) {
        const response = await f.app.inject({
          url: `/enterprise/api/organizations/${f.orgId}/inference/${path}`,
          headers: { "x-test-user": role },
        });
        assert.ok([403, 404].includes(response.statusCode));
      }
    const denied = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgId}/inference/oauth`,
      headers: { "x-test-user": "member" },
      payload: { provider: "openai" },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});
test("API keys use v8 family groups and never persist in the application database or return to browser", async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgId}/inference/accounts`,
      payload: {
        provider: "openai",
        label: "Main API",
        apiKey: "secret-key-12345",
      },
    });
    assert.equal(response.statusCode, 201);
    assert.ok(!response.body.includes("secret-key"));
    const row = await f.db.get("SELECT * FROM inference_api_accounts");
    assert.ok(!JSON.stringify(row).includes("secret-key"));
    const upstream = f.groups.codex as { keys: { "api-key": string }[] }[];
    assert.equal(upstream[0]?.keys[0]?.["api-key"], "secret-key-12345");
    const patch = await f.app.inject({
      method: "PATCH",
      url: `/enterprise/api/organizations/${f.orgId}/inference/accounts/${response.json().id}`,
      payload: { enabled: false, priority: 8 },
    });
    assert.equal(patch.statusCode, 200);
    assert.deepEqual(
      (f.groups.codex as Record<string, unknown>[])[0]?.["excluded-models"],
      ["*"],
    );
    const remove = await f.app.inject({
      method: "DELETE",
      url: `/enterprise/api/organizations/${f.orgId}/inference/accounts/${response.json().id}`,
    });
    assert.equal(remove.statusCode, 200);
    assert.deepEqual(f.groups.codex, []);
  } finally {
    await f.close();
  }
});
test("failed upstream save remains needs_attention and exposes no upstream error details", async () => {
  const f = await fixture();
  try {
    f.setFailure(true, "/config/api-keys/");
    const response = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgId}/inference/accounts`,
      payload: {
        provider: "openai",
        label: "Main",
        apiKey: "secret-key-12345",
      },
    });
    assert.equal(response.statusCode, 502);
    assert.ok(!response.body.includes("upstream-secret"));
    assert.ok(!response.body.includes("secret-token"));
    assert.equal(
      (
        await f.db.get<{ state: string }>(
          "SELECT state FROM inference_api_accounts",
        )
      )?.state,
      "needs_attention",
    );
  } finally {
    await f.close();
  }
});
test("Claude sign-in requires acknowledgement and remote status remains bound to the initiating organization admin", async () => {
  const f = await fixture();
  try {
    const base = `/enterprise/api/organizations/${f.orgId}/inference/oauth`;
    const missing = await f.app.inject({
      method: "POST",
      url: base,
      payload: { provider: "anthropic" },
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(f.requests.length, 0);
    const start = await f.app.inject({
      method: "POST",
      url: base,
      payload: { provider: "anthropic", acceptedRisk: true },
    });
    assert.equal(start.statusCode, 200);
    const id = start.json().id;
    assert.ok(id);
    assert.ok(!start.body.includes("management-one"));
    const cross = await f.app.inject({
      url: `/enterprise/api/organizations/${f.otherOrg}/inference/oauth/${id}`,
      headers: { "x-test-user": "other" },
    });
    assert.equal(cross.statusCode, 404);
    assert.equal(start.json().flow, "manual_code");
    assert.ok(!start.body.includes('state-secret","state'));
    const pending = await f.app.inject(base);
    assert.ok(
      pending.json().items.some((item: { id: string }) => item.id === id),
    );
  } finally {
    await f.close();
  }
});
test("run tokens are hashed, bound to project and selected model, revoke immediately and never expose upstream keys", async () => {
  const f = await fixture();
  try {
    const gateway = await f.service.issueGateway(f.scope);
    assert.equal(
      gateway.baseUrl,
      `http://api.internal:4100/enterprise/api/runtime/inference/${f.projectId}`,
    );
    const row = await f.db.get("SELECT * FROM inference_gateway_tokens");
    assert.ok(!JSON.stringify(row).includes(gateway.token));
    await assert.rejects(
      () => f.service.authorizeGateway(randomUUID(), gateway.token),
      { code: "run_access_denied" },
    );
    const response = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/runtime/inference/${f.projectId}/v1/responses`,
      headers: { authorization: `Bearer ${gateway.token}` },
      payload: { model: "gpt-example", input: "Hello" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(
      (f.requests.at(-1)?.init.headers as Record<string, string>).authorization,
      "Bearer client-one",
    );
    const wrongModel = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/runtime/inference/${f.projectId}/v1/responses`,
      headers: { authorization: `Bearer ${gateway.token}` },
      payload: { model: "claude-example", input: "Hello" },
    });
    assert.equal(wrongModel.statusCode, 403);
    await f.service.revokeGateway(f.scope.runId);
    await assert.rejects(
      () => f.service.authorizeGateway(f.projectId, gateway.token),
      { code: "run_access_denied" },
    );
  } finally {
    await f.close();
  }
});
test("membership/run revocation denies inference before another provider request", async () => {
  const f = await fixture();
  try {
    const gateway = await f.service.issueGateway(f.scope);
    f.setActive(false);
    const before = f.requests.length;
    const response = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/runtime/inference/${f.projectId}/v1/messages`,
      headers: { "x-api-key": gateway.token },
      payload: { model: "gpt-example", messages: [] },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(f.requests.length, before);
  } finally {
    await f.close();
  }
});
test("gateway exposes no management endpoint and rejects anonymous requests", async () => {
  const f = await fixture();
  try {
    const gateway = await f.service.issueGateway(f.scope);
    const management = await f.app.inject({
      url: `/enterprise/api/runtime/inference/${f.projectId}/v8/management/config`,
      headers: { authorization: `Bearer ${gateway.token}` },
    });
    assert.equal(management.statusCode, 404);
    const models = await f.app.inject(
      `/enterprise/api/runtime/inference/${f.projectId}/v1/models`,
    );
    assert.equal(models.statusCode, 401);
  } finally {
    await f.close();
  }
});
test("model selection verifies the actual catalog and rejects non-Pi harnesses", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.service.defaultHarness(f.orgId, "gpt-example"), "pi");
    assert.equal(
      await f.service.defaultHarness(f.orgId, "claude-example"),
      "pi",
    );
    assert.deepEqual(await f.service.resolvePiModel(f.orgId, "gpt-example"), {
      model: "gpt-example",
      provider: "openai",
      api: "openai-responses",
      contextWindow: 128000,
      maxOutputTokens: 16384,
      supportsNativeCompaction: true,
      supportsImages: true,
      supportsReasoning: true,
      routeIdentity: "openai:openai-responses:gpt-example",
      accountAffinity: "proxy-session-affinity",
    });
    assert.equal(
      (await f.service.resolvePiModel(f.orgId, "claude-example")).api,
      "anthropic-messages",
    );
    await f.service.validateSelection(f.orgId, "gpt-example", "pi");
    await f.service.validateSelection(f.orgId, "claude-example", "pi");
    await assert.rejects(
      () => f.service.validateSelection(f.orgId, "claude-example", "codex"),
      { code: "invalid_harness" },
    );
    await assert.rejects(
      () => f.service.validateSelection(f.orgId, "imaginary-model", "pi"),
      { code: "model_unavailable" },
    );
  } finally {
    await f.close();
  }
});
test("proxy failures redact response bodies and use distinct org credentials without redirects", async () => {
  let sent: RequestInit | undefined;
  const proxy = new ProxyClient(
    async () => ({
      baseUrl: "http://private:8317",
      managementKey: "management-secret",
      clientKey: "client-secret",
    }),
    async (_input, init) => {
      sent = init;
      return Response.json({ error: "api-key-secret" }, { status: 403 });
    },
  );
  await assert.rejects(
    () => proxy.request("org", "/v8/management/credentials"),
    (error: unknown) =>
      error instanceof InferenceError &&
      !error.message.includes("api-key-secret"),
  );
  assert.equal(sent?.redirect, "error");
  assert.equal(
    (sent?.headers as Record<string, string>).authorization,
    "Bearer management-secret",
  );
});
test("provider discovery rejects private network targets and disallows credentials in URLs", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fd12::1",
    "2001:db8::1",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  await assert.rejects(
    () => discoverProviderModels("https://127.0.0.1/v1", "secret-key"),
    { code: "provider_origin_not_approved" },
  );
  await assert.rejects(
    () =>
      discoverProviderModels(
        "https://user:password@example.com/v1",
        "secret-key",
      ),
    { code: "invalid_base_url" },
  );
});

test("simultaneous API-key additions serialize per organization and retain both groups", async () => {
  const f = await fixture();
  try {
    const add = (label: string) =>
      f.service.addApiKey(f.admin, f.orgId, {
        provider: "openai",
        label,
        apiKey: `secret-key-${label}`,
      });
    const [first, second] = await Promise.all([add("First"), add("Second")]);
    assert.notEqual(first.id, second.id);
    assert.equal((f.groups.codex as unknown[]).length, 2);
    assert.equal(
      (await f.db.all("SELECT id FROM inference_api_accounts")).length,
      2,
    );
  } finally {
    await f.close();
  }
});
test("token expiry and revoked user status stop inference even when a token hash exists", async () => {
  const f = await fixture();
  try {
    const token = await f.service.issueGateway(f.scope);
    await f.db.run("UPDATE inference_gateway_tokens SET expires_at=?", [
      "2000-01-01T00:00:00.000Z",
    ]);
    await assert.rejects(
      () => f.service.authorizeGateway(f.projectId, token.token),
      { code: "run_access_denied" },
    );
    await f.db.run("UPDATE users SET enabled=0 WHERE id=?", [f.userId]);
    await assert.rejects(
      () =>
        f.service.addApiKey(f.admin, f.orgId, {
          provider: "openai",
          label: "Revoked",
          apiKey: "secret-key-value",
        }),
      { code: "unauthorized" },
    );
  } finally {
    await f.close();
  }
});
test(
  "active provider stream aborts after access is revoked",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    let aborted = false;
    let started!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    try {
      const streamingFetch: typeof fetch = async (_input, init) => {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.created"}\n\n',
                ),
              );
              started();
              init?.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  controller.close();
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const service = new InferenceService(f.ctx, {
        registry: f.service.options.registry,
        canUseRun: async () => !aborted && active,
        fetcher: streamingFetch,
      });
      let active = true;
      const gateway = await service.issueGateway(f.scope);
      const app = Fastify();
      await registerInferenceRoutes(app, f.ctx, service);
      const pending = app.inject({
        method: "POST",
        url: `/enterprise/api/runtime/inference/${f.projectId}/v1/responses`,
        headers: { authorization: `Bearer ${gateway.token}` },
        payload: { model: "gpt-example", input: "Hello" },
      });
      await streamStarted;
      active = false;
      const result = await pending;
      assert.equal(result.statusCode, 200);
      assert.equal(aborted, true);
      await app.close();
    } finally {
      await f.close();
    }
  },
);
test("API-key preflight rejects a model the provider did not advertise", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () =>
        f.service.addApiKey(f.admin, f.orgId, {
          provider: "openai",
          label: "Invalid",
          apiKey: "secret-key-value",
          models: ["not-advertised"],
        }),
      { code: "model_unavailable" },
    );
    assert.equal(f.requests.length, 0);
    assert.equal(
      (await f.db.all("SELECT id FROM inference_api_accounts")).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("API shutdown aborts an active inference stream before waiting for HTTP drain", async () => {
  const f = await fixture();
  let aborted = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closing: Promise<void> | undefined;
  f.service.proxy.forward = async (_org, _path, _body, signal) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
          signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              controller.close();
            },
            { once: true },
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  try {
    const gateway = await f.service.issueGateway(f.scope);
    const origin = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(
      `${origin}/enterprise/api/runtime/inference/${f.projectId}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${gateway.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-example",
          input: "Synthetic stream",
        }),
      },
    );
    assert.equal(response.status, 200);
    reader = response.body!.getReader();
    await reader.read();
    closing = f.app.close();
    const closed = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    assert.equal(
      closed,
      true,
      "Shutdown waited for the still-active provider request",
    );
    assert.equal(aborted, true);
  } finally {
    await reader?.cancel();
    await closing;
    await f.close();
  }
});

test("Pi capabilities use exact installed model metadata and preserve explicit false", async () => {
  const f = await fixture([
    { id: "gpt-4o", owned_by: "openai" },
    {
      id: "gpt-5",
      owned_by: "openai",
      context_window: 123456,
      capabilities: { images: false, reasoning: false },
    },
    { id: "gpt-5-not-a-catalog-model", owned_by: "openai" },
  ]);
  try {
    const { getBuiltinModels } = await import(
      "@earendil-works/pi-ai/providers/all"
    );
    const expected = getBuiltinModels("openai").find(
      (model) => model.id === "gpt-4o",
    )!;
    const known = await f.service.resolvePiModel(f.orgId, "gpt-4o");
    assert.equal(known.contextWindow, expected.contextWindow);
    assert.equal(known.maxOutputTokens, expected.maxTokens);
    assert.equal(known.supportsReasoning, false);
    const explicit = await f.service.resolvePiModel(f.orgId, "gpt-5");
    assert.equal(explicit.contextWindow, 123456);
    assert.equal(explicit.supportsImages, false);
    assert.equal(explicit.supportsReasoning, false);
    const unknown = await f.service.resolvePiModel(
      f.orgId,
      "gpt-5-not-a-catalog-model",
    );
    assert.equal(unknown.contextWindow, undefined);
    assert.equal(unknown.supportsReasoning, undefined);
  } finally {
    await f.close();
  }
});
