import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

// Deleted or moved sources must not survive as stale runnable code or tests.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
const result = spawnSync(process.execPath, [
  "node_modules/typescript/bin/tsc", "-p", "platform/tsconfig.json",
], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
