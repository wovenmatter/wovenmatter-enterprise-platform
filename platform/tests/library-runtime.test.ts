import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  symlink,
  rm,
  lstat,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDirectory,
  openSource,
  sandboxArguments,
} from "../packages/runtime/src/sandbox.js";
test("trusted session setup rejects a prior-run home symlink without changing its target ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wme-session-boundary-"));
  t.after(() =>
    rm(root, {
      recursive: true,
      force: true,
    }),
  );
  await mkdir(join(root, "session"));
  await mkdir(join(root, "control"));
  const before = await lstat(join(root, "control"));
  await symlink(join(root, "control"), join(root, "session", "home"));
  await assert.rejects(openDirectory(root, "session/home", true, 10001));
  const after = await lstat(join(root, "control"));
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
});
test("held directory descriptor pins ownership and reads through adversarial pathname replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wme-session-pin-"));
  t.after(() =>
    rm(root, {
      recursive: true,
      force: true,
    }),
  );
  await mkdir(join(root, "home"));
  await mkdir(join(root, "control"));
  await writeFile(join(root, "home", "own"), "safe");
  const controlMode = (await lstat(join(root, "control"))).mode & 0o777;
  const handle = await openDirectory(root, "home");
  try {
    await rename(join(root, "home"), join(root, "original"));
    await symlink(join(root, "control"), join(root, "home"));
    await handle.chmod(0o750);
    assert.equal(
      (await lstat(join(root, "control"))).mode & 0o777,
      controlMode,
    );
    assert.equal((await lstat(join(root, "original"))).mode & 0o777, 0o750);
  } finally {
    await handle.close();
  }
});
test("share source descriptors reject ancestor and leaf symlinks and retain opened files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wme-share-pin-"));
  t.after(() =>
    rm(root, {
      recursive: true,
      force: true,
    }),
  );
  await mkdir(join(root, "folder"));
  await writeFile(join(root, "folder", "file"), "safe");
  await symlink(join(root, "folder"), join(root, "alias"));
  await symlink(join(root, "folder", "file"), join(root, "leaf"));
  await assert.rejects(openSource(root, "alias/file"));
  await assert.rejects(openSource(root, "leaf"));
  const handle = await openSource(root, "folder/file");
  try {
    await rename(join(root, "folder", "file"), join(root, "old"));
    await writeFile(join(root, "folder", "file"), "changed");
    assert.equal(await handle.readFile("utf8"), "safe");
  } finally {
    await handle.close();
  }
});
test("sandbox mounts private state after user targets, isolates PID/net and leaves readonly shares readonly", () => {
  const args = sandboxArguments(
    "write",
    [
      {
        fd: 3,
        target: "/workspace",
        access: "write",
      },
      {
        fd: 4,
        target: "/workspace/reference",
        access: "read",
      },
    ],
    5,
    6,
    7,
  );
  assert.ok(
    args.includes("--unshare-pid") &&
      args.includes("--unshare-net") &&
      args.includes("--unshare-user"),
  );
  const source = args.indexOf("/proc/self/fd/4");
  assert.equal(args[source - 1], "--ro-bind");
  assert.ok(args.indexOf("/session") > args.indexOf("/workspace/reference"));
  assert.ok(
    args.indexOf("wme-platform-agent") <
      args.indexOf("/usr/local/bin/wme-restrict"),
  );
  const ro = sandboxArguments(
    "read",
    [
      {
        fd: 3,
        target: "/workspace",
        access: "write",
      },
    ],
    5,
    6,
    7,
  );
  assert.equal(ro[ro.indexOf("/proc/self/fd/3") - 1], "--ro-bind");
});
