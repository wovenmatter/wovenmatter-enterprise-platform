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

test("ordinary settings cannot self-authorize an Enterprise provider ID", async () => {
  const runtime = await loadEmbeddedDefaultAgent();
  const { validateConfig } = await import(new URL("src/config.mjs", `file://${runtime.root}/`).href);
  const id = "local-server-11111111-1111-4111-8111-111111111111";
  const config = { providers: [id], enterpriseProviderIds: [id] };
  assert.deepEqual(validateConfig(config).providers, []);
  assert.deepEqual(validateConfig(config, [id]).providers, [id]);
});
