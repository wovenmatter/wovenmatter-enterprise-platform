import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildApp } from "../apps/api/src/app.js";
import { newSession } from "../apps/api/src/auth/session.js";
import type { Runtime } from "../packages/runtime/src/types.js";

async function fixture(t: test.TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), "wme-application-"));
  const runtime: Runtime = {
    async execute(_request, emit) {
      await emit({ type: "started" });
      await emit({
        type: "assistant_delta",
        delta: "Deterministic protocol fixture",
      });
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
      publicOrigin: "http://portal.test",
      host: "127.0.0.1",
      port: 4100,
      secureCookies: false,
      contentOriginTemplate: "http://{assetId}.assets.test",
    },
    { jobs: false, runtime, webRoot: join(stateDir, "absent") },
  );
  t.after(async () => {
    await system.app.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const owner = randomUUID();
  await system.ctx.db.run(
    "INSERT INTO users (id,org_id,email,name,role,enabled,created_at) VALUES (?,NULL,?,?,?,1,?)",
    [
      owner,
      "owner@example.test",
      "Test owner",
      "owner",
      new Date().toISOString(),
    ],
  );
  async function identity(userId: string) {
    const s = newSession(userId);
    await system.ctx.db.run(s.statement.sql, s.statement.params);
    return {
      cookie: `wme_session=${s.token}`,
      "x-csrf-token": s.csrfToken,
      origin: "http://portal.test",
      host: "portal.test",
    };
  }
  const headers = await identity(owner);
  return { ...system, headers, identity, owner };
}

test("assembled platform provisions projects, serves versioned isolated assets, and revokes public access", async (t) => {
  const s = await fixture(t);
  const org = await s.app.inject({
    method: "POST",
    url: "/api/organizations",
    headers: s.headers,
    payload: { name: "Integration organization" },
  });
  assert.equal(org.statusCode, 201, org.body);
  const orgId = org.json().id;
  const created = await s.app.inject({
    method: "POST",
    url: `/api/organizations/${orgId}/projects`,
    headers: s.headers,
    payload: { name: "Matter workspace" },
  });
  assert.equal(created.statusCode, 202, created.body);
  const projectId = created.json().id;
  assert.equal(await s.jobs.runOnce(), true);
  const project = await s.app.inject({
    url: `/api/projects/${projectId}`,
    headers: s.headers,
  });
  assert.equal(project.json().status, "ready");
  const folder = await s.app.inject({
    method: "POST",
    url: "/api/files/folders",
    headers: s.headers,
    payload: { orgId, projectId, path: "Reports" },
  });
  assert.ok([200, 201].includes(folder.statusCode), folder.body);
  const asset = await s.app.inject({
    method: "POST",
    url: `/api/organizations/${orgId}/assets`,
    headers: s.headers,
    payload: { name: "Report", type: "static", projectId },
  });
  assert.equal(asset.statusCode, 201, asset.body);
  const assetId = asset.json().id;
  const publish = await s.app.inject({
    method: "POST",
    url: `/api/assets/${assetId}/publish`,
    headers: s.headers,
    payload: {
      expectedVersionId: null,
      files: [
        {
          path: "index.html",
          contentBase64: Buffer.from("<h1>Isolated report</h1>").toString(
            "base64",
          ),
        },
      ],
    },
  });
  assert.equal(publish.statusCode, 201, publish.body);
  const share = await s.app.inject({
    method: "POST",
    url: `/api/assets/${assetId}/shares`,
    headers: s.headers,
    payload: { visibility: "public" },
  });
  assert.equal(share.statusCode, 201, share.body);
  const landing = await s.app.inject({
    url: new URL(share.json().url).pathname,
    headers: { host: "portal.test" },
  });
  assert.ok([302, 303].includes(landing.statusCode), landing.body);
  const exchangeUrl = new URL(landing.headers.location!);
  assert.equal(exchangeUrl.hostname, `${assetId}.assets.test`);
  const exchange = await s.app.inject({
    url: exchangeUrl.pathname + exchangeUrl.search,
    headers: { host: exchangeUrl.host },
  });
  assert.ok([302, 303].includes(exchange.statusCode), exchange.body);
  const setCookies = exchange.headers["set-cookie"];
  const cookie = (Array.isArray(setCookies) ? setCookies : [setCookies])
    .filter(Boolean)
    .map((c) => String(c).split(";")[0])
    .join("; ");
  const view = await s.app.inject({
    url: "/",
    headers: { host: exchangeUrl.host, cookie },
  });
  assert.equal(view.statusCode, 200, view.body);
  assert.match(view.body, /Isolated report/);
  const apiOnContent = await s.app.inject({
    url: "/api/organizations",
    headers: { ...s.headers, host: exchangeUrl.host, cookie },
  });
  assert.notEqual(
    apiOnContent.statusCode,
    200,
    "Content host cannot access the platform API",
  );
  const revoke = await s.app.inject({
    method: "DELETE",
    url: `/api/assets/${assetId}/shares/${share.json().share.id}`,
    headers: s.headers,
  });
  assert.equal(revoke.statusCode, 200, revoke.body);
  const denied = await s.app.inject({
    url: "/",
    headers: { host: exchangeUrl.host, cookie },
  });
  assert.ok([403, 404].includes(denied.statusCode), denied.body);
});

test("assembled admission uses real SQLite and remains private until a project member is added", async (t) => {
  const s = await fixture(t);
  s.inference.validateSelection = async () => {};
  s.inference.issueGateway = async () => ({
    baseUrl: "http://fixture.invalid",
    token: "fixture-scoped-token",
  });
  const org = (
    await s.app.inject({
      method: "POST",
      url: "/api/organizations",
      headers: s.headers,
      payload: { name: "Conversation organization" },
    })
  ).json();
  const project = (
    await s.app.inject({
      method: "POST",
      url: `/api/organizations/${org.id}/projects`,
      headers: s.headers,
      payload: { name: "Shared project" },
    })
  ).json();
  await s.jobs.runOnce();
  const member = randomUUID();
  await s.ctx.db.run(
    "INSERT INTO users (id,org_id,email,name,role,enabled,created_at) VALUES (?,?,?,?,?,1,?)",
    [
      member,
      org.id,
      "employee@example.test",
      "Test employee",
      "member",
      new Date().toISOString(),
    ],
  );
  await s.app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/members`,
    headers: s.headers,
    payload: { userId: member, access: "write" },
  });
  const other = await s.identity(member);
  const creation = await s.app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/conversations`,
    headers: s.headers,
    payload: {
      title: "Private work",
      mode: "write",
      harness: "codex",
      model: "gpt-test",
    },
  });
  assert.equal(creation.statusCode, 201, creation.body);
  const id = creation.json().id;
  const hidden = await s.app.inject({
    url: `/api/conversations/${id}`,
    headers: other,
  });
  assert.equal(hidden.statusCode, 404, hidden.body);
  const message = await s.app.inject({
    method: "POST",
    url: `/api/conversations/${id}/messages`,
    headers: s.headers,
    payload: { requestId: randomUUID(), content: "Protocol fixture request" },
  });
  assert.equal(message.statusCode, 202, message.body);
  let result: any;
  for (let i = 0; i < 100; i++) {
    result = await s.ctx.db.get(
      "SELECT status FROM conversation_runs WHERE conversation_id=?",
      [id],
    );
    if (result?.status === "completed") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(result?.status, "completed");
  const added = await s.app.inject({
    method: "POST",
    url: `/api/conversations/${id}/members`,
    headers: s.headers,
    payload: { userId: member },
  });
  assert.ok([200, 201].includes(added.statusCode), added.body);
  const visible = await s.app.inject({
    url: `/api/conversations/${id}/messages`,
    headers: other,
  });
  assert.equal(visible.statusCode, 200, visible.body);
  assert.match(visible.body, /Deterministic protocol fixture/);
  await s.app.inject({
    method: "DELETE",
    url: `/api/projects/${project.id}/members/${member}`,
    headers: s.headers,
  });
  const revoked = await s.app.inject({
    url: `/api/conversations/${id}/messages`,
    headers: other,
  });
  assert.equal(revoked.statusCode, 404, revoked.body);
});

