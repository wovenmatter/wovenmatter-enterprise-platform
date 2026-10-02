import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Job = {
  id: string;
  pid?: number;
  command: string[];
  state: "running" | "leader_exited" | "interrupted";
  code?: number | null;
};
/** Lives in the existing thread namespace, outside a native tool's process group. */
export async function backgroundService(
  directory: string,
  socketPath: string,
  environment: Record<string, string>,
  cwd = "/workspace",
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const jobs = new Map<string, Job>();
  const save = (job: Job) =>
    writeFile(join(directory, job.id + ".json"), JSON.stringify(job), {
      mode: 0o600,
    });
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const job = JSON.parse(
      await readFile(join(directory, name), "utf8"),
    ) as Job;
    // PIDs from an earlier namespace are never reused as authority or automatically restarted.
    if (job.state !== "interrupted") {
      job.state = "interrupted";
      delete job.pid;
      await save(job);
    }
  }
  let lane = Promise.resolve();
  const server = createServer((socket) => {
    let input = "";
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.length > 65536) {
        socket.destroy();
        return;
      }
      const end = input.indexOf("\n");
      if (end < 0) return;
      socket.pause();
      lane = lane
        .then(async () => {
          const request = JSON.parse(input.slice(0, end));
          if (request.operation === "list") {
            socket.end(JSON.stringify({ jobs: [...jobs.values()] }) + "\n");
            return;
          }
          if (
            request.operation !== "start" ||
            !Array.isArray(request.command) ||
            !request.command.length ||
            request.command.length > 128 ||
            request.command.some(
              (v: unknown) => typeof v !== "string" || v.includes("\0"),
            )
          )
            throw new Error("Invalid background command");
          if (jobs.size >= 64)
            throw new Error(
              "Thread background capacity reached; stop the thread before starting more work",
            );
          const job: Job = {
            id: randomUUID(),
            command: request.command,
            state: "interrupted",
          };
          await save(job); // An ambiguous launch is never replayed after interruption.
          const child = spawn(job.command[0]!, job.command.slice(1), {
            cwd,
            env: environment,
            detached: true,
            stdio: "ignore",
          });
          await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
          });
          job.pid = child.pid;
          job.state = "running";
          jobs.set(job.id, job);
          child.once("exit", (code) => {
            job.state = "leader_exited";
            job.code = code;
            void save(job).catch(() => {});
          });
          await save(job);
          child.unref();
          socket.end(JSON.stringify({ job }) + "\n");
        })
        .catch((error) => {
          socket.end(
            JSON.stringify({
              error:
                error instanceof Error
                  ? error.message
                  : "Background launch failed",
            }) + "\n",
          );
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

export async function backgroundCommand(
  args: string[],
  socketPath = "/tmp/wme-background.sock",
) {
  const operation = args.shift();
  if (args[0] === "--") args.shift();
  if (operation !== "list" && operation !== "start")
    throw new Error("Usage: wme-background start -- COMMAND [ARGS...] | list");
  return new Promise<string>((resolve, reject) => {
    const socket = connect(socketPath);
    let result = "";
    socket.setTimeout(10000, () =>
      socket.destroy(
        new Error(
          "Background request outcome is uncertain; inspect the thread before retrying",
        ),
      ),
    );
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(JSON.stringify({ operation, command: args }) + "\n"),
    );
    socket.on("data", (chunk) => {
      result += chunk;
      if (result.length > 1024 * 1024)
        socket.destroy(new Error("Background response too large"));
    });
    socket.on("end", () => {
      try {
        const data = JSON.parse(result);
        if (data.error) reject(new Error(data.error));
        else resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
