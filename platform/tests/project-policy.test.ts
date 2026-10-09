import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { platformFixture } from "./fixtures/platform.js";
import {
  uploadFile,
  shareFile,
  revokeShare,
} from "../apps/api/src/files/index.js";
import type {
  ProjectRuntimeSpec,
  Runtime,
} from "../packages/runtime/src/types.js";
test("scheduled share policy comes from current project/library ACLs and updates before revocation returns", async (t) => {
  const policies: ProjectRuntimeSpec[] = [];
  const runtime: Runtime = {
    async updateProject(p) {
      policies.push(p);
    },
    async execute() {},
    async cancel() {},
    async recover() {
      return [];
    },
  };
  const f = await platformFixture(t, {
      runtime,
    }),
    file = await uploadFile(
      f.ctx,
      f.users.admin,
      {
        orgId: f.orgA,
      },
      "reference.txt",
      Buffer.from("live shared source"),
    );
  await shareFile(
    f.ctx,
    f.users.admin,
    file.id,
    f.projectA,
    "read",
    "Reference",
  );
  let policy = policies.findLast((p) => p.projectId === f.projectA)!;
  assert.equal(policy.scheduleEnabled, true);
  assert.equal(policy.scheduleMounts?.length, 1);
  assert.equal(policy.scheduleMounts[0].access, "read");
  assert.equal(policy.scheduleMounts[0].target, "/workspace/Reference");
  assert.ok(
    policy.scheduleMounts[0].source.endsWith(
      `/organizations/${f.orgA}/files/reference.txt`,
    ),
  );
  await shareFile(
    f.ctx,
    f.users.admin,
    file.id,
    f.projectA,
    "write",
    "Reference",
  );
  assert.equal(
    policies.findLast((p) => p.projectId === f.projectA)?.scheduleMounts?.[0]
      .access,
    "write",
  );
  await revokeShare(f.ctx, f.users.admin, file.id, f.projectA);
  assert.deepEqual(
    policies.findLast((p) => p.projectId === f.projectA)?.scheduleMounts,
    [],
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "PATCH",
        `/enterprise/api/projects/${f.projectA}`,
        {
          access: "read",
        },
      )
    ).statusCode,
    400,
  );
  assert.equal(
    policies.findLast((p) => p.projectId === f.projectA)?.scheduleEnabled,
    true,
  );
  assert.equal(
    (
      await f.request(
        "read",
        "PATCH",
        `/enterprise/api/projects/${f.projectA}`,
        {
          scheduleMounts: [
            {
              source: "/private",
              target: "/workspace/Private",
              access: "write",
            },
          ],
        },
      )
    ).statusCode,
    403,
  );
});
test("thread participant picker includes implicit project admins but excludes other organizations and revoked members", async (t) => {
  const f = await platformFixture(t);
  const thread = {
      id: randomUUID(),
    },
    now = new Date().toISOString();
  await f.db.run(
    "INSERT INTO conversations(id,org_id,project_id,creator_id,title,mode,harness,model,created_at,updated_at) VALUES(?,?,?,?,'Private thread','write','pi','fixture',?,?)",
    [thread.id, f.orgA, f.projectA, f.users.full.id, now, now],
  );
  await f.db.run(
    "INSERT INTO conversation_members(conversation_id,user_id,added_by,created_at) VALUES(?,?,?,?)",
    [thread.id, f.users.full.id, f.users.full.id, now],
  );
  const path = `/enterprise/api/conversations/${thread.id}/eligible-members`;
  const picker = await f.request("full", "GET", path);
  assert.equal(picker.statusCode, 200);
  const ids = picker.json().items.map((u: { id: string }) => u.id);
  for (const name of ["owner", "admin", "full"])
    assert.ok(ids.includes(f.users[name].id));
  assert.equal(ids.includes(f.users.read.id), false);
  assert.equal(ids.includes(f.users.other.id), false);
  assert.equal((await f.request("admin", "GET", path)).statusCode, 404);
  await f.db.run(
    "DELETE FROM organization_memberships WHERE user_id=? AND org_id=?",
    [f.users.read.id, f.orgA],
  );
  assert.equal(
    (await f.request("full", "GET", path))
      .json()
      .items.some((u: { id: string }) => u.id === f.users.read.id),
    false,
  );
});
test("a delayed schedule snapshot cannot restore a share after concurrent revocation", async (t) => {
  const policies: ProjectRuntimeSpec[] = [];
  const runtime: Runtime = {
    async updateProject(p) {
      policies.push(structuredClone(p));
    },
    async execute() {},
    async cancel() {},
    async recover() {
      return [];
    },
  };
  const f = await platformFixture(t, {
    runtime,
  });
  const file = await uploadFile(
    f.ctx,
    f.users.admin,
    {
      orgId: f.orgA,
    },
    "policy-race.txt",
    Buffer.from("synthetic reference"),
  );
  await shareFile(
    f.ctx,
    f.users.admin,
    file.id,
    f.projectA,
    "read",
    "Reference",
  );
  const original = f.db.all.bind(f.db);
  let release!: () => void, captured!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    seen = new Promise<void>((resolve) => {
      captured = resolve;
    });
  let armed = true;
  f.db.all = async <T = Record<string, unknown>>(
    ...args: Parameters<typeof f.db.all>
  ): Promise<T[]> => {
    const rows = await original<T>(...args);
    if (
      armed &&
      args[0].startsWith(
        "SELECT s.*,f.path,f.org_id FROM workspace_file_shares",
      ) &&
      args[1]?.[0] === f.projectA
    ) {
      armed = false;
      captured();
      await gate;
    }
    return rows;
  };
  const stale = f.ctx.onAccessChanged!();
  await seen;
  let acknowledged = false;
  const revocation = revokeShare(
    f.ctx,
    f.users.admin,
    file.id,
    f.projectA,
  ).then(() => {
    acknowledged = true;
  });
  // Wait until the authoritative mutation is committed, without waiting for its
  // runtime acknowledgment (which correctly queues behind the paused snapshot).
  for (let i = 0; i < 100; i++) {
    if (
      (
        await original(
          "SELECT * FROM workspace_file_shares WHERE project_id=?",
          [f.projectA],
        )
      ).length === 0
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    (
      await original("SELECT * FROM workspace_file_shares WHERE project_id=?", [
        f.projectA,
      ])
    ).length,
    0,
  );
  assert.equal(acknowledged, false);
  release();
  await Promise.all([stale, revocation]);
  assert.equal(acknowledged, true);
  assert.deepEqual(
    policies.findLast((p) => p.projectId === f.projectA)?.scheduleMounts,
    [],
  );
});

test("share revocation waits for an in-flight restore then applies current policy", async (t) => {
  const policies: ProjectRuntimeSpec[] = [];
  let entered!: () => void, release!: () => void;
  const restoring = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const runtime: Runtime = {
    async updateProject(p) {
      policies.push(structuredClone(p));
    },
    async stopProject() {},
    async restoreProject(p) {
      entered();
      await gate;
      policies.push(structuredClone(p));
    },
    async execute() {},
    async cancel() {},
    async recover() {
      return [];
    },
  };
  const f = await platformFixture(t, { runtime });
  const file = await uploadFile(
    f.ctx,
    f.users.admin,
    { orgId: f.orgA },
    "restore-reference.txt",
    Buffer.from("synthetic reference"),
  );
  await shareFile(
    f.ctx,
    f.users.admin,
    file.id,
    f.projectA,
    "read",
    "Reference",
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
  const restored = f.request(
    "admin",
    "POST",
    `/enterprise/api/deleted-projects/${f.projectA}/restore`,
    {},
  );
  await restoring;
  let acknowledged = false;
  const revoked = revokeShare(f.ctx, f.users.admin, file.id, f.projectA).then(
    () => {
      acknowledged = true;
    },
  );
  for (let i = 0; i < 100; i++) {
    if (
      !(await f.db.get(
        "SELECT file_id FROM workspace_file_shares WHERE project_id=?",
        [f.projectA],
      ))
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(acknowledged, false);
  release();
  assert.equal((await restored).statusCode, 200);
  await revoked;
  assert.deepEqual(
    policies.findLast((p) => p.projectId === f.projectA)?.scheduleMounts,
    [],
  );
  assert.equal(
    (await f.request("admin", "GET", `/enterprise/api/projects/${f.projectA}`))
      .statusCode,
    200,
  );
});

test("failed schedule revocation remains pending and retries after the transient failure", async (t) => {
  const policies: ProjectRuntimeSpec[] = [];
  let fail = false;
  const runtime: Runtime = {
    async updateProject(p) {
      if (fail) {
        fail = false;
        throw new Error("Synthetic transport unavailable");
      }
      policies.push(structuredClone(p));
    },
    async execute() {},
    async cancel() {},
    async recover() {
      return [];
    },
  };
  const f = await platformFixture(t, { runtime });
  const file = await uploadFile(
    f.ctx,
    f.users.admin,
    { orgId: f.orgA },
    "retry-reference.txt",
    Buffer.from("synthetic reference"),
  );
  await shareFile(
    f.ctx,
    f.users.admin,
    file.id,
    f.projectA,
    "read",
    "Reference",
  );
  fail = true;
  await assert.rejects(
    revokeShare(f.ctx, f.users.admin, file.id, f.projectA),
    /Synthetic transport unavailable/,
  );
  for (
    let i = 0;
    i < 70 &&
    policies.findLast((p) => p.projectId === f.projectA)?.scheduleMounts
      ?.length;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    policies.findLast((p) => p.projectId === f.projectA)?.scheduleMounts,
    [],
  );
});

test("project access comes from the user grant and administrators can manage it", async (t) => {
  const f = await platformFixture(t);
  await f.db.run("UPDATE projects SET access='read' WHERE id=?", [f.projectA]);
  for (const actor of ["owner", "admin", "full", "read"]) {
    const expected = actor === "read" ? "read" : "write";
    assert.equal(
      (await f.ctx.requireProject(f.users[actor], f.projectA)).access,
      expected,
    );
    const list = await f.request(
      actor,
      "GET",
      `/enterprise/api/organizations/${f.orgA}/projects`,
    );
    assert.equal(
      list.json().items.find((p: any) => p.id === f.projectA).access,
      expected,
    );
    const me = await f.request(actor, "GET", "/enterprise/api/me");
    assert.equal(
      me.json().projects.find((p: any) => p.id === f.projectA).access,
      expected,
    );
  }
  assert.equal(
    (
      await f.request(
        "admin",
        "POST",
        `/enterprise/api/organizations/${f.orgA}/projects`,
        { name: "Workspace" },
      )
    ).statusCode,
    202,
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "POST",
        `/enterprise/api/organizations/${f.orgA}/projects`,
        { name: "Invalid cap", access: "read" },
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "PATCH",
        `/enterprise/api/projects/${f.projectA}`,
        { access: "write" },
      )
    ).statusCode,
    400,
  );
  const grant = await f.request(
    "admin",
    "POST",
    `/enterprise/api/projects/${f.projectA}/members`,
    { userId: f.users.read.id },
  );
  assert.equal(grant.statusCode, 201);
  assert.equal(grant.json().access, "write");
  assert.equal(
    (await f.ctx.requireProject(f.users.read, f.projectA)).access,
    "write",
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "PATCH",
        `/enterprise/api/projects/${f.projectA}/members/${f.users.read.id}`,
        { access: "read" },
      )
    ).statusCode,
    200,
  );
  const { resolveProjectMounts } = await import(
    "../apps/api/src/files/sharing.js"
  );
  await assert.rejects(
    resolveProjectMounts(f.ctx, f.users.read, f.projectA, "write"),
    { code: "read_only" },
  );
  assert.equal(
    (await resolveProjectMounts(f.ctx, f.users.read, f.projectA, "read"))[0]
      .readOnly,
    true,
  );
});
