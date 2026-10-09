import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { createDatabase, migrateFoundation } from "../apps/api/src/db/index.js";
import { AppError, createContext } from "../apps/api/src/context.js";
import { hashPassword } from "../apps/api/src/auth/password.js";
import { hashToken, newSession } from "../apps/api/src/auth/session.js";
import { registerAuth } from "../apps/api/src/auth/index.js";
import { registerOrganizations } from "../apps/api/src/organizations/index.js";
import { registerProjects } from "../apps/api/src/projects/index.js";
import {
  createJobWorker,
  JobQueue,
  registerJobs,
} from "../apps/api/src/jobs/index.js";
const password = "correct test password 47";
let passwordHash: Promise<string> | undefined;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "wme-foundation-"));
  const db = await createDatabase(join(dir, "platform.sqlite"));
  await migrateFoundation(db);
  const origin = "http://localhost:4100";
  const ctx = createContext(db, {
    stateDir: dir,
    publicOrigin: origin,
    host: "127.0.0.1",
    port: 4100,
    secureCookies: false,
  });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number; code?: string };
    reply
      .code(e instanceof AppError ? e.statusCode : 500)
      .send({ error: { code: e.code ?? "internal", message: e.message } });
  });
  await registerAuth(app, ctx);
  await registerOrganizations(app, ctx);
  await registerProjects(app, ctx);
  await registerJobs(app, ctx);
  const orgA = randomUUID(),
    orgB = randomUUID(),
    now = new Date().toISOString();
  await db.batch([
    {
      sql: "INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)",
      params: [orgA, "A", now],
    },
    {
      sql: "INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)",
      params: [orgB, "B", now],
    },
  ]);
  const hash = await (passwordHash ??= hashPassword(password));
  const identities: any = {};
  for (const [key, role, orgId] of [
    ["owner", "owner", null],
    ["admin", "admin", orgA],
    ["member", "member", orgA],
    ["other", "admin", orgB],
  ] as const) {
    const id = randomUUID();
    await db.run(
      "INSERT INTO users (id,org_id,email,name,role,enabled,password_hash,created_at) VALUES (?,?,?,?,?,1,?,?)",
      [id, orgId, `${key}@test.example`, key, role, hash, now],
    );
    const session = newSession(id);
    await db.run(session.statement.sql, session.statement.params);
    identities[key] = {
      id,
      orgId,
      role,
      headers: {
        origin,
        cookie: `wme_session=${session.token}`,
        "x-csrf-token": session.csrfToken,
      },
      session,
    };
  }
  return {
    app,
    ctx,
    db,
    dir,
    orgA,
    orgB,
    origin,
    ...identities,
    async close() {
      await app.close();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("worker SQLite migrations are idempotent and batch conflicts roll back atomically", async () => {
  const f = await fixture();
  try {
    await migrateFoundation(f.db);
    const id = randomUUID();
    await assert.rejects(
      f.db.batch([
        {
          sql: "INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)",
          params: [id, "rollback", new Date().toISOString()],
        },
        {
          sql: "UPDATE organizations SET name=? WHERE id=?",
          params: ["x", "missing"],
          expectChanges: 1,
        },
      ]),
      /Concurrent update conflict/,
    );
    assert.equal(
      await f.db.get("SELECT * FROM organizations WHERE id=?", [id]),
      undefined,
    );
    await Promise.all([f.db.close(), f.db.close()]);
    await assert.rejects(f.db.get("SELECT 1"), /closed/);
  } finally {
    await f.close();
  }
});
test("browser mutations require exact Origin and CSRF; owner-only organization creation", async () => {
  const f = await fixture();
  try {
    for (const headers of [
      { cookie: f.owner.headers.cookie },
      { ...f.owner.headers, origin: "http://evil.test" },
      { ...f.owner.headers, "x-csrf-token": "wrong" },
    ]) {
      const r = await f.app.inject({
        method: "POST",
        url: "/enterprise/api/organizations",
        headers,
        payload: { name: "N" },
      });
      assert.equal(r.statusCode, 403);
    }
    const denied = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/organizations",
      headers: f.admin.headers,
      payload: { name: "N" },
    });
    assert.equal(denied.statusCode, 403);
    const ok = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/organizations",
      headers: f.owner.headers,
      payload: { name: "N" },
    });
    assert.equal(ok.statusCode, 201);
  } finally {
    await f.close();
  }
});
test("login uses opaque hashed session identities and logout revokes the session", async () => {
  const f = await fixture();
  try {
    const wrong = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/login",
      headers: { origin: f.origin },
      payload: { email: "admin@test.example", password: "incorrect" },
    });
    assert.equal(wrong.statusCode, 401);
    const ok = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/login",
      headers: { origin: f.origin },
      payload: { email: "ADMIN@test.example", password },
    });
    assert.equal(ok.statusCode, 200);
    const cookie = String(ok.headers["set-cookie"]).split(";")[0];
    assert.match(String(ok.headers["set-cookie"]), /HttpOnly; SameSite=Lax/);
    const token = cookie.split("=")[1];
    assert.equal(
      await f.db.get("SELECT id FROM sessions WHERE id=?", [token]),
      undefined,
    );
    assert.ok(
      await f.db.get("SELECT id FROM sessions WHERE id=?", [hashToken(token)]),
    );
    const headers = {
      origin: f.origin,
      cookie,
      "x-csrf-token": ok.json().csrfToken,
    };
    const sessionId = await f.db.get("SELECT id FROM sessions WHERE id=?", [
      hashToken(token),
    ]);
    assert.equal(await f.ctx.isSessionActive(sessionId!.id, f.admin.id), true);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/enterprise/api/logout",
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(await f.ctx.isSessionActive(sessionId!.id, f.admin.id), false);
    assert.equal(
      (
        await f.app.inject({
          url: "/enterprise/api/session",
          headers: { cookie },
        })
      ).json().user,
      null,
    );
  } finally {
    await f.close();
  }
});
test("personal profile persists own model preference without changing identity or role", async () => {
  const f = await fixture();
  try {
    const update = await f.app.inject({
      method: "PATCH",
      url: "/enterprise/api/me",
      headers: f.admin.headers,
      payload: {
        id: f.owner.id,
        email: "owner@test.example",
        role: "owner",
        name: "Admin Renamed",
        theme: "cognac",
        defaultModel: "preferred-model",
      },
    });
    assert.equal(update.statusCode, 200);
    assert.equal(update.json().name, "Admin Renamed");
    assert.equal(update.json().theme, "cognac");
    assert.equal(update.json().defaultModel, "preferred-model");
    assert.equal(update.json().email, "admin@test.example");
    assert.equal(update.json().role, "admin");
    const row = await f.db.get("SELECT * FROM users WHERE id=?", [f.admin.id]);
    assert.equal(row.name, "Admin Renamed");
    assert.equal(row.theme, "cognac");
    assert.equal(row.default_model, "preferred-model");
    const profile = await f.app.inject({
      url: "/enterprise/api/me",
      headers: f.admin.headers,
    });
    assert.equal(profile.json().user.defaultModel, "preferred-model");
    assert.equal(row.email, "admin@test.example");
    assert.equal(row.role, "admin");
  } finally {
    await f.close();
  }
});
test("password reset tokens are hashed, expiring, single use, and revoke sessions", async () => {
  const f = await fixture();
  try {
    const request = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/password-reset/request",
      headers: { origin: f.origin },
      payload: { email: "ADMIN@test.example" },
    });
    assert.equal(request.statusCode, 202);
    const tokenRow = await f.db.get(
      "SELECT * FROM password_reset_tokens WHERE user_id=?",
      [f.admin.id],
    );
    assert.ok(tokenRow);
    const job = await f.db.get(
      "SELECT * FROM jobs WHERE type='password_reset.deliver'",
    );
    const payload = JSON.parse(job.payload);
    const token = new URL(payload.resetUrl).searchParams.get("token")!;
    assert.notEqual(tokenRow.token_hash, token);
    assert.equal(tokenRow.token_hash, hashToken(token));
    assert.equal(tokenRow.request_ip_hash, hashToken("127.0.0.1"));
    assert.equal(
      (
        await f.app.inject({
          url: `/enterprise/api/jobs/${job.id}`,
          headers: f.owner.headers,
        })
      ).statusCode,
      404,
    );
    const oldSessionId = await f.db.get(
      "SELECT id FROM sessions WHERE user_id=? LIMIT 1",
      [f.admin.id],
    );
    assert.ok(oldSessionId);
    const reset = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/password-reset/confirm",
      headers: { origin: f.origin },
      payload: { token, password: "new correct test password 47" },
    });
    assert.equal(reset.statusCode, 200);
    assert.equal(
      await f.ctx.isSessionActive(oldSessionId!.id, f.admin.id),
      false,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/enterprise/api/password-reset/confirm",
          headers: { origin: f.origin },
          payload: { token, password: "another correct test password 47" },
        })
      ).statusCode,
      400,
    );
    const expiredToken = "expired-reset-token";
    await f.db.run("INSERT INTO password_reset_tokens VALUES (?,?,?,?,?,?,?)", [
      randomUUID(),
      f.admin.id,
      hashToken(expiredToken),
      new Date(Date.now() - 1000).toISOString(),
      null,
      new Date(Date.now() - 3600_000).toISOString(),
      null,
    ]);
    const expired = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/password-reset/confirm",
      headers: { origin: f.origin },
      payload: {
        token: expiredToken,
        password: "expired correct test password 47",
      },
    });
    assert.equal(expired.statusCode, 400);
  } finally {
    await f.close();
  }
});
test("successful password reset invalidates every outstanding reset token for the user", async () => {
  const f = await fixture();
  try {
    const tokens: string[] = [];
    for (let index = 0; index < 2; index++) {
      const request = await f.app.inject({
        method: "POST",
        url: "/enterprise/api/password-reset/request",
        headers: { origin: f.origin },
        payload: { email: "admin@test.example" },
      });
      assert.equal(request.statusCode, 202);
      const jobs = await f.db.all(
        "SELECT * FROM jobs WHERE type='password_reset.deliver' ORDER BY created_at,id",
      );
      const payload = JSON.parse(jobs[index].payload);
      tokens.push(new URL(payload.resetUrl).searchParams.get("token")!);
    }
    const oldSessions = await f.db.all(
      "SELECT id FROM sessions WHERE user_id=?",
      [f.admin.id],
    );
    const first = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/password-reset/confirm",
      headers: { origin: f.origin },
      payload: { token: tokens[0], password: "fresh correct test password 47" },
    });
    assert.equal(first.statusCode, 200);
    const second = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/password-reset/confirm",
      headers: { origin: f.origin },
      payload: {
        token: tokens[1],
        password: "second correct test password 47",
      },
    });
    assert.equal(second.statusCode, 400);
    const activeRows = await f.db.all(
      "SELECT id FROM sessions WHERE user_id=? ORDER BY created_at",
      [f.admin.id],
    );
    assert.equal(activeRows.length, 1);
    assert.notEqual(activeRows[0].id, oldSessions[0].id);
    assert.equal(
      await f.db.get(
        "SELECT id FROM password_reset_tokens WHERE user_id=? AND used_at IS NULL",
        [f.admin.id],
      ),
      undefined,
    );
  } finally {
    await f.close();
  }
});
test("organization admins can queue member password resets only inside their scope", async () => {
  const f = await fixture();
  try {
    const reset = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgA}/members/${f.member.id}/password-reset`,
      headers: f.admin.headers,
      payload: {},
    });
    assert.equal(reset.statusCode, 202);
    assert.equal(reset.json().resetUrl, undefined);
    assert.match(reset.json().message, /queued/i);
    const tokenRow = await f.db.get(
      "SELECT * FROM password_reset_tokens WHERE user_id=?",
      [f.member.id],
    );
    assert.ok(tokenRow);
    const job = await f.db.get(
      "SELECT * FROM jobs WHERE type='password_reset.deliver' AND org_id=?",
      [f.orgA],
    );
    assert.ok(job);
    const payload = JSON.parse(job.payload);
    const token = new URL(payload.resetUrl).searchParams.get("token")!;
    assert.equal(tokenRow.token_hash, hashToken(token));
    assert.equal(tokenRow.request_ip_hash, hashToken("127.0.0.1"));
    const crossOrg = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgA}/members/${f.other.id}/password-reset`,
      headers: f.admin.headers,
      payload: {},
    });
    assert.equal(crossOrg.statusCode, 404);
    const memberDenied = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgA}/members/${f.admin.id}/password-reset`,
      headers: f.member.headers,
      payload: {},
    });
    assert.equal(memberDenied.statusCode, 403);
    const ownerDenied = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgA}/members/${f.owner.id}/password-reset`,
      headers: f.admin.headers,
      payload: {},
    });
    assert.equal(ownerDenied.statusCode, 404);
    const pendingId = randomUUID();
    await f.db.run(
      "INSERT INTO users (id,org_id,email,name,role,enabled,created_at) VALUES (?,?,?,?,?,0,?)",
      [
        pendingId,
        f.orgA,
        "pending@test.example",
        "Pending",
        "member",
        new Date().toISOString(),
      ],
    );
    const pending = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgA}/members/${pendingId}/password-reset`,
      headers: f.admin.headers,
      payload: {},
    });
    assert.equal(pending.statusCode, 409);
  } finally {
    await f.close();
  }
});
test("invitation activation is single use, grants requested role, and outbox does not expose token", async () => {
  const f = await fixture();
  try {
    const r = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgA}/invitations`,
      headers: f.admin.headers,
      payload: { email: "new@test.example", name: "New", role: "member" },
    });
    assert.equal(r.statusCode, 202);
    assert.equal(r.json().user.enabled, false);
    const job = await new JobQueue(f.ctx).get(r.json().jobId);
    const url = new URL(String(job!.payload.activationUrl));
    const token = url.searchParams.get("token")!;
    assert.equal(
      new URL(r.json().activationUrl).searchParams.get("token"),
      token,
    );
    const view = await f.app.inject({
      url: `/enterprise/api/jobs/${job!.id}`,
      headers: f.admin.headers,
    });
    assert.equal(view.body.includes(token), false);
    const worker = createJobWorker(f.ctx, {});
    await worker.runOnce();
    assert.equal(
      (await new JobQueue(f.ctx).get(job!.id))!.status,
      "needs_attention",
    );
    const activated = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/activate",
      headers: { origin: f.origin },
      payload: { token, password },
    });
    assert.equal(activated.statusCode, 200);
    assert.equal(activated.json().user.role, "member");
    assert.equal(activated.json().user.enabled, true);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/enterprise/api/activate",
          headers: { origin: f.origin },
          payload: { token, password },
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});
test("project and tenant authorization reflects grants, access ceilings, and revocation immediately", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.app.inject({
          url: `/enterprise/api/organizations/${f.orgB}`,
          headers: f.admin.headers,
        })
      ).statusCode,
      404,
    );
    const created = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgA}/projects`,
      headers: f.admin.headers,
      payload: { name: "Case" },
    });
    assert.equal(created.statusCode, 202);
    const p = created.json();
    assert.equal(p.status, "provisioning");
    assert.equal(
      (
        await f.app.inject({
          url: `/enterprise/api/projects/${p.id}`,
          headers: f.member.headers,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/enterprise/api/projects/${p.id}/members`,
          headers: f.admin.headers,
          payload: { userId: f.other.id, access: "write" },
        })
      ).statusCode,
      404,
    );
    await f.app.inject({
      method: "POST",
      url: `/enterprise/api/projects/${p.id}/members`,
      headers: f.admin.headers,
      payload: { userId: f.member.id, access: "write" },
    });
    const user = (
      await f.app.inject({
        url: "/enterprise/api/session",
        headers: f.member.headers,
      })
    ).json().user;
    assert.equal(
      (await f.ctx.requireProject(user, p.id, "write")).access,
      "write",
    );
    await f.app.inject({
      method: "PATCH",
      url: `/enterprise/api/projects/${p.id}/members/${f.member.id}`,
      headers: f.admin.headers,
      payload: { access: "read" },
    });
    await assert.rejects(
      f.ctx.requireProject(user, p.id, "write"),
      (e: any) => e.statusCode === 403,
    );
    await f.app.inject({
      method: "DELETE",
      url: `/enterprise/api/projects/${p.id}/members/${f.member.id}`,
      headers: f.admin.headers,
    });
    await assert.rejects(
      f.ctx.requireProject(user, p.id),
      (e: any) => e.statusCode === 404,
    );
  } finally {
    await f.close();
  }
});
test("removed organization membership loses its access without disabling the platform account; no owner invitation escalation", async () => {
  const f = await fixture();
  try {
    const escalated = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgA}/invitations`,
      headers: f.admin.headers,
      payload: { email: "intruder@test.example", role: "owner" },
    });
    assert.equal(escalated.statusCode, 400);
    const removed = await f.app.inject({
      method: "DELETE",
      url: `/enterprise/api/organizations/${f.orgA}/members/${f.member.id}`,
      headers: f.admin.headers,
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(
      (
        await f.app.inject({
          url: "/enterprise/api/session",
          headers: f.member.headers,
        })
      ).json().user.id,
      f.member.id,
    );
    assert.equal(
      (
        await f.app.inject({
          url: `/enterprise/api/organizations/${f.orgA}`,
          headers: f.member.headers,
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});
test("durable job leases serialize concurrent workers and fence unsafe recovery", async () => {
  const f = await fixture();
  try {
    const queue = new JobQueue(f.ctx);
    let calls = 0;
    const id = await queue.enqueue({
      orgId: f.orgA,
      type: "safe",
      idempotencyKey: "stable",
    });
    assert.equal(
      await queue.enqueue({
        orgId: f.orgA,
        type: "safe",
        idempotencyKey: "stable",
      }),
      id,
    );
    const handlers = {
      safe: {
        replaySafe: true,
        async run() {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 30));
        },
      },
    };
    const a = createJobWorker(f.ctx, handlers),
      b = createJobWorker(f.ctx, handlers);
    await Promise.all([a.runOnce(), b.runOnce()]);
    assert.equal(calls, 1);
    assert.equal((await queue.get(id))!.status, "succeeded");
    const unsafe = await queue.enqueue({ orgId: f.orgA, type: "mail" });
    await f.db.run(
      "UPDATE jobs SET status='running',lease_until=?,attempts=1 WHERE id=?",
      ["2000-01-01T00:00:00.000Z", unsafe],
    );
    const worker = createJobWorker(f.ctx, {
      mail: {
        replaySafe: false,
        async run() {
          throw new Error("Must not replay");
        },
      },
    });
    await worker.runOnce();
    assert.equal((await queue.get(unsafe))!.status, "needs_attention");
    await a.stop();
    await b.stop();
    await worker.stop();
  } finally {
    await f.close();
  }
});
test("project provision completion transitions ready only after handler succeeds", async () => {
  const f = await fixture();
  try {
    const created = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgA}/projects`,
      headers: f.admin.headers,
      payload: { name: "New runtime" },
    });
    const p = created.json();
    const worker = createJobWorker(f.ctx, {
      "project.provision": {
        replaySafe: true,
        async run({ job }) {
          assert.equal(job.projectId, p.id);
          assert.equal(
            (await f.db.get("SELECT status FROM projects WHERE id=?", [p.id]))!
              .status,
            "provisioning",
          );
        },
      },
    });
    await worker.runOnce();
    assert.equal(
      (await f.db.get("SELECT status FROM projects WHERE id=?", [p.id]))!
        .status,
      "ready",
    );
    await worker.stop();
  } finally {
    await f.close();
  }
});

