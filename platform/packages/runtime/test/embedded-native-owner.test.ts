import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { embeddedDefaultAgentRoot } from "../src/embedded/default-agent.ts";

test("embedded native store ownership uses the WovenMatter proper-lockfile owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-native-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = (await import(
    pathToFileURL(
      join(embeddedDefaultAgentRoot(), "src/native-owner.mjs"),
    ).href
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
