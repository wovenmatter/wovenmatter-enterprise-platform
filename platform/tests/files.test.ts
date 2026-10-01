import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDatabase, migrateFoundation } from "../apps/api/src/db/index.js";
import { createContext, type User } from "../apps/api/src/context.js";
import * as files from "../apps/api/src/files/service.js";
import {
  cleanPath,
  scopeRoot,
  withLeaf,
  readBytes,
} from "../apps/api/src/files/paths.js";
import Fastify from "fastify";
import { registerFiles } from "../apps/api/src/files/index.js";

async function fixture() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wme-files-test-"));
  const db = await createDatabase(
    path.join(stateDir, "control", "test.sqlite"),
  );
  await migrateFoundation(db);
  const timestamp = new Date().toISOString();
  await db.batch([
    {
      sql: "INSERT INTO organizations VALUES(?,?,?)",
      params: ["org-a", "A", timestamp],
    },
    {
      sql: "INSERT INTO organizations VALUES(?,?,?)",
      params: ["org-b", "B", timestamp],
    },
    ...[
      ["admin", "org-a", "admin"],
      ["member", "org-a", "member"],
      ["reader", "org-a", "member"],
      ["other", "org-b", "admin"],
    ].map(([id, org, role]) => ({
      sql: "INSERT INTO users(id,org_id,email,name,role,enabled,created_at) VALUES(?,?,?,?,?,1,?)",
      params: [id, org, `${id}@example.test`, id, role, timestamp],
    })),
    {
      sql: "INSERT INTO projects(id,org_id,name,status,access,created_at) VALUES(?,?,?,?,?,?)",
      params: ["project-a", "org-a", "A", "ready", "write", timestamp],
    },
    {
      sql: "INSERT INTO projects(id,org_id,name,status,access,created_at) VALUES(?,?,?,?,?,?)",
      params: ["project-b", "org-b", "B", "ready", "write", timestamp],
    },
    {
      sql: "INSERT INTO project_members VALUES(?,?,?,?)",
      params: ["project-a", "member", "write", timestamp],
    },
    {
      sql: "INSERT INTO project_members VALUES(?,?,?,?)",
      params: ["project-a", "reader", "read", timestamp],
    },
  ]);
  const ctx = createContext(db, {
    stateDir,
    publicOrigin: "http://localhost",
    host: "127.0.0.1",
    port: 4100,
    secureCookies: false,
  });
  await files.initializeFiles(ctx);
  const user = (
    id: string,
    role: User["role"] = "member",
    orgId = "org-a",
  ): User => ({
    id,
    orgId,
    email: `${id}@example.test`,
    name: id,
    role,
    enabled: true,
    theme: "green",
  });
  return {
    ctx,
    db,
    stateDir,
    admin: user("admin", "admin"),
    member: user("member"),
    reader: user("reader"),
    other: user("other", "admin", "org-b"),
    dispose: async () => {
      await db.close();
      await fs.rm(stateDir, { recursive: true, force: true });
    },
  };
}