test("HTTPS sessions use host-only cookies and reject an insecure sibling-domain cookie", async () => {
  const f = await fixture();
  try {
    f.ctx.config.secureCookies = true;
    f.ctx.config.publicOrigin = "https://portal.test";
    const response = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/login",
      headers: { origin: "https://portal.test" },
      payload: { email: "admin@test.example", password },
    });
    assert.equal(response.statusCode, 200);
    assert.match(
      String(response.headers["set-cookie"]),
      /^__Host-wme_session=/,
    );
    assert.match(String(response.headers["set-cookie"]), /; Secure/);
    const secureCookie = String(response.headers["set-cookie"]).split(";")[0];
    assert.equal(
      (
        await f.app.inject({
          url: "/enterprise/api/session",
          headers: { cookie: f.admin.headers.cookie },
        })
      ).json().user,
      null,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/enterprise/api/session",
          headers: { cookie: secureCookie },
        })
      ).json().user.id,
      f.admin.id,
    );
  } finally {
    await f.close();
  }
});
test("removing or reinviting a pending account invalidates the previous activation URL", async () => {
  const f = await fixture();
  try {
    const invite = async () =>
      f.app.inject({
        method: "POST",
        url: `/enterprise/api/organizations/${f.orgA}/invitations`,
        headers: f.admin.headers,
        payload: { email: "pending@test.example", name: "Pending" },
      });
    const first = (await invite()).json();
    const firstToken = new URL(first.activationUrl).searchParams.get("token");
    const second = (await invite()).json();
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/enterprise/api/activate",
          headers: { origin: f.origin },
          payload: { token: firstToken, password },
        })
      ).statusCode,
      400,
    );
    await f.app.inject({
      method: "DELETE",
      url: `/enterprise/api/organizations/${f.orgA}/members/${second.user.id}`,
      headers: f.admin.headers,
    });
    const secondToken = new URL(second.activationUrl).searchParams.get("token");
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/enterprise/api/activate",
          headers: { origin: f.origin },
          payload: { token: secondToken, password },
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});

