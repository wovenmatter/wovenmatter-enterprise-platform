#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, chmod, chown } from "node:fs/promises";
import { resolve, join } from "node:path";
// Deliberate operator action only. Never invoked by application startup.
const root = resolve(process.argv[2] ?? "");
if (
  !process.argv[2] ||
  root === "/" ||
  root.includes(",") ||
  /[\r\n]/.test(root)
)
  throw new Error("Pass a dedicated absolute candidate directory");
if (process.getuid?.() !== 0)
  throw new Error(
    "Run on the Linux Docker host as root to set container ownership",
  );
for (const name of [
  "state",
  "state/workspaces",
  "state/agent-sessions",
  "state/library",
  "private",
  "private/inference",
  "private/runtime-journal",
  "run",
  "backups",
]) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (name.startsWith("state")) await chown(directory, 10001, 10001);
  if (name === "run") {
    await chown(directory, 0, 10001);
    await chmod(directory, 0o750);
  }
}
await writeFile(
  join(root, "private/supervisor-token"),
  randomBytes(32).toString("hex") + "\n",
  { flag: "wx", mode: 0o600 },
);
await chown(join(root, "private/supervisor-token"), 10001, 10001);
console.log(
  "Candidate directories and supervisor credential created. No account, provider, or production configuration was changed.",
);
