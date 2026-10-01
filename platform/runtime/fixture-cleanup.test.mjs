import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  realpath,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureCleanup } from "./fixture-cleanup.mjs";

async function fixture() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "wme-cleanup-test-")),
  );
  const prefix = `wme-accept-${process.pid}-${Date.now()}`;
  const root = await mkdtemp(join(parent, prefix));
  return { parent, prefix, root };
}

test("cleanup removes only its captured fixture and leaves siblings untouched", async () => {
  const { parent, prefix, root } = await fixture();
  try {
    await writeFile(join(parent, "keep"), "sibling");
    await mkdir(join(root, "sessions"));
    const cleanup = await createFixtureCleanup(root, prefix, {
      temporaryRoot: parent,
    });
    await cleanup();
    await assert.rejects(lstat(root), { code: "ENOENT" });
    assert.equal(await readFile(join(parent, "keep"), "utf8"), "sibling");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("permission fallback elevates only exact verified root with no shell", async () => {
  const { parent, prefix, root } = await fixture();
  const uid = process.getuid();
  try {
    let invoked = false;
    const cleanup = await createFixtureCleanup(root, prefix, {
      temporaryRoot: parent,
      platform: "linux",
      remove: async () => {
        throw Object.assign(new Error("private session"), { code: "EACCES" });
      },
      execute: async (command, args) => {
        invoked = true;
        assert.equal(command, "sudo");
        assert.deepEqual(args, [
          "-n",
          "--",
          "/bin/rm",
          "--recursive",
          "--force",
          "--one-file-system",
          "--",
          root,
        ]);
        await rm(root, { recursive: true, force: true });
      },
    });
    if (uid === 0) {
      await assert.rejects(cleanup(), { code: "EACCES" });
      assert.equal(invoked, false);
    } else {
      await cleanup();
      assert.equal(invoked, true);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("cleanup rejects traversal, a sibling prefix, and replaced root symlinks", async () => {
  const { parent, prefix, root } = await fixture();
  try {
    await assert.rejects(
      createFixtureCleanup(parent, prefix, { temporaryRoot: parent }),
      /Refusing/,
    );
    await assert.rejects(
      createFixtureCleanup(root, prefix + "9", { temporaryRoot: parent }),
      /Refusing/,
    );
    const cleanup = await createFixtureCleanup(root, prefix, {
      temporaryRoot: parent,
    });
    await rename(root, root + "-original");
    await mkdir(join(parent, "unrelated"));
    await writeFile(join(parent, "unrelated", "keep"), "safe");
    await symlink(join(parent, "unrelated"), root);
    await assert.rejects(cleanup(), /changed/);
    assert.equal(
      await readFile(join(parent, "unrelated", "keep"), "utf8"),
      "safe",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("cleanup preserves non-permission failures and reports failed elevation", async () => {
  const { parent, prefix, root } = await fixture();
  try {
    const denied = new Error("sudo failed");
    const cleanup = await createFixtureCleanup(root, prefix, {
      temporaryRoot: parent,
      remove: async () => {
        throw Object.assign(new Error("disk failure"), { code: "EIO" });
      },
      execute: async () => {
        throw denied;
      },
    });
    await assert.rejects(cleanup(), { code: "EIO" });
    if (process.getuid() !== 0) {
      const elevate = await createFixtureCleanup(root, prefix, {
        temporaryRoot: parent,
        platform: "linux",
        remove: async () => {
          throw Object.assign(new Error("private session"), { code: "EACCES" });
        },
        execute: async () => {
          throw denied;
        },
      });
      await assert.rejects(elevate(), (error) => error === denied);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
