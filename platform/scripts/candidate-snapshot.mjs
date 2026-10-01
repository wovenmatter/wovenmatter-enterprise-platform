#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  chown,
  unlink,
} from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { checkDatabase } from "./sqlite-backup.mjs";
const execute = promisify(execFile);
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function quiescent(root) {
  const ids = (
    await execute("docker", ["ps", "-q"], { maxBuffer: 1024 * 1024 })
  ).stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const id of ids) {
    // The explicit offline snapshot tool may itself run in the supervisor image.
    if (
      /^[a-f0-9]{12,64}$/.test(process.env.HOSTNAME ?? "") &&
      id.startsWith(process.env.HOSTNAME)
    )
      continue;
    const result = JSON.parse(
      (
        await execute(
          "docker",
          ["inspect", "--format", "{{json .Mounts}}", id],
          { maxBuffer: 1024 * 1024 },
        )
      ).stdout,
    );
    if (
      result.some((m) => {
        const path = relative(root, m.Source);
        return path === "" || (!path.startsWith("..") && !isAbsolute(path));
      })
    )
      throw new Error(
        "Stop candidate services and applications before a full snapshot",
      );
  }
  // Native named mount roots can hide the host path from container .Mounts; fail closed.
  for (const label of ["com.wovenmatter.enterprise.runtime=true", "wme.kind=library"])
    if (
      (
        await execute("docker", ["ps", "-q", "--filter", `label=${label}`])
      ).stdout.trim()
    )
      throw new Error(
        "Stop native executions and live applications before a full snapshot",
      );
}
async function backup(root, destination) {
  await quiescent(root);
  checkDatabase(join(root, "state/control/platform.sqlite"));
  if (destination === root || destination.startsWith(root + "/"))
    throw new Error("Snapshot destination must lie outside candidate root");
  await mkdir(destination, { mode: 0o700 }); // EEXIST prevents replacing an existing snapshot.
  const archive = join(destination, "snapshot.tar.gz");
  await execute(
    "tar",
    ["--numeric-owner", "-czf", archive, "-C", root, "state", "private"],
    { timeout: 60 * 60_000, maxBuffer: 1024 * 1024 },
  );
  await chmod(archive, 0o600);
  await writeFile(
    join(destination, "manifest.json"),
    JSON.stringify(
      {
        format: 1,
        createdAt: new Date().toISOString(),
        sha256: await digest(archive),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Complete snapshot created. It contains customer data and credentials; encrypt before off-host storage.",
  );
}
async function restore(snapshot, root) {
  await quiescent(root);
  const manifest = JSON.parse(
    await readFile(join(snapshot, "manifest.json"), "utf8"),
  );
  const archive = join(snapshot, "snapshot.tar.gz");
  if (manifest.format !== 1 || manifest.sha256 !== (await digest(archive)))
    throw new Error("Snapshot manifest/hash validation failed");
  await mkdir(root, { mode: 0o700 }); // A new root only; never restore over existing state.
  const listing = (
    await execute("tar", ["-tzf", archive], { maxBuffer: 64 * 1024 * 1024 })
  ).stdout
    .split("\n")
    .filter(Boolean);
  if (
    !listing.length ||
    listing.some(
      (name) =>
        !["state/", "private/"].some((prefix) => name.startsWith(prefix)) ||
        name.split("/").includes("..") ||
        name.startsWith("/"),
    )
  )
    throw new Error("Snapshot contains unsafe paths");
  await execute("tar", ["--numeric-owner", "-xzf", archive, "-C", root], {
    timeout: 60 * 60_000,
    maxBuffer: 1024 * 1024,
  });
  checkDatabase(join(root, "state/control/platform.sqlite"));
  // Runtime socket and firewall attestation are host-boot state, not portable authority.
  await mkdir(join(root, "run"), { mode: 0o750 });
  await chown(join(root, "run"), 0, 10001);
  await unlink(join(root, "private/firewall-boot-id")).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  console.log(
    "Snapshot restored and SQLite validated. Reapply ownership/network/firewall configuration and use matching image revisions before startup.",
  );
}
try {
  if (process.getuid?.() !== 0)
    throw new Error("Run as root on the Linux Docker host (Node 24)");
  const [, , command, first, second] = process.argv;
  if (!first || !second || !["backup", "restore"].includes(command))
    throw new Error(
      "Usage: candidate-snapshot.mjs backup CANDIDATE_ROOT NEW_SNAPSHOT_DIRECTORY | restore SNAPSHOT_DIRECTORY NEW_CANDIDATE_ROOT",
    );
  for (const path of [first, second])
    if (resolve(path) === "/" || /[\r\n]/.test(path))
      throw new Error("Use dedicated absolute directories");
  if (command === "backup") await backup(resolve(first), resolve(second));
  else await restore(resolve(first), resolve(second));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
