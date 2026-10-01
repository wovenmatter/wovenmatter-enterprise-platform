import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  lstat,
  rename,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pinMountSources,
  verifyMountEvidence,
  type MountEvidence,
} from "../src/mount-evidence.ts";

test("trusted entrypoint detects a swapped source before any agent can execute", async () => {
  const root = await mkdtemp(join(tmpdir(), "wme-mount-gate-"));
  try {
    const source = join(root, "shared");
    await mkdir(source);
    await mkdir(join(root, "private"));
    const stat = await lstat(source, { bigint: true });
    const evidence: MountEvidence[] = [
      {
        target: source,
        device: String(stat.dev),
        inode: String(stat.ino),
        kind: "directory",
      },
    ];
    await verifyMountEvidence(evidence);
    await rename(source, join(root, "original"));
    await symlink(join(root, "private"), source);
    await assert.rejects(
      verifyMountEvidence(evidence),
      /changed during admission/,
    );
    await assert.rejects(verifyMountEvidence([]), /required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test(
  "Linux descriptor admission rejects symlink components and pins renamed inodes",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "wme-mount-pin-")));
    try {
      const source = join(root, "shared");
      await mkdir(source);
      await mkdir(join(root, "private"));
      const pin = await pinMountSources(
        [{ source, target: "/workspace/Shared" }],
        [root],
      );
      try {
        await rename(source, join(root, "original"));
        await symlink(join(root, "private"), source);
        const held = await lstat(join(root, "original"), { bigint: true });
        assert.equal(pin.evidence[0].inode, String(held.ino));
        await assert.rejects(
          pinMountSources([{ source, target: "/workspace/Shared" }], [root]),
        );
      } finally {
        await pin.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