test("project files are immediately usable, mutable, versioned and isolated", async () => {
  const f = await fixture();
  try {
    const scope = { orgId: "org-a", projectId: "project-a" };
    const first = await files.uploadFile(
      f.ctx,
      f.member,
      scope,
      "Evidence/a.txt",
      Buffer.from("first"),
    );
    assert.equal(
      (await files.readFileVersion(f.ctx, f.member, first.id)).bytes.toString(),
      "first",
    );
    await files.uploadFile(
      f.ctx,
      f.member,
      scope,
      "Evidence/a.txt",
      Buffer.from("second"),
    );
    const current = (
      await files.listFiles(f.ctx, f.member, scope, "Evidence")
    )[0];
    assert.equal(current.id, first.id);
    assert.notEqual(current.versionId, first.versionId);
    assert.equal(
      (
        await files.readFileVersion(f.ctx, f.member, first.id, {
          versionId: first.versionId!,
        })
      ).bytes.toString(),
      "first",
    );
    await assert.rejects(
      files.readFileVersion(f.ctx, f.other, first.id),
      /not found/u,
    );
    await assert.rejects(
      files.uploadFile(f.ctx, f.reader, scope, "bad.txt", Buffer.from("no")),
      /read-only/u,
    );
    assert.equal(
      (await files.listFiles(f.ctx, f.reader, scope, "Evidence")).length,
      1,
    );
    await files.renameFile(f.ctx, f.member, first.id, "b.txt");
    assert.equal(
      (await files.listFiles(f.ctx, f.member, scope, "Evidence"))[0].id,
      first.id,
    );
    assert.equal(
      (await files.readFileVersion(f.ctx, f.member, first.id)).name,
      "b.txt",
    );
    await files.deleteFile(f.ctx, f.member, first.id);
    assert.equal(
      (
        await files.readFileVersion(f.ctx, f.member, first.id, {
          versionId: first.versionId!,
        })
      ).bytes.toString(),
      "first",
    );
    await f.db.run(
      "DELETE FROM project_members WHERE project_id=? AND user_id=?",
      ["project-a", "member"],
    );
    await assert.rejects(
      files.readFileVersion(f.ctx, f.member, first.id, {
        versionId: first.versionId!,
      }),
      /not found/u,
    );
  } finally {
    await f.dispose();
  }
});