test("audit details drop nested credential fields and bound oversized text", async () => {
  const f = await fixture();
  try {
    const user = (
      await f.app.inject({
        url: "/enterprise/api/session",
        headers: f.admin.headers,
      })
    ).json().user;
    await f.ctx.audit(user, f.orgA, "test.audit", f.orgA, {
      metadata: {
        token: "never-persist",
        nested: [{ password: "never-persist", ok: "retained" }],
      },
      text: "x".repeat(3000),
    });
    const row = await f.db.get(
      "SELECT details FROM audit_events WHERE action=?",
      ["test.audit"],
    );
    assert.equal(row.details.includes("never-persist"), false);
    assert.equal(JSON.parse(row.details).text.length, 2000);
    assert.equal(row.details.includes("retained"), true);
  } finally {
    await f.close();
  }
});

test("worker shutdown cannot falsely acknowledge an interrupted handler", async () => {
  const f = await fixture();
  try {
    const queue = new JobQueue(f.ctx);
    const id = await queue.enqueue({ orgId: f.orgA, type: "safe.shutdown" });
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker = createJobWorker(f.ctx, {
      "safe.shutdown": {
        replaySafe: true,
        async run({ signal }) {
          started();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      },
    });
    const execution = worker.runOnce();
    await running;
    await worker.stop();
    await execution;
    assert.equal((await queue.get(id))!.status, "pending");
  } finally {
    await f.close();
  }
});

test("failed project setup reports needs_attention and only admins may retry safe provisioning", async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/organizations/${f.orgA}/projects`,
      headers: f.admin.headers,
      payload: { name: "Provision failure" },
    });
    const project = response.json();
    const unavailable = createJobWorker(f.ctx, {});
    await unavailable.runOnce();
    assert.equal(
      (await f.db.get("SELECT status FROM projects WHERE id=?", [project.id]))
        .status,
      "needs_attention",
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/enterprise/api/projects/${project.id}/retry`,
          headers: f.other.headers,
        })
      ).statusCode,
      404,
    );
    const retry = await f.app.inject({
      method: "POST",
      url: `/enterprise/api/projects/${project.id}/retry`,
      headers: f.admin.headers,
    });
    assert.equal(retry.statusCode, 202);
    assert.equal(
      (await f.db.get("SELECT status FROM projects WHERE id=?", [project.id]))
        .status,
      "provisioning",
    );
    const available = createJobWorker(f.ctx, {
      "project.provision": { replaySafe: true, async run() {} },
    });
    await available.runOnce();
    assert.equal(
      (await f.db.get("SELECT status FROM projects WHERE id=?", [project.id]))
        .status,
      "ready",
    );
    const mailId = await new JobQueue(f.ctx).enqueue({
      orgId: f.orgA,
      type: "invitation.deliver",
    });
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/enterprise/api/jobs/${mailId}/retry`,
          headers: f.admin.headers,
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test("SQLite lock contention is surfaced as a structured retryable busy error", async () => {
  const f = await fixture();
  const second = await createDatabase(join(f.dir, "platform.sqlite"));
  try {
    await second.run("PRAGMA busy_timeout=10");
    await f.db.run("BEGIN IMMEDIATE");
    await assert.rejects(
      second.run("UPDATE organizations SET name=? WHERE id=?", [
        "locked",
        f.orgA,
      ]),
      (error: any) =>
        error.code === "database_busy" && error.statusCode === 503,
    );
  } finally {
    await f.db.run("ROLLBACK");
    await second.close();
    await f.close();
  }
});

for (const administrative of [false, true]) {
  test(`concurrent ${administrative ? "admin" : "public"} password reset requests respect the per-user cap`, async () => {
    const f = await fixture();
    try {
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          f.app.inject({
            method: "POST",
            url: administrative
              ? `/enterprise/api/organizations/${f.orgA}/members/${f.member.id}/password-reset`
              : "/enterprise/api/password-reset/request",
            remoteAddress: `192.0.2.${i + 1}`,
            headers: administrative ? f.admin.headers : { origin: f.origin },
            payload: administrative ? {} : { email: "member@test.example" },
          }),
        ),
      );
      const tokens = await f.db.all(
        "SELECT id FROM password_reset_tokens WHERE user_id=?",
        [f.member.id],
      );
      const jobs = await f.db.all(
        "SELECT id FROM jobs WHERE type='password_reset.deliver'",
      );
      assert.equal(tokens.length, 5);
      assert.equal(jobs.length, 5);
      assert.equal(
        responses.filter((r) => r.statusCode === 202).length,
        administrative ? 5 : 12,
      );
      assert.equal(
        responses.filter((r) => r.statusCode === 429).length,
        administrative ? 7 : 0,
      );
    } finally {
      await f.close();
    }
  });
}

test("same-host HTTPS deployments use independent host-only session cookies", async () => {
  const f = await fixture();
  try {
    f.ctx.config.secureCookies = true;
    f.ctx.config.publicOrigin = "https://portal.test:12443";
    f.ctx.config.sessionCookieName = "wme_pr3_dev_session";
    const originalCookie = `__Host-wme_session=${f.admin.session.token}`;
    const login = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/login",
      headers: { origin: f.ctx.config.publicOrigin, cookie: originalCookie },
      payload: { email: "admin@test.example", password },
    });
    assert.equal(login.statusCode, 200);
    const header = String(login.headers["set-cookie"]);
    assert.match(header, /^__Host-wme_pr3_dev_session=/);
    assert.match(header, /; Secure/);
    assert.match(header, /; Path=\//);
    assert.doesNotMatch(header, /Domain=/i);
    const devCookie = header.split(";")[0];
    assert.equal(
      (
        await f.app.inject({
          url: "/enterprise/api/session",
          headers: { cookie: originalCookie },
        })
      ).json().user,
      null,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/enterprise/api/session",
          headers: { cookie: `${originalCookie}; ${devCookie}` },
        })
      ).json().user.id,
      f.admin.id,
    );
    const logout = await f.app.inject({
      method: "POST",
      url: "/enterprise/api/logout",
      headers: {
        origin: f.ctx.config.publicOrigin,
        cookie: `${originalCookie}; ${devCookie}`,
        "x-csrf-token": login.json().csrfToken,
      },
    });
    assert.equal(logout.statusCode, 200);
    assert.match(
      String(logout.headers["set-cookie"]),
      /^__Host-wme_pr3_dev_session=/,
    );
    assert.ok(
      await f.db.get("SELECT id FROM sessions WHERE id=?", [
        hashToken(f.admin.session.token),
      ]),
    );
  } finally {
    await f.close();
  }
});
