import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { platformFixture } from "./fixtures/platform.js";
import {
  uploadFile,
  createFolder,
  shareFile,
  listFiles,
  readFileVersion,
} from "../apps/api/src/files/index.js";
import { purgeExpiredProject } from "../apps/api/src/projects/trash.js";
test("delete immediately denies project/files/reports/network, retains recoverable state, and restores pinned placement", async (t) => {
  const f = await platformFixture(t),
    scope = {
      orgId: f.orgA,
      projectId: f.projectA,
    },
    file = await uploadFile(
      f.ctx,
      f.users.full,
      scope,
      "notes.txt",
      Buffer.from("recoverable"),
    );
  const token = await f.inference.issueProjectEgress({
    projectId: f.projectA,
    organizationId: f.orgA,
    hostId: "local",
  });
  assert.equal(
    (await f.inference.authorizeEgress(f.projectA, token)).projectId,
    f.projectA,
  );
  await assert.rejects(f.inference.authorizeGateway(f.projectA, token));
  const report = await f.request(
    "full",
    "POST",
    `/enterprise/api/organizations/${f.orgA}/assets`,
    {
      projectId: f.projectA,
      name: "Report",
      visibility: "public",
      document: {
        version: 1,
        blocks: [
          {
            type: "text",
            text: "Private project publication",
          },
        ],
      },
    },
  );
  assert.equal(report.statusCode, 201);
  assert.equal(
    (
      await f.request(
        "full",
        "DELETE",
        `/enterprise/api/projects/${f.projectA}`,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "DELETE",
        `/enterprise/api/projects/${f.projectA}`,
      )
    ).statusCode,
    202,
  );
  assert.ok(f.operations.some((o) => o.type === "stop" && o.id === f.projectA));
  assert.equal(
    (await f.request("full", "GET", `/enterprise/api/projects/${f.projectA}`))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.request("full", "GET", `/enterprise/api/files/${file.id}/content`))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.request(undefined, "GET", report.json().url)).statusCode,
    404,
  );
  await assert.rejects(f.inference.authorizeEgress(f.projectA, token));
  assert.equal(
    await readFile(
      join(f.stateDir, "workspaces/projects", f.projectA, "files/notes.txt"),
      "utf8",
    ),
    "recoverable",
  );
  assert.equal(
    (
      await f.request(
        "full",
        "GET",
        `/enterprise/api/organizations/${f.orgA}/deleted-projects`,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.request(
        "other",
        "POST",
        `/enterprise/api/deleted-projects/${f.projectA}/restore`,
        {},
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "POST",
        `/enterprise/api/deleted-projects/${f.projectA}/purge`,
        {},
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "POST",
        `/enterprise/api/deleted-projects/${f.projectA}/restore`,
        {},
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.request("full", "GET", `/enterprise/api/projects/${f.projectA}`)
    ).json().hostId,
    "local",
  );
  assert.equal(
    (await readFileVersion(f.ctx, f.users.full, file.id)).bytes.toString(),
    "recoverable",
  );
});
test("admin file recovery copies real project files to library and excludes share mountpoints; expiry purges safely", async (t) => {
  const f = await platformFixture(t),
    scope = {
      orgId: f.orgA,
      projectId: f.projectA,
    };
  await uploadFile(
    f.ctx,
    f.users.full,
    scope,
    "notes.txt",
    Buffer.from("recoverable"),
  );
  const library = await createFolder(
    f.ctx,
    f.users.admin,
    {
      orgId: f.orgA,
    },
    "Reference",
  );
  await uploadFile(
    f.ctx,
    f.users.admin,
    {
      orgId: f.orgA,
    },
    "Reference/retained.txt",
    Buffer.from("library source"),
  );
  await shareFile(
    f.ctx,
    f.users.admin,
    library.id,
    f.projectA,
    "read",
    "Shared",
  );
  await f.request("admin", "DELETE", `/enterprise/api/projects/${f.projectA}`);
  const recovered = await f.request(
    "admin",
    "POST",
    `/enterprise/api/deleted-projects/${f.projectA}/recover-files`,
    {},
  );
  assert.equal(recovered.statusCode, 200, recovered.body);
  const items = await listFiles(
    f.ctx,
    f.users.admin,
    {
      orgId: f.orgA,
    },
    recovered.json().path,
  );
  assert.deepEqual(
    items.map((f) => f.name),
    ["notes.txt"],
  );
  const sentinel = join(f.stateDir, "outside.txt");
  await writeFile(sentinel, "never delete");
  await symlink(
    sentinel,
    join(f.stateDir, "workspaces/projects", f.projectA, "files/escape"),
  );
  const unsafe = await f.request(
    "admin",
    "POST",
    `/enterprise/api/deleted-projects/${f.projectA}/recover-files`,
    {},
  );
  assert.equal(unsafe.statusCode, 409);
  assert.equal(await readFile(sentinel, "utf8"), "never delete");
  await f.db.run("UPDATE projects SET purge_after=? WHERE id=?", [
    new Date(Date.now() - 1).toISOString(),
    f.projectA,
  ]);
  assert.equal(
    (
      await f.request(
        "admin",
        "POST",
        `/enterprise/api/deleted-projects/${f.projectA}/restore`,
        {},
      )
    ).statusCode,
    410,
  );
  assert.equal(await purgeExpiredProject(f.ctx, f.projectA), true);
  assert.equal(await purgeExpiredProject(f.ctx, f.projectA), false);
  assert.equal(await readFile(sentinel, "utf8"), "never delete");
  await assert.rejects(
    stat(join(f.stateDir, "workspaces/projects", f.projectA)),
    {
      code: "ENOENT",
    },
  );
  assert.equal(
    (await f.db.get<any>("SELECT status FROM projects WHERE id=?", [
      f.projectA,
    ]))!.status,
    "purged",
  );
  assert.equal(
    (
      await listFiles(
        f.ctx,
        f.users.admin,
        {
          orgId: f.orgA,
        },
        "Reference",
      )
    )[0].name,
    "retained.txt",
  );
  assert.ok(f.operations.some((o) => o.type === "purge"));
});

test("missing lifecycle transport cannot claim restore or purge or remove recovery files", async (t) => {
  const f = await platformFixture(t);
  const uploaded = await uploadFile(
    f.ctx,
    f.users.full,
    { orgId: f.orgA, projectId: f.projectA },
    "retained.txt",
    Buffer.from("retained fixture"),
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "DELETE",
        `/enterprise/api/projects/${f.projectA}`,
      )
    ).statusCode,
    202,
  );
  f.ctx.runtime = undefined;
  assert.equal(
    (
      await f.request(
        "admin",
        "POST",
        `/enterprise/api/deleted-projects/${f.projectA}/restore`,
        {},
      )
    ).statusCode,
    503,
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "POST",
        `/enterprise/api/deleted-projects/${f.projectA}/recover-files`,
        {},
      )
    ).statusCode,
    503,
  );
  await f.db.run("UPDATE projects SET purge_after=? WHERE id=?", [
    new Date(Date.now() - 1000).toISOString(),
    f.projectA,
  ]);
  assert.equal(
    (
      await f.request(
        "admin",
        "POST",
        `/enterprise/api/deleted-projects/${f.projectA}/purge`,
        {},
      )
    ).statusCode,
    503,
  );
  assert.ok(
    await f.db.get("SELECT id FROM workspace_files WHERE id=?", [uploaded.id]),
  );
  assert.equal(
    (
      await f.db.get<{ status: string }>(
        "SELECT status FROM projects WHERE id=?",
        [f.projectA],
      )
    )?.status,
    "deleting",
  );
});
