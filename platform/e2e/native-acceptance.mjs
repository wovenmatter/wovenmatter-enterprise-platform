// Run browser acceptance against installed native agents, then clean only its
// recorded disposable resources after Playwright has fully stopped the server.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanupNativeResources } from "./native-runtime.mjs";
const output = process.env.WME_E2E_OUTPUT;
if (!output || !process.env.WME_E2E_AGENT_IMAGE)
  throw Error("Set a fresh WME_E2E_OUTPUT and exact WME_E2E_AGENT_IMAGE");
try {
  await readFile(resolve(output, "native-allocation.json"));
  throw Error("Native acceptance needs a fresh evidence directory");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const args = process.argv.slice(2);
const child = spawn(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "platform/e2e/playwright.config.mjs",
    ...args,
  ],
  { stdio: "inherit", env: process.env },
);
try {
  const [code] = await once(child, "close");
  process.exitCode = code ?? 1;
} finally {
  const ledger = JSON.parse(
    await readFile(resolve(output, "native-allocation.json"), "utf8"),
  );
  if (!ledger.cleaned) await cleanupNativeResources(ledger, resolve(output));
}
