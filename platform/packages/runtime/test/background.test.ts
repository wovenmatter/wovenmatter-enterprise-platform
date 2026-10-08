import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { backgroundCommand, backgroundService } from "../src/background.js";

test("a deliberately launched background process outlives its tool client, with a private ownership record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wme-background-")),
    socket = join(root, "control.sock"),
    result = join(root, "result");
  const service = await backgroundService(
    join(root, "jobs"),
    socket,
    { PATH: process.env.PATH ?? "" },
    root,
  );
  let pid: number | undefined;
  t.after(async () => {
    try {
      // Recover ownership even when the tool client fails before returning its receipt.
      const { jobs } = JSON.parse(
        await backgroundCommand(["list"], socket),
      ) as {
        jobs: { id: string; pid?: number }[];
      };
      for (const job of jobs) {
        if (!job.pid) continue;
        try {
          process.kill(-job.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      for (const job of jobs) {
        if (!job.pid) continue;
        const deadline = Date.now() + 5000;
        let observed = "no terminal ownership record";
        for (;;) {
          try {
            const record = JSON.parse(
              await readFile(join(root, "jobs", job.id + ".json"), "utf8"),
            );
            if (record.pid === job.pid && record.state === "leader_exited")
              break;
            observed = JSON.stringify(record);
          } catch (error) {
            if (
              !(error instanceof SyntaxError) &&
              (error as NodeJS.ErrnoException).code !== "ENOENT"
            )
              throw error;
            observed = String(error);
          }
          assert.ok(
            Date.now() < deadline,
            `Background job ${job.id} (${job.pid}) did not persist its exit: ${observed}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } finally {
      await new Promise<void>((resolve) => service.close(() => resolve()));
    }
    // Closing the listener alone does not drain the child's asynchronous exit writer.
    await rm(root, { recursive: true, force: true });
  });
  const module = new URL("../src/background.js", import.meta.url).href;
  const program = `import {backgroundCommand} from ${JSON.stringify(module)};process.stdout.write(await backgroundCommand(${JSON.stringify(["start", "--", process.execPath, "-e", "const fs=require('node:fs');let i=0;setInterval(()=>fs.writeFileSync(process.argv[1],String(++i)),20);", result])},${JSON.stringify(socket)}));`;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    program,
  ]);
  const { job } = JSON.parse(stdout);
  pid = job.pid;
  assert.equal(job.state, "running");
  let first = "";
  for (let i = 0; i < 100; i++) {
    try {
      first = await readFile(result, "utf8");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(first);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.notEqual(
    await readFile(result, "utf8"),
    first,
    "tool-client exit must not end background work",
  );
  const listed = JSON.parse(await backgroundCommand(["list"], socket));
  assert.equal(listed.jobs[0].pid, pid);
  assert.equal(
    JSON.parse(await readFile(join(root, "jobs", job.id + ".json"), "utf8"))
      .pid,
    pid,
  );
});
