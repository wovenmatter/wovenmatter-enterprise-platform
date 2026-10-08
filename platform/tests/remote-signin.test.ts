import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import Fastify from "fastify";
import { platformFixture } from "./fixtures/platform.js";
import {
  InferenceService,
  registerInferenceRoutes,
} from "../apps/api/src/inference/index.js";
import type { Runtime } from "../packages/runtime/src/types.js";
import { newSession } from "../apps/api/src/auth/session.js";

async function fixture(
  t: Parameters<typeof platformFixture>[0],
  runtime?: Runtime,
) {
  let closeOAuth: () => Promise<void> = async () => {};
  t.after(() => closeOAuth());
  const f = await platformFixture(t, { runtime });
  const remote = new Map<string, any>(),
    calls: { method: string; path: string }[] = [];
  let lostStart = false,
    broken = false,
    commits = 0,
    beforeCommit: (() => Promise<void>) | undefined,
    malicious = false;
  const options = {
    registry: {
      resolve: async (id: string) => ({
        baseUrl: `http://${id}.fixture.test`,
        managementKey: "synthetic-management",
        clientKey: "synthetic-client",
      }),
    },
    canUseRun: async () => false,
    fetcher: (async (input, init = {}) => {
      const url = new URL(String(input)),
        path = url.pathname,
        method = init.method ?? "GET";
      calls.push({ method, path });
      if (broken) throw Error("secret transport details");
      if (path.endsWith("/credentials"))
        return Response.json({
          files: [...remote]
            .filter(([, row]) => row.status === "complete")
            .map(([id, row]) => ({
              name: `enterprise-${id}.json`,
              provider: row.provider,
              status: "active",
            })),
        });
      if (path.endsWith("/remote")) {
        const { id, provider } = JSON.parse(String(init.body));
        const row = {
          status: "pending",
          provider,
          flow: provider === "claude" ? "manual_code" : "device",
          url: malicious
            ? "https://evil.test/steal"
            : provider === "claude"
              ? "https://claude.ai/oauth/authorize?state=fixture"
              : provider === "xai"
                ? "https://accounts.x.ai/oauth2/device"
                : "https://auth.openai.com/codex/device",
          user_code: provider === "claude" ? undefined : "DISPLAY",
          interval: 5,
          expires_at: new Date(Date.now() + 120_000).toISOString(),
        };
        remote.set(id, row);
        if (lostStart) {
          lostStart = false;
          throw Error("lost response");
        }
        return Response.json(row);
      }
      const [, id, operation] =
        path.match(/\/remote\/([^/]+)(?:\/(\w+))?$/) ?? [];
      const row = remote.get(id);
      if (!row) return Response.json({ status: "interrupted" });
      if (method === "DELETE") {
        row.status = "cancelled";
        return Response.json(row);
      }
      if (operation === "code") {
        assert.equal(row.flow, "manual_code");
        row.status = "ready";
        return Response.json({ status: "pending" });
      }
      if (operation === "commit") {
        commits++;
        await beforeCommit?.();
        row.status = "complete";
        return Response.json(row);
      }
      return Response.json({
        ...row,
        access_token: "NEVER-EXPOSE",
        device_auth_id: "PRIVATE-ID",
        code_verifier: "PRIVATE-PKCE",
      });
    }) as typeof fetch,
  };
  let service = new InferenceService(f.ctx, options);
  await service.initialize();
  const app = Fastify();
  app.setErrorHandler((e: any, _req, reply) =>
    reply
      .code(e.statusCode ?? 500)
      .send({ error: { code: e.code, message: e.message } }),
  );
  await registerInferenceRoutes(app, f.ctx, service);
  closeOAuth = () => service.closeOAuth();
  t.after(async () => {
    await app.close();
    await service.closeOAuth();
  });
  return {
    ...f,
    app,
    options,
    get service() {
      return service;
    },
    remote,
    calls,
    get commits() {
      return commits;
    },
    setLostStart: (v: boolean) => {
      lostStart = v;
    },
    setBroken: (v: boolean) => {
      broken = v;
    },
    setMalicious: (v: boolean) => {
      malicious = v;
    },
    setBeforeCommit: (v: (() => Promise<void>) | undefined) => {
      beforeCommit = v;
    },
    restart: async () => {
      await service.closeOAuth();
      service = new InferenceService(f.ctx, options);
      await service.initialize();
    },
  };
}
async function eventually(fn: () => Promise<boolean>) {
  for (let i = 0; i < 80; i++) {
    if (await fn()) return;
    await wait(50);
  }
  assert.fail("bounded sign-in condition not reached");
}

