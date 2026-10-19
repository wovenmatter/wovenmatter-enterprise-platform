import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildApp } from "../apps/api/src/app.js";
import { createRuntimeEgress } from "../apps/api/src/runtime-egress.js";
import type { Runtime } from "../packages/runtime/src/types.js";
import { createEgressControlFixture } from "./fixtures/egress-control.js";

// Same external SQLite seed shape used by candidate-egress-acceptance.mjs.
// This fixture contains only generated identities/tokens and never invokes a provider.
function seed(filename: string) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000");
  const org = randomUUID(),
    user = randomUUID(),
    project = randomUUID(),
    conversation = randomUUID(),
    run = randomUUID(),
    message = randomUUID(),
    assistant = randomUUID(),
    now = new Date().toISOString(),
    token = `wme_run_${randomBytes(32).toString("base64url")}`;
  try {
    db.prepare(
      "INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)",
    ).run(org, "Synthetic egress acceptance", now);
    db.prepare(
      "INSERT INTO users(id,org_id,email,name,role,enabled,created_at) VALUES(?,?,?,'Synthetic admin','admin',1,?)",
    ).run(user, org, `${user}@acceptance.invalid`, now);
    db.prepare(
      "INSERT INTO projects(id,org_id,name,status,access,created_at) VALUES(?,?,'Synthetic network probe','ready','read',?)",
    ).run(project, org, now);
    db.prepare(
      "INSERT INTO conversations(id,org_id,project_id,creator_id,title,mode,harness,model,created_at,updated_at) VALUES(?,?,?,?,'Synthetic GET-only probe','read','pi','fixture',?,?)",
    ).run(conversation, org, project, user, now, now);
    db.prepare("INSERT INTO conversation_members VALUES(?,?,?,?)").run(
      conversation,
      user,
      user,
      now,
    );
    for (const [id, role] of [
      [message, "user"],
      [assistant, "assistant"],
    ])
      db.prepare(
        "INSERT INTO conversation_messages(id,conversation_id,role,author_id,content,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        id!,
        conversation,
        role!,
        user,
        "Synthetic private-target authentication probe",
        now,
      );
    db.prepare(
      "INSERT INTO conversation_runs(id,conversation_id,org_id,project_id,user_id,request_id,user_message_id,assistant_message_id,status,mode,harness,model,created_at,started_at) VALUES(?,?,?,?,?,?,?,?,'running','read','pi','fixture',?,?)",
    ).run(
      run,
      conversation,
      org,
      project,
      user,
      randomUUID(),
      message,
      assistant,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO inference_gateway_tokens(token_hash,org_id,project_id,user_id,run_id,conversation_id,model,harness,expires_at,revoked) VALUES(?,?,?,?,?,?,'fixture','pi',?,0)",
    ).run(
      createHash("sha256").update(token).digest("hex"),
      org,
      project,
      user,
      run,
      conversation,
      new Date(Date.now() + 300_000).toISOString(),
    );
  } finally {
    db.close();
  }
  return {
    org,
    user,
    project,
    conversation,
    run,
    token,
  };
}
function connectPrivate(
  port: number,
  projectId?: string,
  token?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const q = request({
      host: "127.0.0.1",
      port,
      method: "CONNECT",
      path: "127.0.0.1:443",
      headers:
        projectId && token
          ? {
              "proxy-authorization": `Basic ${Buffer.from(`${projectId}:${token}`).toString("base64")}`,
            }
          : {},
      agent: false,
    });
    q.on("connect", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode!);
    });
    q.on("response", (response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    q.on("error", reject);
    q.setTimeout(2000, () =>
      q.destroy(new Error("Private-target fixture timeout")),
    );
    q.end();
  });
}
async function fixture(t: test.TestContext, maintenance = false) {
  const stateDir = await mkdtemp(join(tmpdir(), "wme-real-egress-auth-"));
  const cancelled: string[] = [];
  const runtime: Runtime = {
    async execute() {
      throw new Error("No runtime execution expected in authorization fixture");
    },
    async cancel(id) {
      cancelled.push(id);
    },
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
      startConversations: false,
      runtime,
      webRoot: join(stateDir, "absent"),
      registry: {
        resolve: async () => ({
          baseUrl: "http://proxy.invalid",
          managementKey: "synthetic-management",
          clientKey: "synthetic-client",
        }),
      },
    },
  );
  t.after(async () => {
    await system.app.close();
    await rm(stateDir, {
      recursive: true,
      force: true,
    });
  });
  if (maintenance) await system.conversations.start();
  const data = seed(join(stateDir, "control", "platform.sqlite"));
  let authorizationCalls = 0;
  const network = await createRuntimeEgress({
    runtime,
    proxyOrigin: "http://api:4101",
    host: "127.0.0.1",
    port: 0,
    networkBoundary: async () => ({
      addresses: ["8.8.8.8"],
      hostnames: ["host.example"],
    }),
    authorize: async (projectId, token) => {
      authorizationCalls++;
      return system.inference.authorizeGateway(projectId, token);
    },
  });
  t.after(() => network.close());
  const { port } = await network.start();
  return {
    ...system,
    ...data,
    port,
    cancelled,
    authorizationCalls: () => authorizationCalls,
  };
}
test("real SQLite and inference authorization accept seeded and issued run tokens through CONNECT before denying a private destination", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await f.conversations.canUseRun({
      orgId: f.org,
      projectId: f.project,
      userId: f.user,
      runId: f.run,
    }),
    true,
  );
  const scope = await f.inference.authorizeGateway(f.project, f.token);
  assert.equal(scope.runId, f.run);
  assert.equal(await connectPrivate(f.port, f.project, f.token), 403);
  assert.equal(f.authorizationCalls(), 1);
  const issued = await f.inference.issueGateway(scope);
  assert.equal(await connectPrivate(f.port, f.project, issued.token), 403);
  assert.equal(await connectPrivate(f.port), 407);
  assert.equal(
    f.authorizationCalls(),
    2,
    "Missing proxy credentials must fail before the callback",
  );
  assert.equal(await connectPrivate(f.port, randomUUID(), issued.token), 407);
  assert.equal(
    await connectPrivate(
      f.port,
      f.project,
      `wme_run_${randomBytes(32).toString("base64url")}`,
    ),
    407,
  );
  await f.inference.revokeGateway(f.run);
  assert.equal(await connectPrivate(f.port, f.project, f.token), 407);
  assert.equal(await connectPrivate(f.port, f.project, issued.token), 407);
});
test("real run permission checks reject a disabled user, removed thread access, and terminal run", async (t) => {
  const f = await fixture(t);
  await f.ctx.db.run("UPDATE users SET enabled=0 WHERE id=?", [f.user]);
  assert.equal(await connectPrivate(f.port, f.project, f.token), 407);
  await f.ctx.db.run("UPDATE users SET enabled=1 WHERE id=?", [f.user]);
  assert.equal(await connectPrivate(f.port, f.project, f.token), 403);
  await f.ctx.db.run("UPDATE conversations SET deleted_at=? WHERE id=?", [
    new Date().toISOString(),
    f.conversation,
  ]);
  assert.equal(await connectPrivate(f.port, f.project, f.token), 407);
  await f.ctx.db.run("UPDATE conversations SET deleted_at=NULL WHERE id=?", [
    f.conversation,
  ]);
  await f.ctx.db.run(
    "UPDATE conversation_runs SET status='completed' WHERE id=?",
    [f.run],
  );
  assert.equal(await connectPrivate(f.port, f.project, f.token), 407);
});
test("live maintenance revokes manually seeded running rows that have no owned execution", async (t) => {
  const f = await fixture(t, true);
  assert.equal(await connectPrivate(f.port, f.project, f.token), 403);
  let row:
    | {
        status: string;
        error_code: string;
      }
    | undefined;
  for (let i = 0; i < 150; i++) {
    row = await f.ctx.db.get(
      "SELECT status,error_code FROM conversation_runs WHERE id=?",
      [f.run],
    );
    if (row?.status === "interrupted") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(row?.status, "interrupted");
  assert.equal(row?.error_code, "execution_state_lost");
  assert.ok(f.cancelled.includes(f.run));
  const tokenState = await f.ctx.db.get<{
    revoked: number;
  }>("SELECT revoked FROM inference_gateway_tokens WHERE run_id=?", [f.run]);
  assert.equal(tokenState?.revoked, 1);
  assert.equal(await connectPrivate(f.port, f.project, f.token), 407);
});
test("an admitted holding run keeps its real gateway grant across maintenance and explicit revocation removes access", async (t) => {
  const f = await createEgressControlFixture({
    networkBoundary: async () => ({
      addresses: ["8.8.8.8"],
      hostnames: ["host.example"],
    }),
  });
  t.after(() => f.close());
  const { port, project, run, token } = f.ready;
  assert.equal(await connectPrivate(port, project, token), 403);
  await new Promise((resolve) => setTimeout(resolve, 1250));
  const state = await f.system.ctx.db.get<{
    status: string;
    revoked: number;
  }>(
    "SELECT r.status,t.revoked FROM conversation_runs r JOIN inference_gateway_tokens t ON t.run_id=r.id WHERE r.id=?",
    [run],
  );
  assert.deepEqual(
    {
      ...state,
    },
    {
      status: "running",
      revoked: 0,
    },
  );
  assert.equal(await connectPrivate(port, project, token), 403);
  assert.equal(await connectPrivate(port, randomUUID(), token), 407);
  await f.revoke();
  assert.equal(await connectPrivate(port, project, token), 407);
  assert.equal(
    (
      await f.system.ctx.db.get<{
        revoked: number;
      }>("SELECT revoked FROM inference_gateway_tokens WHERE run_id=?", [run])
    )?.revoked,
    1,
  );
});
test("an admitted employee run loses real proxy access when project membership is removed", async (t) => {
  const f = await createEgressControlFixture({
    networkBoundary: async () => ({
      addresses: ["8.8.8.8"],
      hostnames: ["host.example"],
    }),
  });
  t.after(() => f.close());
  assert.equal(
    await connectPrivate(f.ready.port, f.ready.project, f.ready.token),
    403,
  );
  await f.system.ctx.db.run(
    "DELETE FROM project_members WHERE project_id=? AND user_id=?",
    [f.ready.project, f.ready.user],
  );
  assert.equal(
    await connectPrivate(f.ready.port, f.ready.project, f.ready.token),
    407,
  );
});
