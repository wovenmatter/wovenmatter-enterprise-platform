import test from "node:test";
import assert from "node:assert/strict";
import { platformFixture } from "./fixtures/platform.js";
test("pending identity cannot be activated by another organization, including concurrent invitations", async (t) => {
  const f = await platformFixture(t),
    email = "pending@example.test";
  const invite = (org: string, actor: string) =>
    f.request(
      actor,
      "POST",
      `/enterprise/api/organizations/${org}/invitations`,
      {
        email,
        name: "Pending",
        role: "member",
      },
    );
  const first = await invite(f.orgA, "admin");
  assert.equal(first.statusCode, 202);
  const second = await invite(f.orgB, "other");
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().activationUrl, undefined);
  const token = new URL(first.json().activationUrl).searchParams.get("token");
  const activate = await f.request(
    "admin",
    "POST",
    "/enterprise/api/activate",
    {
      token,
      password: "Synthetic-password-123!",
    },
  );
  assert.equal(activate.statusCode, 200);
  const added = await invite(f.orgB, "other");
  assert.equal(added.statusCode, 201);
  assert.equal(added.json().activationUrl, undefined);
  assert.equal(
    (
      await f.request("admin", "POST", "/enterprise/api/activate", {
        token,
        password: "Attacker-replacement-123!",
      })
    ).statusCode,
    400,
  );
  const results = await Promise.all(
    [f.orgA, f.orgB].map((org, i) =>
      f.request(
        i ? "other" : "admin",
        "POST",
        `/enterprise/api/organizations/${org}/invitations`,
        {
          email: "race@example.test",
          name: "Race",
        },
      ),
    ),
  );
  assert.equal(results.filter((r) => r.statusCode === 202).length, 1);
  assert.equal(
    (
      await f.db.all(
        "SELECT * FROM organization_memberships WHERE user_id=(SELECT id FROM users WHERE email=?)",
        ["race@example.test"],
      )
    ).length,
    1,
  );
});
test("memberships determine returned authority, scoped changes and audit organization", async (t) => {
  const f = await platformFixture(t);
  await f.db.run(
    "INSERT INTO organization_memberships VALUES(?,?,'admin','write',?)",
    [f.orgB, f.users.read.id, new Date().toISOString()],
  );
  const a = await f.request(
    "read",
    "GET",
    `/enterprise/api/organizations/${f.orgA}`,
  );
  assert.equal(a.statusCode, 200);
  assert.equal(a.json().role, "member");
  assert.equal(a.json().libraryAccess, "read");
  const b = await f.request(
    "read",
    "GET",
    `/enterprise/api/organizations/${f.orgB}`,
  );
  assert.equal(b.json().role, "admin");
  assert.equal(
    (
      await f.request(
        "read",
        "PATCH",
        `/enterprise/api/organizations/${f.orgA}`,
        {
          name: "Forbidden",
        },
      )
    ).statusCode,
    403,
  );
  const update = await f.request(
    "read",
    "PATCH",
    `/enterprise/api/organizations/${f.orgB}`,
    {
      name: "Changed B",
    },
  );
  assert.equal(update.statusCode, 200);
  assert.equal(update.json().role, "admin");
  const audits = await f.db.all<any>(
    "SELECT * FROM audit_events WHERE user_id=?",
    [f.users.read.id],
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].org_id, f.orgB);
  assert.equal(
    (
      await f.request(
        "admin",
        "DELETE",
        `/enterprise/api/organizations/${f.orgA}/members/${f.users.read.id}`,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.request("read", "GET", `/enterprise/api/organizations/${f.orgA}`))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.request("read", "GET", `/enterprise/api/projects/${f.projectA}`))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.request("read", "GET", `/enterprise/api/organizations/${f.orgB}`))
      .statusCode,
    200,
  );
  assert.equal(
    (await f.request("read", "GET", "/enterprise/api/me")).json().user.enabled,
    true,
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "POST",
        `/enterprise/api/organizations/${f.orgA}/members/${f.users.other.id}/password-reset`,
        {},
      )
    ).statusCode,
    404,
  );
});
test("library full access is per membership and never grants organization administration", async (t) => {
  const f = await platformFixture(t);
  await f.db.run(
    "INSERT INTO organization_memberships VALUES(?,?,'member','read',?)",
    [f.orgB, f.users.full.id, new Date().toISOString()],
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "PATCH",
        `/enterprise/api/organizations/${f.orgA}/members/${f.users.full.id}`,
        {
          libraryAccess: "write",
        },
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.ctx.membership(f.users.full, f.orgA)).libraryAccess,
    "write",
  );
  assert.equal(
    (await f.ctx.membership(f.users.full, f.orgB)).libraryAccess,
    "read",
  );
  for (const url of [
    `/enterprise/api/organizations/${f.orgA}/projects`,
    `/enterprise/api/organizations/${f.orgA}/invitations`,
  ])
    assert.equal(
      (
        await f.request("full", "POST", url, {
          name: "No",
          email: "notallowed@example.test",
        })
      ).statusCode,
      403,
    );
});