test("all remote flows expose only instructions and survive detach/navigation without duplicate grants", async (t) => {
  const f = await fixture(t);
  for (const provider of ["openai", "anthropic", "xai"] as const) {
    const [a, b] = await Promise.all(
      [1, 2].map(() =>
        f.service.startOAuth(f.users.admin, f.orgA, provider, true),
      ),
    );
    assert.equal(a.id, b.id);
    assert.equal(a.flow, provider === "anthropic" ? "manual_code" : "device");
    assert.equal(
      f.calls.filter((c) => c.path.endsWith("/remote")).length,
      ["openai", "anthropic", "xai"].indexOf(provider) + 1,
    );
    const listing = await f.service.oauthSessions(f.users.admin, f.orgA);
    assert.ok(listing.items.some((s) => s.id === a.id));
    if (provider === "anthropic")
      await f.service.oauthCode(f.users.admin, f.orgA, a.id, "fixture-code");
    else f.remote.get(a.id).status = "ready";
    // No browser/status request drives completion.
    await eventually(
      async () =>
        (
          await f.db.get<any>(
            "SELECT status FROM inference_oauth_sessions WHERE id=?",
            [a.id],
          )
        )?.status === "complete",
    );
    const done = await f.service.oauthStatus(f.users.admin, f.orgA, a.id);
    assert.equal(done.status, "complete");
    assert.equal(done.url, undefined);
    assert.doesNotMatch(
      JSON.stringify(done),
      /NEVER-EXPOSE|PRIVATE-ID|PRIVATE-PKCE/,
    );
  }
  assert.equal(f.commits, 3);
});

test("remote sign-in binds organization, initiating administrator, session and manual-code flow", async (t) => {
  const f = await fixture(t),
    s = await f.service.startOAuth(f.users.admin, f.orgA, "openai", true);
  await assert.rejects(
    () => f.service.oauthStatus(f.users.other, f.orgB, s.id),
    { code: "oauth_session_not_found" },
  );
  await assert.rejects(
    () => f.service.oauthStatus(f.users.owner, f.orgA, s.id),
    { code: "oauth_session_not_found" },
  );
  await assert.rejects(
    () => f.service.startOAuth(f.users.full, f.orgA, "openai", true),
    { statusCode: 403 },
  );
  await assert.rejects(
    () => f.service.oauthCode(f.users.admin, f.orgA, s.id, "code"),
    { code: "oauth_session_closed" },
  );
  await f.service.cancelOAuth(f.users.admin, f.orgA, s.id);
  f.remote.get(s.id).status = "ready";
  await wait(50);
  assert.equal(f.commits, 0);
  const session = newSession(f.users.admin.id);
  await f.db.run(session.statement.sql, session.statement.params);

  // Use the ID directly from the session insert, independent of the token value.
  const id = String(session.statement.params![0]);
  const bound = await f.service.startOAuth(
    f.users.admin,
    f.orgA,
    "xai",
    true,
    id,
  );
  await f.db.run("DELETE FROM sessions WHERE id=?", [id]);
  await f.service.recheckOAuthAccess();
  assert.equal(f.remote.get(bound.id).status, "cancelled");
});

