import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { platformFixture } from "./fixtures/platform.js";
import { createDatabase, migrateFoundation } from "../apps/api/src/db/index.js";
import { createContext } from "../apps/api/src/context.js";
import {
  migrateAssets,
  registerReports,
} from "../apps/api/src/library/assets.js";
import {
  uploadFile,
  shareFile,
  revokeShare,
} from "../apps/api/src/files/service.js";
const doc = (text: string) => ({
  version: 1,
  blocks: [{ type: "text", text }],
});

test("organization assets need no project; drafts and previews stay private until explicit publication", async (t) => {
  const f = await platformFixture(t);
  await f.db.run(
    "INSERT INTO organizations(id,name,created_at) VALUES('empty-org','Empty organization',?)",
    [new Date().toISOString()],
  );
  const response = await f.request(
    "owner",
    "POST",
    "/enterprise/api/organizations/empty-org/assets",
    {
      name: "Organization brief",
      description: "Private preparation",
      document: doc("Initial private content"),
      visibility: "public",
    },
  );
  assert.equal(response.statusCode, 201, response.body);
  let a = response.json();
  assert.equal(a.projectId, null);
  assert.equal(a.visibility, "public");
  assert.equal(a.status, "draft");
  assert.equal((await f.request(undefined, "GET", a.url)).statusCode, 404);
  assert.equal(
    (await f.request(undefined, "GET", a.url + "/preview")).statusCode,
    401,
  );
  assert.equal(
    (await f.request("owner", "GET", a.url + "/preview")).statusCode,
    200,
  );
  assert.equal(
    (
      await f.request("owner", "PATCH", `/enterprise/api/assets/${a.id}`, {
        visibility: "project",
      })
    ).statusCode,
    400,
  );
  a = (
    await f.request("owner", "PATCH", `/enterprise/api/assets/${a.id}`, {
      expectedRevision: a.revision,
      document: doc("Private draft content"),
    })
  ).json();
  await f.request("owner", "PATCH", `/enterprise/api/assets/${a.id}`, {
    visibility: "public",
  });
  assert.equal((await f.request(undefined, "GET", a.url)).statusCode, 404);
  a = (
    await f.request("owner", "GET", `/enterprise/api/assets/${a.id}`)
  ).json();
  const published = await f.request(
    "owner",
    "POST",
    `/enterprise/api/assets/${a.id}/publish`,
    { expectedRevision: a.revision, visibility: "public" },
  );
  assert.equal(published.statusCode, 200, published.body);
  const page = await f.request(undefined, "GET", a.url);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Private draft content/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(
    (await f.request(undefined, "GET", a.url + "/preview")).statusCode,
    401,
  );
});

