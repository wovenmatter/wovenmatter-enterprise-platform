import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { recoverPiStoreLocks } from "../src/native.ts";
import { embeddedDefaultAgentRoot } from "../src/embedded/default-agent.ts";

test("embedded native store ownership uses the WovenMatter proper-lockfile owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-native-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = (await import(
    pathToFileURL(join(embeddedDefaultAgentRoot(), "src/native-owner.mjs")).href
  )) as {
    ownNativeStore: (
      root: string,
      onCompromised?: (error: Error) => void,
    ) => Promise<() => Promise<void>>;
  };
  const release = await module.ownNativeStore(directory);
  await assert.rejects(() => module.ownNativeStore(directory));
  await release();
  const releaseAgain = await module.ownNativeStore(directory);
  await releaseAgain();
});

test(
  "new namespace recovers only empty Pi owner markers with pinned directory lookup",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "wme-owner-recovery-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await recoverPiStoreLocks(root); // A new session has no durable state yet.
    const directory = join(root, "pi-enterprise", "durable");
    await mkdir(directory, { recursive: true });
    const id = "b2000000-0000-0000-0000-000000000001";
    await mkdir(join(directory, id));
    await writeFile(join(directory, id, "record.jsonl"), "retained");
    await mkdir(join(directory, id + ".lock"));
    await mkdir(join(directory, "unrelated.lock"));
    await recoverPiStoreLocks(root);
    assert.deepEqual((await readdir(directory)).sort(), [id, "unrelated.lock"]);
    assert.equal(
      await readFile(join(directory, id, "record.jsonl"), "utf8"),
      "retained",
    );
    // Refuse populated markers and symlinks instead of recursively deleting data.
    await mkdir(join(directory, id + ".lock"));
    await writeFile(join(directory, id + ".lock", "unexpected"), "preserve");
    await assert.rejects(recoverPiStoreLocks(root));
    assert.equal(
      await readFile(join(directory, id + ".lock", "unexpected"), "utf8"),
      "preserve",
    );
    await rm(join(directory, id + ".lock"), { recursive: true });
    await symlink(join(directory, id), join(directory, id + ".lock"));
    await assert.rejects(recoverPiStoreLocks(root));
    const other = await mkdtemp(join(tmpdir(), "wme-owner-other-"));
    t.after(() => rm(other, { recursive: true, force: true }));
    await mkdir(join(other, "durable"));
    await rm(join(root, "pi-enterprise"), { recursive: true });
    await symlink(other, join(root, "pi-enterprise"));
    await assert.rejects(recoverPiStoreLocks(root));
  },
);