test("API restart reconnects by receipt, lost initiation is not repeated, proxy restart is interrupted", async (t) => {
  const f = await fixture(t);
  f.setLostStart(true);
  const a = await f.service.startOAuth(f.users.admin, f.orgA, "openai", true);
  await f.restart();
  f.remote.get(a.id).status = "ready";
  await eventually(
    async () =>
      (await f.service.oauthStatus(f.users.admin, f.orgA, a.id)).status ===
      "complete",
  );
  assert.equal(f.calls.filter((c) => c.path.endsWith("/remote")).length, 1);
  const b = await f.service.startOAuth(f.users.admin, f.orgA, "xai", true);
  f.remote.delete(b.id);
  await eventually(
    async () =>
      (await f.service.oauthStatus(f.users.admin, f.orgA, b.id)).status ===
      "interrupted",
  );
  assert.equal(f.commits, 1);
});

test("authority loss fences approval and rolls back a save that raced membership removal", async (t) => {
  const f = await fixture(t),
    a = await f.service.startOAuth(f.users.admin, f.orgA, "openai", true);
  f.setBeforeCommit(async () => {
    await f.db.run(
      "DELETE FROM organization_memberships WHERE org_id=? AND user_id=?",
      [f.orgA, f.users.admin.id],
    );
  });
  f.remote.get(a.id).status = "ready";
  await eventually(async () => f.remote.get(a.id).status === "cancelled");
  assert.equal(
    (
      await f.db.get<any>(
        "SELECT status FROM inference_oauth_sessions WHERE id=?",
        [a.id],
      )
    ).status,
    "cancelled",
  );
  assert.equal(f.commits, 1);
  await assert.rejects(
    () => f.service.oauthStatus(f.users.admin, f.orgA, a.id),
    { statusCode: 404 },
  );
});

test("expiry, denial, unavailable instructions and cancellation remain explicit and do not leak provider details", async (t) => {
  const f = await fixture(t);
  let a = await f.service.startOAuth(f.users.admin, f.orgA, "openai", true);
  await f.service.closeOAuth();
  await f.db.run(
    "UPDATE inference_oauth_sessions SET expires_at=? WHERE id=?",
    [new Date(Date.now() - 1).toISOString(), a.id],
  );
  await f.restart();
  await eventually(
    async () =>
      (await f.service.oauthStatus(f.users.admin, f.orgA, a.id)).status ===
      "expired",
  );
  a = await f.service.startOAuth(f.users.admin, f.orgA, "openai", true);
  f.remote.get(a.id).status = "denied";
  await eventually(
    async () =>
      (await f.service.oauthStatus(f.users.admin, f.orgA, a.id)).status ===
      "denied",
  );
  f.setMalicious(true);
  a = await f.service.startOAuth(f.users.admin, f.orgA, "openai", true);
  assert.equal(a.status, "error");
  assert.equal(a.url, undefined);
  assert.equal(f.remote.get(a.id).status, "cancelled");
  const audit = await f.db.all(
    "SELECT details FROM audit_events WHERE action='inference.subscription.started'",
  );
  assert.doesNotMatch(
    JSON.stringify(audit),
    /DISPLAY|PRIVATE|fixture-code|state=/,
  );
});

test("Cancel during an in-flight commit records intent before the lane and removes the exact late save", async (t) => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const barrier = new Promise<void>((r) => (release = r)),
    committing = new Promise<void>((r) => (entered = r));
  f.setBeforeCommit(async () => {
    entered();
    await barrier;
  });
  const a = await f.service.startOAuth(f.users.admin, f.orgA, "openai", true);
  f.remote.get(a.id).status = "ready";
  await committing;
  const cancelled = f.service.cancelOAuth(f.users.admin, f.orgA, a.id);
  await eventually(
    async () =>
      (
        await f.db.get<any>(
          "SELECT status FROM inference_oauth_sessions WHERE id=?",
          [a.id],
        )
      ).status === "cancelling",
  );
  release();
  assert.equal((await cancelled).status, "cancelled");
  assert.equal(f.remote.get(a.id).status, "cancelled");
  assert.equal(
    (await f.service.oauthStatus(f.users.admin, f.orgA, a.id)).status,
    "cancelled",
  );
});