test("multipart route preserves relative folders and reports failed items without pretending batch success", async () => {
  const f = await fixture();
  const app = Fastify();
  try {
    f.ctx.requireUser = async () => f.member;
    await registerFiles(app, f.ctx);
    await app.ready();
    const boundary = "wme-test-boundary";
    const field = (name: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const file = (name: string, content: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n`;
    const payload =
      field("orgId", "org-a") +
      field("projectId", "project-a") +
      field("paths", JSON.stringify(["Folder/a.txt", "Folder/b.txt"])) +
      file("a.txt", "alpha") +
      file("b.txt", "beta") +
      `--${boundary}--\r\n`;
    const result = await app.inject({
      method: "POST",
      url: "/api/files/upload",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().items.length, 2);
    assert.equal(result.json().errors.length, 0);
    const listing = await app.inject(
      "/api/files?orgId=org-a&projectId=project-a&path=Folder",
    );
    assert.deepEqual(
      listing.json().items.map((r: { name: string }) => r.name),
      ["a.txt", "b.txt"],
    );
    const content = await app.inject(
      `/api/files/${result.json().items[0].id}/content?projectId=project-a`,
    );
    assert.equal(content.body, "alpha");
    assert.equal(content.headers["x-content-type-options"], "nosniff");
    assert.ok(content.headers["x-file-version"]);
    f.ctx.config.storageQuotaBytes = 10;
    const limited =
      field("orgId", "org-a") +
      field("projectId", "project-a") +
      file("c.txt", "c") +
      file("d.txt", "dd") +
      `--${boundary}--\r\n`;
    const partial = await app.inject({
      method: "POST",
      url: "/api/files/upload",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: limited,
    });
    assert.equal(partial.statusCode, 207);
    assert.equal(partial.json().items.length, 1);
    assert.equal(partial.json().errors[0].code, "storage_quota");
  } finally {
    await app.close();
    await f.dispose();
  }
});

test("organization grants inherit; shared files are consistent and revocable within project ceiling", async () => {
  const f = await fixture();
  try {
    const source = await files.createFolder(
      f.ctx,
      f.admin,
      { orgId: "org-a" },
      "Common",
    );
    const doc = await files.uploadFile(
      f.ctx,
      f.admin,
      { orgId: "org-a" },
      "Common/policy.txt",
      Buffer.from("one"),
    );
    assert.equal(
      (await files.listFiles(f.ctx, f.member, { orgId: "org-a" })).length,
      0,
    );
    await files.grantFile(f.ctx, f.admin, source.id, "member", "read");
    assert.equal(
      (await files.listFiles(f.ctx, f.member, { orgId: "org-a" }))[0].name,
      "Common",
    );
    await assert.rejects(
      files.uploadFile(
        f.ctx,
        f.member,
        { orgId: "org-a" },
        "Common/new.txt",
        Buffer.from("x"),
      ),
      /permission/u,
    );
    await files.shareFile(
      f.ctx,
      f.admin,
      source.id,
      "project-a",
      "read",
      "Policies",
    );
    const shared = (
      await files.listFiles(f.ctx, f.member, {
        orgId: "org-a",
        projectId: "project-a",
      })
    )[0];
    assert.equal(shared.path, "Policies");
    assert.equal(shared.access, "read");
    assert.equal(
      (
        await files.readFileVersion(f.ctx, f.reader, doc.id, {
          projectId: "project-a",
        })
      ).bytes.toString(),
      "one",
    );
    await assert.rejects(
      files.uploadFile(
        f.ctx,
        f.member,
        { orgId: "org-a", projectId: "project-a" },
        "Policies/policy.txt",
        Buffer.from("blocked"),
      ),
      /read-only/u,
    );
    await files.shareFile(
      f.ctx,
      f.admin,
      source.id,
      "project-a",
      "write",
      "Policies",
    );
    await files.uploadFile(
      f.ctx,
      f.member,
      { orgId: "org-a", projectId: "project-a" },
      "Policies/policy.txt",
      Buffer.from("two"),
    );
    assert.equal(
      (await files.readFileVersion(f.ctx, f.admin, doc.id)).bytes.toString(),
      "two",
    );
    const mounts = await files.resolveProjectMounts(
      f.ctx,
      f.reader,
      "project-a",
      "read",
    );
    assert.ok(mounts.every((m) => m.readOnly));
    await files.revokeShare(f.ctx, f.admin, source.id, "project-a");
    await assert.rejects(
      files.readFileVersion(f.ctx, f.reader, doc.id, {
        projectId: "project-a",
      }),
      /access/u,
    );
    await files.revokeGrant(f.ctx, f.admin, source.id, "member");
    await assert.rejects(
      files.readFileVersion(f.ctx, f.member, doc.id),
      /access/u,
    );
    await assert.rejects(
      files.shareFile(f.ctx, f.admin, source.id, "project-b", "read"),
      /not found|organizations/u,
    );
  } finally {
    await f.dispose();
  }
});

test("copy is independent and move retains identity while removing source", async () => {
  const f = await fixture();
  try {
    const folder = await files.createFolder(
      f.ctx,
      f.admin,
      { orgId: "org-a" },
      "Original",
    );
    await files.uploadFile(
      f.ctx,
      f.admin,
      { orgId: "org-a" },
      "Original/x.txt",
      Buffer.from("source"),
    );
    const copy = await files.transferFile(
      f.ctx,
      f.admin,
      folder.id,
      { orgId: "org-a", projectId: "project-a", path: "" },
      "copy",
    );
    assert.notEqual(copy.id, folder.id);
    await files.uploadFile(
      f.ctx,
      f.member,
      { orgId: "org-a", projectId: "project-a" },
      "Original/x.txt",
      Buffer.from("independent"),
    );
    const old = (
      await files.listFiles(f.ctx, f.admin, { orgId: "org-a" }, "Original")
    )[0];
    assert.equal(
      (await files.readFileVersion(f.ctx, f.admin, old.id)).bytes.toString(),
      "source",
    );
    await files.renameFile(f.ctx, f.member, copy.id, "Moved");
    const moved = await files.transferFile(
      f.ctx,
      f.admin,
      copy.id,
      { orgId: "org-a", path: "" },
      "move",
    );
    assert.equal(moved.id, copy.id);
    assert.equal(
      (
        await files.listFiles(f.ctx, f.member, {
          orgId: "org-a",
          projectId: "project-a",
        })
      ).length,
      0,
    );
    await assert.rejects(
      files.transferFile(
        f.ctx,
        f.admin,
        moved.id,
        { orgId: "org-a", path: "Moved" },
        "copy",
      ),
      /itself/u,
    );
    await assert.rejects(
      files.transferFile(
        f.ctx,
        f.admin,
        moved.id,
        { orgId: "org-b", path: "" },
        "copy",
      ),
      /organizations/u,
    );
  } finally {
    await f.dispose();
  }
});

test("native edits and renames reconcile into stable identities and symlinks never escape", async () => {
  const f = await fixture();
  try {
    const scope = { orgId: "org-a", projectId: "project-a" };
    const doc = await files.uploadFile(
      f.ctx,
      f.member,
      scope,
      "note.txt",
      Buffer.from("original"),
    );
    const root = scopeRoot(f.ctx, scope);
    await fs.writeFile(path.join(root, "note.txt"), "native edit");
    await fs.rename(
      path.join(root, "note.txt"),
      path.join(root, "renamed.txt"),
    );
    await files.reconcileProjectFiles(f.ctx, "project-a");
    const current = (await files.listFiles(f.ctx, f.member, scope))[0];
    assert.equal(current.id, doc.id);
    assert.equal(current.name, "renamed.txt");
    assert.equal(
      (await files.readFileVersion(f.ctx, f.member, doc.id)).bytes.toString(),
      "native edit",
    );
    const secret = path.join(f.stateDir, "control", "outside.txt");
    await fs.writeFile(secret, "private");
    await fs.symlink(secret, path.join(root, "escape.txt"));
    await fs.symlink(path.dirname(secret), path.join(root, "escape-dir"));
    assert.equal((await files.listFiles(f.ctx, f.member, scope)).length, 1);
    await assert.rejects(
      files.uploadFile(
        f.ctx,
        f.member,
        scope,
        "escape-dir/outside.txt",
        Buffer.from("bad"),
      ),
      /links/u,
    );
    assert.equal(await fs.readFile(secret, "utf8"), "private");
    await fs.link(secret, path.join(root, "hard-link"));
    assert.equal((await files.listFiles(f.ctx, f.member, scope)).length, 1);
    await fs.unlink(path.join(root, "hard-link"));
    const folder = await files.createFolder(f.ctx, f.member, scope, "Delete");
    await fs.symlink(
      path.dirname(secret),
      path.join(root, "Delete", "nested-escape"),
    );
    await fs.writeFile(
      path.join(root, "Delete", ".wme-upload-abandoned"),
      "temporary",
    );
    await files.deleteFile(f.ctx, f.member, folder.id);
    assert.equal(await fs.readFile(secret, "utf8"), "private");
    for (const input of [
      "../outside",
      "/absolute",
      "a/../../b",
      "a\\b",
      "a//b",
      "a/./b",
      "x\0y",
    ])
      assert.throws(() => cleanPath(input));
    assert.equal(
      (
        await files.resolveProjectMounts(f.ctx, f.member, "project-a", "write")
      )[0].source,
      root,
    );
    assert.ok(!root.includes("/control/"));
  } finally {
    await f.dispose();
  }
});

test("version storage is bounded; native overflow is visible and old references survive", async () => {
  const f = await fixture();
  try {
    f.ctx.config.versionQuotaBytes = 5;
    const scope = { orgId: "org-a", projectId: "project-a" };
    const original = await files.uploadFile(
      f.ctx,
      f.member,
      scope,
      "file.txt",
      Buffer.from("first"),
    );
    await assert.rejects(
      files.uploadFile(
        f.ctx,
        f.member,
        scope,
        "file.txt",
        Buffer.from("other"),
      ),
      /version storage/u,
    );
    assert.equal(
      (
        await files.readFileVersion(f.ctx, f.member, original.id)
      ).bytes.toString(),
      "first",
    );
    await fs.writeFile(path.join(scopeRoot(f.ctx, scope), "file.txt"), "other");
    const changed = (await files.listFiles(f.ctx, f.member, scope))[0];
    assert.equal(changed.versionId, null);
    assert.match(changed.needsAttention!, /version storage/u);
    assert.equal(
      (
        await files.readFileVersion(f.ctx, f.member, original.id, {
          versionId: original.versionId!,
        })
      ).bytes.toString(),
      "first",
    );
    f.ctx.config.versionQuotaBytes = 10;
    const recovered = (await files.listFiles(f.ctx, f.member, scope))[0];
    assert.ok(recovered.versionId);
    assert.equal(
      (
        await files.readFileVersion(f.ctx, f.member, recovered.id)
      ).bytes.toString(),
      "other",
    );
  } finally {
    await f.dispose();
  }
});

test("cross-scope moves and copies check retained-version capacity before changing either tree", async () => {
  const f = await fixture();
  try {
    f.ctx.config.versionQuotaBytes = 5;
    const source = await files.uploadFile(
      f.ctx,
      f.member,
      { orgId: "org-a", projectId: "project-a" },
      "move.txt",
      Buffer.from("first"),
    );
    await files.uploadFile(
      f.ctx,
      f.admin,
      { orgId: "org-a" },
      "existing.txt",
      Buffer.from("four"),
    );
    for (const operation of ["move", "copy"] as const)
      await assert.rejects(
        files.transferFile(
          f.ctx,
          f.admin,
          source.id,
          { orgId: "org-a", path: "" },
          operation,
        ),
        /version storage/u,
      );
    assert.equal(
      (
        await files.readFileVersion(f.ctx, f.member, source.id)
      ).bytes.toString(),
      "first",
    );
    assert.deepEqual(
      (await files.listFiles(f.ctx, f.admin, { orgId: "org-a" })).map(
        (item) => item.name,
      ),
      ["existing.txt"],
    );
  } finally {
    await f.dispose();
  }
});

test("quotas and publication snapshots enforce actual bytes and preserve exact versions", async () => {
  const f = await fixture();
  try {
    f.ctx.config.maxFileBytes = 10;
    f.ctx.config.storageQuotaBytes = 15;
    const scope = { orgId: "org-a", projectId: "project-a" };
    await assert.rejects(
      files.uploadFile(f.ctx, f.member, scope, "large", Buffer.alloc(11)),
      /limit/u,
    );
    const first = await files.uploadFile(
      f.ctx,
      f.member,
      scope,
      "first",
      Buffer.from("1234567890"),
    );
    await assert.rejects(
      files.uploadFile(f.ctx, f.member, scope, "second", Buffer.alloc(6)),
      /allowance/u,
    );
    const snapshot = await files.snapshotFileTree(f.ctx, f.member, {
      fileId: first.id,
      versionId: first.versionId!,
    });
    assert.equal(snapshot.files[0].bytes.toString(), "1234567890");
    assert.equal(snapshot.files[0].versionId, first.versionId);
  } finally {
    await f.dispose();
  }
});

test(
  "Linux directory descriptors survive concurrent parent replacement without writing outside the grant",
  { skip: process.platform !== "linux" },
  async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "wme-fd-race-"));
    try {
      const root = path.join(state, "workspace"),
        outside = path.join(state, "control");
      await fs.mkdir(path.join(root, "folder"), { recursive: true });
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "file.txt"), "private");
      await withLeaf(root, "folder/file.txt", async (anchored) => {
        await fs.rename(
          path.join(root, "folder"),
          path.join(root, "original-folder"),
        );
        await fs.symlink(outside, path.join(root, "folder"));
        await fs.writeFile(anchored, "authorized");
      });
      assert.equal(
        await fs.readFile(path.join(outside, "file.txt"), "utf8"),
        "private",
      );
      assert.equal(
        await fs.readFile(
          path.join(root, "original-folder", "file.txt"),
          "utf8",
        ),
        "authorized",
      );
      await assert.rejects(readBytes(root, "folder/file.txt", 100), /links/u);
    } finally {
      await fs.rm(state, { recursive: true, force: true });
    }
  },
);

test(
  "Linux source reads fail closed while a competing agent swaps a directory for a symlink",
  { skip: process.platform !== "linux" },
  async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "wme-fd-read-race-"));
    try {
      const root = path.join(state, "workspace"),
        outside = path.join(state, "control");
      await fs.mkdir(path.join(root, "folder"), { recursive: true });
      await fs.mkdir(outside);
      await fs.writeFile(path.join(root, "folder", "file.txt"), "allowed");
      await fs.writeFile(path.join(outside, "file.txt"), "secret");
      const writer = (async () => {
        for (let i = 0; i < 100; i++) {
          await fs.rename(path.join(root, "folder"), path.join(root, "held"));
          await fs.symlink(outside, path.join(root, "folder"));
          await fs.unlink(path.join(root, "folder"));
          await fs.rename(path.join(root, "held"), path.join(root, "folder"));
        }
      })();
      const reader = (async () => {
        for (let i = 0; i < 200; i++) {
          try {
            assert.equal(
              (await readBytes(root, "folder/file.txt", 100)).toString(),
              "allowed",
            );
          } catch (error) {
            if (error instanceof assert.AssertionError) throw error;
            assert.ok(
              ["unsafe_path", "ENOENT"].includes(
                String((error as { code?: string }).code),
              ),
              String(error),
            );
          }
        }
      })();
      await Promise.all([writer, reader]);
      assert.equal(
        await fs.readFile(path.join(outside, "file.txt"), "utf8"),
        "secret",
      );
    } finally {
      await fs.rm(state, { recursive: true, force: true });
    }
  },
);

for (const operation of ["rename", "copy", "move"] as const) {
  test(`native moves out of a granted folder cannot retain ${operation} access`, async () => {
    const f = await fixture();
    try {
      const scope = { orgId: "org-a" };
      const folder = await files.createFolder(f.ctx, f.admin, scope, "Granted");
      const file = await files.uploadFile(
        f.ctx,
        f.admin,
        scope,
        "Granted/private.txt",
        Buffer.from("restricted"),
      );
      await files.createFolder(f.ctx, f.admin, scope, "Restricted");
      await files.grantFile(f.ctx, f.admin, folder.id, f.member.id, "write");
      const root = scopeRoot(f.ctx, scope);
      await fs.rename(
        path.join(root, "Granted/private.txt"),
        path.join(root, "Restricted/private.txt"),
      );
      await assert.rejects(
        operation === "rename"
          ? files.renameFile(f.ctx, f.member, file.id, "changed.txt")
          : files.transferFile(
              f.ctx,
              f.member,
              file.id,
              { orgId: "org-a", projectId: "project-a", path: "" },
              operation,
            ),
        { code: "file_access_denied" },
      );
      assert.equal(
        await fs.readFile(path.join(root, "Restricted/private.txt"), "utf8"),
        "restricted",
      );
      assert.equal(
        (
          await files.listFiles(f.ctx, f.member, {
            orgId: "org-a",
            projectId: "project-a",
          })
        ).length,
        0,
      );
    } finally {
      await f.dispose();
    }
  });
}

test("source reads reject a substituted FIFO without waiting for a writer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wme-fifo-read-"));
  const execute = promisify(execFile);
  try {
    await execute("mkfifo", [path.join(root, "file.txt")]);
    // Bound the child process: a blocking open must fail this test, not hang CI.
    await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      const { readBytes } = await import(process.argv[1]);
      await assert.rejects(readBytes(process.argv[2], "file.txt", 1024), { code: "unsafe_path" });
    `,
        new URL("../apps/api/src/files/paths.js", import.meta.url).href,
        root,
      ],
      {
        timeout: 3000,
        killSignal: "SIGKILL",
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