test("core app rejects forged origins and unknown hosts, preserving safe error envelopes", async (t) => {
  const s = await fixture(t);
  const forged = await s.app.inject({
    method: "POST",
    url: "/api/organizations",
    headers: { ...s.headers, origin: "https://attacker.test" },
    payload: { name: "Forbidden" },
  });
  assert.equal(forged.statusCode, 403);
  assert.equal(forged.json().error.code, "invalid_origin");
  const badHost = await s.app.inject({
    url: "/api/session",
    headers: { host: "attacker.test" },
  });
  assert.equal(badHost.statusCode, 404);
  const invalid = await s.app.inject({
    method: "POST",
    url: "/api/organizations",
    headers: s.headers,
    payload: {},
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "invalid_request");
});

test("production startup leaves durable state untouched while supervisor is unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wme-startup-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = join(root, "synthetic-supervisor-token");
  await writeFile(tokenFile, "a".repeat(64), { mode: 0o600 });
  const stateDir = join(root, "state-not-opened");
  const main = fileURLToPath(
    new URL("../apps/api/src/main.js", import.meta.url),
  );
  await assert.rejects(
    promisify(execFile)(process.execPath, [main], {
      timeout: 10_000,
      env: {
        NODE_ENV: "production",
        WME_PUBLIC_ORIGIN: "https://portal.test",
        WME_STATE_DIR: stateDir,
        WME_SUPERVISOR_SOCKET: join(root, "not-ready.sock"),
        WME_SUPERVISOR_TOKEN_FILE: tokenFile,
      },
    }),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? "", /Runtime supervisor is unavailable/);
      assert.ok(!failure.stderr?.includes("a".repeat(64)));
      return true;
    },
  );
  await assert.rejects(stat(stateDir), { code: "ENOENT" });
});