test("an unavailable sign-in service cannot prevent idle session or project revocation", async (t) => {
  const stopped: string[] = [],
    updated: string[] = [];
  const f = await fixture(t, {
    async execute() {},
    async cancel() {},
    async recover() {
      return [];
    },
    async stopSession(_project, id) {
      stopped.push(id);
    },
    async updateProject(spec) {
      updated.push(spec.projectId);
    },
  });
  f.inference.recheckOAuthAccess = () => f.service.recheckOAuthAccess();
  const attempt = await f.service.startOAuth(
      f.users.admin,
      f.orgA,
      "openai",
      true,
    ),
    now = new Date().toISOString();
  await f.db.batch([
    {
      sql: "INSERT INTO conversations(id,org_id,project_id,creator_id,title,mode,harness,model,created_at,updated_at) VALUES('background-thread',?,?,?,'Background work','write','codex','fixture-model',?,?)",
      params: [f.orgA, f.projectA, f.users.admin.id, now, now],
    },
    {
      sql: "INSERT INTO conversation_members VALUES('background-thread',?,?,?)",
      params: [f.users.admin.id, f.users.admin.id, now],
    },
    {
      sql: "INSERT INTO conversation_runtime_owners VALUES('background-thread',?,0,'[]')",
      params: [f.users.admin.id],
    },
    {
      sql: "DELETE FROM organization_memberships WHERE org_id=? AND user_id=?",
      params: [f.orgA, f.users.admin.id],
    },
  ]);
  f.setBroken(true);
  await assert.rejects(() => f.ctx.onAccessChanged!(), {
    code: "inference_unavailable",
  });
  assert.deepEqual(stopped, ["background-thread"]);
  assert.ok(updated.includes(f.projectA));
  assert.equal(
    (await f.db.all("SELECT * FROM conversation_runtime_owners")).length,
    0,
  );
  assert.equal(
    (
      await f.db.get<any>(
        "SELECT status FROM inference_oauth_sessions WHERE id=?",
        [attempt.id],
      )
    ).status,
    "cancelling",
  );
  f.setBroken(false);
  await eventually(async () => f.remote.get(attempt.id).status === "cancelled");
});

test("uncertain saved credentials stay fenced through a long outage and restart until exact cleanup succeeds", async (t) => {
  const f = await fixture(t);
  f.options.canUseRun = async () => true;
  const a = await f.service.startOAuth(f.users.admin, f.orgA, "openai", true);
  const grant = await f.service.issueGateway({
    orgId: f.orgA,
    projectId: f.projectA,
    userId: f.users.admin.id,
    runId: "fixture-run",
    harness: "codex",
    model: "fixture-model",
  });
  f.setBeforeCommit(async () => {
    f.remote.get(a.id).status = "complete";
    f.setBroken(true);
    throw Error("lost commit response");
  });
  f.remote.get(a.id).status = "ready";
  await eventually(async () => f.remote.get(a.id).status === "complete");
  await f.service.closeOAuth();
  await assert.rejects(
    () => f.service.cancelOAuth(f.users.admin, f.orgA, a.id),
    { code: "inference_unavailable" },
  );
  await f.db.run(
    "UPDATE inference_oauth_sessions SET expires_at=? WHERE id=?",
    [new Date(Date.now() - 600_000).toISOString(), a.id],
  );
  await f.restart();
  await wait(50);
  assert.equal(
    (await f.service.oauthStatus(f.users.admin, f.orgA, a.id)).status,
    "cancelling",
  );
  await assert.rejects(
    () => f.service.authorizeGateway(f.projectA, grant.token),
    { code: "signin_cleanup_pending" },
  );
  await f.service.closeOAuth();
  f.setBroken(false);
  assert.equal(
    (await f.service.accounts(f.orgA)).items.length,
    0,
    "unconfirmed credential must not be exposed as a connection",
  );
  await f.restart();
  await eventually(async () => f.remote.get(a.id).status === "cancelled");
  await eventually(
    async () =>
      (await f.service.oauthStatus(f.users.admin, f.orgA, a.id)).status ===
      "expired",
  );
  assert.equal(
    (await f.service.authorizeGateway(f.projectA, grant.token)).orgId,
    f.orgA,
  );
  assert.equal(f.commits, 1);
  assert.equal(
    f.calls.filter((c) => c.path.endsWith("/remote")).length,
    1,
    "cleanup must never replay a grant",
  );
});
