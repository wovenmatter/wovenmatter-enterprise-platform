import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
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
    async ensureProject() {},
    async stopProject() {},
    async execute(_request, emit) {
      await emit({
        type: "started",
      });
      await emit({
        type: "input_accepted",
      });
      await emit({
        type: "assistant_delta",
        delta: "Deterministic protocol fixture",
      });
      await emit({
        type: "completed",
      });
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
    {
      jobs: false,
      runtime,
      webRoot: join(stateDir, "absent"),
    },
  );
  t.after(async () => {
    await system.app.close();
    await rm(stateDir, {
      recursive: true,
      force: true,
    });
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
  return {
    ...system,
    headers,
    identity,
    owner,
  };
}
test("production image healthcheck uses the application's actual base-path route", async (t) => {
  const s = await fixture(t);
  const dockerfile = await readFile("Dockerfile", "utf8");
  const healthPath = /^HEALTHCHECK .*path:'([^']+)'/m.exec(dockerfile)?.[1];
  assert.ok(healthPath, "Production image must declare its HTTP health route");
  const result = await s.app.inject({
    url: healthPath,
    headers: { host: "portal.test" },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { status: "ok" });
  assert.equal(
    (
      await s.app.inject({
        url: healthPath,
        headers: { host: "unrelated.test" },
      })
    ).statusCode,
    404,
  );
});

test("assembled platform provisions a project, renders a safe report and immediately revokes it on deletion", async (t) => {
  const s = await fixture(t);
  const org = await s.app.inject({
    method: "POST",
    url: "/enterprise/api/organizations",
    headers: s.headers,
    payload: {
      name: "Test organization",
    },
  });
  assert.equal(org.statusCode, 201, org.body);
  const project = await s.app.inject({
    method: "POST",
    url: `/enterprise/api/organizations/${org.json().id}/projects`,
    headers: s.headers,
    payload: {
      name: "Workspace",
    },
  });
  assert.equal(project.statusCode, 202, project.body);
  assert.equal(await s.jobs.runOnce(), true);
  const asset = await s.app.inject({
    method: "POST",
    url: `/enterprise/api/organizations/${org.json().id}/assets`,
    headers: s.headers,
    payload: {
      projectId: project.json().id,
      name: "Report",
      visibility: "public",
      publish: true,
      document: {
        version: 1,
        blocks: [
          {
            type: "text",
            text: "Fresh report",
          },
        ],
      },
    },
  });
  assert.equal(asset.statusCode, 201, asset.body);
  const report = await s.app.inject({
    url: asset.json().url,
    headers: {
      host: "portal.test",
    },
  });
  assert.equal(report.statusCode, 200, report.body);
  assert.match(report.body, /Fresh report/);
  assert.match(
    String(report.headers["content-security-policy"]),
    /script-src 'none'/,
  );
  const deleted = await s.app.inject({
    method: "DELETE",
    url: `/enterprise/api/projects/${project.json().id}`,
    headers: s.headers,
  });
  assert.equal(deleted.statusCode, 202, deleted.body);
  assert.equal(
    (
      await s.app.inject({
        url: asset.json().url,
        headers: {
          host: "portal.test",
        },
      })
    ).statusCode,
    404,
  );
});
test("assembled admission uses real SQLite and remains private until a project member is added", async (t) => {
  const s = await fixture(t);
  s.inference.models = async () => [
    { id: "gpt-test", name: "GPT Test", provider: "openai" },
  ];
  s.inference.validateSelection = async () => {};
  s.inference.issueGateway = async () => ({
    baseUrl: "http://fixture.invalid",
    token: "fixture-scoped-token",
  });
  const org = (
    await s.app.inject({
      method: "POST",
      url: "/enterprise/api/organizations",
      headers: s.headers,
      payload: {
        name: "Conversation organization",
      },
    })
  ).json();
  const project = (
    await s.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${org.id}/projects`,
      headers: s.headers,
      payload: {
        name: "Shared project",
      },
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
    url: `/enterprise/api/projects/${project.id}/members`,
    headers: s.headers,
    payload: {
      userId: member,
      access: "write",
    },
  });
  const other = await s.identity(member);
  const creation = await s.app.inject({
    method: "POST",
    url: `/enterprise/api/projects/${project.id}/conversations`,
    headers: s.headers,
    payload: {
      title: "Private work",
      mode: "write",
      model: "gpt-test",
    },
  });
  assert.equal(creation.statusCode, 201, creation.body);
  const id = creation.json().id;
  const hidden = await s.app.inject({
    url: `/enterprise/api/conversations/${id}`,
    headers: other,
  });
  assert.equal(hidden.statusCode, 404, hidden.body);
  const message = await s.app.inject({
    method: "POST",
    url: `/enterprise/api/conversations/${id}/messages`,
    headers: s.headers,
    payload: {
      requestId: randomUUID(),
      content: "Protocol fixture request",
    },
  });
  assert.equal(message.statusCode, 202, message.body);
  let result: any;
  for (let i = 0; i < 100; i++) {
    result = await s.ctx.db.get(
      "SELECT status,error_code,error_message FROM conversation_runs WHERE conversation_id=?",
      [id],
    );
    if (result?.status === "completed") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(result?.status, "completed", JSON.stringify(result));
  const added = await s.app.inject({
    method: "POST",
    url: `/enterprise/api/conversations/${id}/members`,
    headers: s.headers,
    payload: {
      userId: member,
    },
  });
  assert.ok([200, 201].includes(added.statusCode), added.body);
  const visible = await s.app.inject({
    url: `/enterprise/api/conversations/${id}/messages`,
    headers: other,
  });
  assert.equal(visible.statusCode, 200, visible.body);
  assert.match(visible.body, /Deterministic protocol fixture/);
  await s.app.inject({
    method: "DELETE",
    url: `/enterprise/api/projects/${project.id}/members/${member}`,
    headers: s.headers,
  });
  const revoked = await s.app.inject({
    url: `/enterprise/api/conversations/${id}/messages`,
    headers: other,
  });
  assert.equal(revoked.statusCode, 404, revoked.body);
});
test("core app rejects forged origins and unknown hosts, preserving safe error envelopes", async (t) => {
  const s = await fixture(t);
  const forged = await s.app.inject({
    method: "POST",
    url: "/enterprise/api/organizations",
    headers: {
      ...s.headers,
      origin: "https://attacker.test",
    },
    payload: {
      name: "Forbidden",
    },
  });
  assert.equal(forged.statusCode, 403);
  assert.equal(forged.json().error.code, "invalid_origin");
  const badHost = await s.app.inject({
    url: "/enterprise/api/session",
    headers: {
      host: "attacker.test",
    },
  });
  assert.equal(badHost.statusCode, 404);
  const invalid = await s.app.inject({
    method: "POST",
    url: "/enterprise/api/organizations",
    headers: s.headers,
    payload: {},
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "invalid_request");
});
test("production startup leaves durable state untouched while supervisor is unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wme-startup-order-"));
  t.after(() =>
    rm(root, {
      recursive: true,
      force: true,
    }),
  );
  const tokenFile = join(root, "synthetic-supervisor-token");
  await writeFile(tokenFile, "a".repeat(64), {
    mode: 0o600,
  });
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
      const failure = error as {
        code?: number;
        stderr?: string;
      };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? "", /Runtime supervisor is unavailable/);
      assert.ok(!failure.stderr?.includes("a".repeat(64)));
      return true;
    },
  );
  await assert.rejects(stat(stateDir), {
    code: "ENOENT",
  });
});
