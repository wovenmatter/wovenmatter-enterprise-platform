// Explicit synthetic acceptance harness. Never imported by the production entrypoint.
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../dist/apps/api/src/app.js";
import { ProxyClient } from "../dist/apps/api/src/inference/proxy-client.js";
import { newSession } from "../dist/apps/api/src/auth/session.js";
if (process.env.WME_E2E_FIXTURE !== "1")
  throw new Error("Synthetic acceptance requires WME_E2E_FIXTURE=1");
const port = Number(process.env.WME_E2E_PORT ?? 4155);
const origin = `http://localhost:${port}`;
const stateDir = await mkdtemp(join(tmpdir(), "wme-browser-"));
const webRoot = join(stateDir, "web");
await cp(resolve("platform/apps/web/dist"), webRoot, { recursive: true });
const runtime = {
  async ensureProject() {},
  async stopProject() {},
  async restoreProject() {},
  async purgeProject() {},
  async steer() {},
  async execute(request, emit, signal) {
    await emit({ type: "started" });
    await emit({ type: "input_accepted" });
    for (const delta of [
      "Synthetic protocol fixture: ",
      "the request reached the durable runtime.",
    ]) {
      await new Promise((r) => setTimeout(r, 100));
      if (signal?.aborted) {
        await emit({ type: "cancelled" });
        return;
      }
      await emit({ type: "assistant_delta", delta });
    }
    await emit({ type: "completed" });
  },
  async cancel() {},
  async recover() {
    return [];
  },
};
const system = await buildApp(
  {
    stateDir,
    host: "127.0.0.1",
    port,
    publicOrigin: origin,
    secureCookies: false,
    hosts: [{ id: "local", name: "Initial host" }],
  },
  { runtime, jobs: false, webRoot },
);
// Deterministic management transport only; real Enterprise authorization and session lifecycle run unchanged.
const remoteAttempts = new Map(),
  connected = [];
const fixtureEndpoint = async () => ({
  baseUrl: "http://fixture.invalid",
  managementKey: "fixture-management",
  clientKey: "fixture-client",
});
system.inference.options.registry.resolve = fixtureEndpoint;
system.inference.proxy = new ProxyClient(
  fixtureEndpoint,
  async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/credentials"))
      return Response.json({ files: connected });
    if (path.endsWith("/observability/usage/api-keys"))
      return Response.json({});
    if (path.endsWith("/oauth/remote")) {
      const { id, provider } = JSON.parse(init.body);
      const attempt = {
        status: "pending",
        provider,
        flow: provider === "claude" ? "manual_code" : "device",
        url:
          provider === "claude"
            ? "https://claude.ai/oauth/authorize?state=fixture"
            : provider === "codex"
              ? "https://auth.openai.com/codex/device"
              : "https://accounts.x.ai/oauth2/device",
        user_code: provider === "claude" ? undefined : "TEST-CODE",
        interval: 5,
        expires_at: new Date(Date.now() + 120000).toISOString(),
      };
      remoteAttempts.set(id, attempt);
      return Response.json(attempt);
    }
    const [, id, operation] =
      path.match(/\/remote\/([^/]+)(?:\/(\w+))?$/) ?? [];
    const attempt = remoteAttempts.get(id);
    if (!attempt) return Response.json({ status: "interrupted" });
    if (init.method === "DELETE") {
      attempt.status = "cancelled";
      return Response.json(attempt);
    }
    if (operation === "code") {
      attempt.status = "ready";
      return Response.json(attempt);
    }
    if (operation === "commit") {
      attempt.status = "complete";
      connected.push({
        name: `fixture-${id}.json`,
        auth_index: id,
        provider: attempt.provider,
        status: "active",
        email: "provider@example.test",
      });
      return Response.json(attempt);
    }
    const controls = JSON.parse(
      await readFile(
        `${process.env.WME_E2E_OUTPUT ?? "/tmp/wme-e2e-evidence"}/provider-control.json`,
        "utf8",
      ).catch(() => "{}"),
    );
    if (controls[id] && attempt.status === "pending")
      attempt.status = controls[id];
    return Response.json(attempt);
  },
);
system.inference.models = async () => [
  { id: "gpt-test-fixture", name: "Synthetic test model", provider: "openai" },
];
system.inference.validateSelection = async () => {};
system.inference.issueGateway = async () => ({
  baseUrl: "http://fixture.invalid",
  token: "synthetic-scoped-fixture",
});
const owner = randomUUID();
await system.ctx.db.run(
  "INSERT INTO users(id,org_id,email,name,role,enabled,created_at) VALUES (?,NULL,?,?,?,1,?)",
  [
    owner,
    "owner@example.test",
    "Test Owner",
    "owner",
    new Date().toISOString(),
  ],
);
const session = newSession(owner);
await system.ctx.db.run(session.statement.sql, session.statement.params);
const headers = {
  host: `localhost:${port}`,
  origin,
  cookie: `wme_session=${session.token}`,
  "x-csrf-token": session.csrfToken,
};
const output = resolve(
  process.env.WME_E2E_OUTPUT ?? `${tmpdir()}/wme-e2e-evidence`,
);
await mkdir(output, { recursive: true });
await writeFile(
  join(output, "auth.json"),
  JSON.stringify({
    cookies: [
      {
        name: "wme_session",
        value: session.token,
        domain: "localhost",
        path: "/enterprise",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
        expires: -1,
      },
    ],
    origins: [],
  }),
  { mode: 0o600 },
);
await writeFile(
  join(output, "fixture.json"),
  JSON.stringify({
    origin,
    database: join(stateDir, "control/platform.sqlite"),
  }),
);
system.jobs.start();
await system.app.listen({ host: "127.0.0.1", port });
console.log(`Synthetic browser fixture ready at ${origin}`);
for (const event of ["SIGINT", "SIGTERM"])
  process.once(event, async () => {
    await system.app.close();
    await rm(stateDir, { recursive: true, force: true });
    process.exit(0);
  });
