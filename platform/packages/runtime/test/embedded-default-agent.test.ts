import test from "node:test";
import assert from "node:assert/strict";
import { loadEmbeddedDefaultAgent } from "../src/embedded/default-agent.ts";

test("embedded WovenMatter default-agent runtime loads durable session entrypoint", async () => {
  const runtime = await loadEmbeddedDefaultAgent();
  assert.equal(
    runtime.sourceCommit,
    "5542b83ab2e11cc3c24037552883e2c6814bd596",
  );
  assert.equal(typeof runtime.openDurableSession, "function");
  assert.match(runtime.root, /default-agent$/);
});