test("asset ownership, full/read permissions and cross-organization boundaries apply to every draft operation", async (t) => {
  const f = await platformFixture(t),
    base = `/enterprise/api/organizations/${f.orgA}/assets`;
  assert.equal(
    (await f.request("full", "POST", base, { name: "Org draft", draft: true }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await f.request("read", "POST", base, {
        name: "Project draft",
        projectId: f.projectA,
        draft: true,
      })
    ).statusCode,
    403,
  );
  const r = await f.request("full", "POST", base, {
    name: "Project draft",
    projectId: f.projectA,
    draft: true,
  });
  assert.equal(r.statusCode, 201, r.body);
  const a = r.json(),
    path = `/enterprise/api/assets/${a.id}`;
  for (const actor of ["read", "other"]) {
    assert.ok(
      [403, 404].includes((await f.request(actor, "GET", path)).statusCode),
    );
    assert.ok(
      [403, 404].includes(
        (await f.request(actor, "GET", a.url + "/preview")).statusCode,
      ),
    );
    for (const [method, url, body] of [
      ["PATCH", path, { name: "Changed", expectedRevision: 1 }],
      ["POST", path + "/publish", { expectedRevision: 1 }],
      ["POST", path + "/versions/1/restore", { expectedRevision: 1 }],
    ] as const)
      assert.ok(
        [403, 404].includes(
          (await f.request(actor, method, url, body)).statusCode,
        ),
      );
  }
  assert.equal((await f.request("read", "GET", base)).json().items.length, 0);
  await f.db.run(
    "UPDATE project_members SET access='read' WHERE project_id=? AND user_id=?",
    [f.projectA, f.users.full.id],
  );
  assert.equal(
    (
      await f.request("full", "PATCH", path, {
        document: doc("write"),
        expectedRevision: 1,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.request("full", "POST", path + "/publish", {
        expectedRevision: 1,
      })
    ).statusCode,
    403,
  );
  await f.db.run(
    "DELETE FROM organization_memberships WHERE org_id=? AND user_id=?",
    [f.orgA, f.users.full.id],
  );
  assert.equal(
    (await f.request("full", "GET", a.url + "/preview")).statusCode,
    404,
  );
});

test("draft edits cannot leak into published output; publication is versioned, fenced and recoverable", async (t) => {
  const f = await platformFixture(t),
    r = await f.request(
      "admin",
      "POST",
      `/enterprise/api/organizations/${f.orgA}/assets`,
      { name: "Original", draft: true },
    );
  let a = r.json();
  const path = `/enterprise/api/assets/${a.id}`;
  a = (
    await f.request("admin", "PATCH", path, {
      expectedRevision: a.revision,
      document: doc("Version one"),
    })
  ).json();
  a = (
    await f.request("admin", "POST", path + "/publish", {
      expectedRevision: a.revision,
      visibility: "public",
    })
  ).json();
  const old = a.revision;
  a = (
    await f.request("admin", "PATCH", path, {
      expectedRevision: a.revision,
      name: "Secret title",
      description: "Private description",
      document: doc("Secret draft"),
    })
  ).json();
  const live = await f.request(undefined, "GET", a.url);
  assert.match(live.body, /Original|Version one/);
  assert.doesNotMatch(live.body, /Secret/);
  const reader = (await f.request("read", "GET", path)).json();
  assert.equal(reader.name, "Original");
  assert.equal(reader.document, undefined);
  assert.equal(reader.versions, undefined);
  assert.equal(
    (
      await f.request("admin", "POST", path + "/publish", {
        expectedRevision: old,
      })
    ).statusCode,
    409,
  );
  const raced = await Promise.all(
    [1, 2].map(() =>
      f.request("admin", "POST", path + "/publish", {
        expectedRevision: a.revision,
      }),
    ),
  );
  assert.deepEqual(raced.map((r) => r.statusCode).sort(), [200, 409]);
  a = (await f.request("admin", "GET", path)).json();
  assert.equal(a.versions.length, 2);
  a = (
    await f.request("admin", "POST", path + "/versions/1/restore", {
      expectedRevision: a.revision,
    })
  ).json();
  assert.equal(a.document.blocks[0].text, "Version one");
  assert.match((await f.request(undefined, "GET", a.url)).body, /Secret draft/);
  await f.request("admin", "POST", path + "/publish", {
    expectedRevision: a.revision,
  });
  assert.match((await f.request(undefined, "GET", a.url)).body, /Version one/);
  await f.request("admin", "DELETE", path);
  assert.equal((await f.request(undefined, "GET", a.url)).statusCode, 404);
});

test("organization content cannot borrow project authority; source revocation also prevents restoring historical versions", async (t) => {
  const f = await platformFixture(t),
    base = `/enterprise/api/organizations/${f.orgA}/assets`;
  const project = await uploadFile(
    f.ctx,
    f.users.full,
    { orgId: f.orgA, projectId: f.projectA },
    "prepared.json",
    Buffer.from(JSON.stringify(doc("Project secret"))),
  );
  const orgDraft = (
    await f.request("admin", "POST", base, { name: "Org", draft: true })
  ).json();
  assert.equal(
    (
      await f.request(
        "admin",
        "PATCH",
        `/enterprise/api/assets/${orgDraft.id}`,
        { expectedRevision: 1, sourceFileId: project.id },
      )
    ).statusCode,
    403,
  );
  const library = await uploadFile(
    f.ctx,
    f.users.admin,
    { orgId: f.orgA },
    "numbers.json",
    Buffer.from('[{"total":5}]'),
  );
  const content = {
    version: 1,
    blocks: [
      {
        type: "table",
        fileId: library.id,
        columns: [{ label: "Total", key: "total" }],
      },
    ],
  };
  assert.equal(
    (
      await f.request(
        "admin",
        "PATCH",
        `/enterprise/api/assets/${orgDraft.id}`,
        { expectedRevision: 1, document: content },
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.request("full", "POST", base, {
        name: "Unshared",
        projectId: f.projectA,
        document: content,
      })
    ).statusCode,
    403,
  );
  await shareFile(f.ctx, f.users.admin, library.id, f.projectA, "read");
  const a = (
    await f.request("full", "POST", base, {
      name: "Shared",
      projectId: f.projectA,
      document: content,
      visibility: "public",
      publish: true,
    })
  ).json();
  assert.equal((await f.request(undefined, "GET", a.url)).statusCode, 200);
  await revokeShare(f.ctx, f.users.admin, library.id, f.projectA);
  assert.equal((await f.request(undefined, "GET", a.url)).statusCode, 403);
  assert.equal(
    (
      await f.request(
        "full",
        "POST",
        `/enterprise/api/assets/${a.id}/versions/1/restore`,
        { expectedRevision: 1 },
      )
    ).statusCode,
    403,
  );
});

test("old published-report database upgrades atomically without changing IDs, routes, visibility or content", async (t) => {
  const db = await createDatabase(":memory:");
  t.after(() => db.close());
  await migrateFoundation(db);
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: "INSERT INTO organizations(id,name,created_at) VALUES('org','Organization',?)",
      params: [now],
    },
    {
      sql: "INSERT INTO users(id,org_id,email,name,role,enabled,created_at) VALUES('creator','org','creator@example.test','Creator','admin',1,?)",
      params: [now],
    },
    {
      sql: "INSERT INTO projects(id,org_id,name,status,created_at) VALUES('project','org','Project','ready',?)",
      params: [now],
    },
  ]);
  await db.migrate(
    "safe-reports-v1",
    `CREATE TABLE reports(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),project_id TEXT NOT NULL REFERENCES projects(id),creator_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,visibility TEXT NOT NULL DEFAULT 'project' CHECK(visibility IN ('project','organization','public')),document TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);CREATE INDEX reports_org ON reports(org_id);`,
  );
  const definition = JSON.stringify(doc("Existing published content"));
  await db.run(
    "INSERT INTO reports VALUES('existing','org','project','creator','Existing','public',?,?,?,NULL)",
    [definition, now, now],
  );
  const ctx = createContext(db, {
    stateDir: "/tmp",
    publicOrigin: "http://portal.test",
    host: "127.0.0.1",
    port: 4000,
    secureCookies: false,
  });
  await migrateAssets(ctx);
  await migrateAssets(ctx);
  const stored = await db.get<any>("SELECT * FROM reports WHERE id='existing'");
  assert.equal(stored.document, definition);
  assert.equal(stored.draft_document, definition);
  assert.equal(stored.visibility, "public");
  assert.equal(stored.published_version, 1);
  const app = Fastify();
  t.after(() => app.close());
  await registerReports(app, ctx);
  const page = await app.inject("/enterprise/reports/existing");
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.body, /Existing published content/);
  assert.equal((await db.all("PRAGMA foreign_key_check")).length, 0);
  await db.run("DELETE FROM reports WHERE id='existing'");
  assert.equal((await db.all("SELECT * FROM asset_versions")).length, 0);
});
