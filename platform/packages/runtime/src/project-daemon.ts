/** Trusted PID 1 service. Agent code only runs below bubblewrap + AppArmor + seccomp. */
import { createServer as netServer, connect, type Socket } from "node:net";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  chmod,
  chown,
  readFile,
  readdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { identity, MAX_LINE } from "./validation.js";
import { safeRelative } from "./sandbox.js";
import { prepareSandbox } from "./execution-sandbox.js";
import { RuntimeError, type RuntimeRequest } from "./types.js";
import { WorkspaceService } from "./workspace-service.js";
import { launchWorkspaceWorker } from "./workspace-worker.js";
import {
  trackSandboxProcess,
  terminateSandboxProcess,
} from "./process-control.js";
process.umask(0o077);
const definition = JSON.parse(
  await readFile("/control/definition.json", "utf8"),
) as {
  projectId: string;
  organizationId: string;
};
identity(definition.projectId);
identity(definition.organizationId);
let stopping = false;
async function relay(
  directoryPath: string,
  request: Pick<RuntimeRequest, "egressProxyUrl"> & {
    gateway?: RuntimeRequest["gateway"];
  },
) {
  await mkdir(directoryPath, {
    recursive: true,
    mode: 0o750,
  });
  await chown(directoryPath, 0, 10001);
  await chmod(directoryPath, 0o750);
  const sockets = new Set<Socket>();
  const gateway = request.gateway
    ? new URL(request.gateway.baseUrl)
    : undefined;
  const token = request.gateway?.token;
  const server = gateway
    ? httpServer(
        {
          requestTimeout: 120000,
          maxHeaderSize: 32768,
        },
        (req, res) => {
          const path = req.url ?? "";
          if (
            !path.startsWith(gateway.pathname + "/") ||
            path.includes("..") ||
            path.includes("%") ||
            req.headers.authorization !== `Bearer ${token}`
          ) {
            res.writeHead(403);
            res.end();
            return;
          }
          const upstream = (
            gateway.protocol === "https:" ? httpsRequest : httpRequest
          )(
            new URL(path, gateway.origin),
            {
              method: req.method,
              headers: {
                "content-type": String(
                  req.headers["content-type"] ?? "application/json",
                ),
                authorization: `Bearer ${token}`,
              },
            },
            (reply) => {
              res.writeHead(reply.statusCode ?? 502, {
                "content-type": String(
                  reply.headers["content-type"] ?? "application/json",
                ),
              });
              reply.pipe(res);
            },
          );
          let size = 0;
          req.on("data", (chunk) => {
            size += chunk.length;
            if (size > 16 * 1024 * 1024) upstream.destroy();
          });
          upstream.on("error", () => {
            if (!res.headersSent) res.writeHead(502);
            res.end();
          });
          req.pipe(upstream);
          res.on("close", () => upstream.destroy());
        },
      )
    : undefined;
  server?.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  if (server) {
    const endpoint = join(directoryPath, "gateway.sock");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    await chmod(endpoint, 0o660);
    await chown(endpoint, 0, 10001);
  }
  let egress: ReturnType<typeof netServer> | undefined;
  if (request.egressProxyUrl) {
    const origin = new URL(request.egressProxyUrl);
    egress = netServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      const upstream = connect({
        host: origin.hostname,
        port: Number(origin.port),
      });
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    const endpoint = join(directoryPath, "egress.sock");
    await new Promise<void>((resolve, reject) => {
      egress!.once("error", reject);
      egress!.listen(endpoint, resolve);
    });
    await chmod(endpoint, 0o660);
    await chown(endpoint, 0, 10001);
  }
  return () => {
    server?.close();
    egress?.close();
    for (const socket of sockets) socket.destroy();
  };
}
const workspace = new WorkspaceService(
  "/control/workspace-journal",
  launchWorkspaceWorker,
);
await workspace.initialize();
await mkdir("/control/brokers", {
  recursive: true,
  mode: 0o750,
});
await rm("/control/runtime.sock", {
  force: true,
});
const server = netServer({ allowHalfOpen: true }, (socket) => {
  let pending = Buffer.alloc(0);
  const receive = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_LINE) {
      socket.destroy();
      return;
    }
    const end = pending.indexOf(10);
    if (end < 0) return;
    socket.off("data", receive);
    socket.pause();
    void (async () => {
      const envelope = JSON.parse(pending.subarray(0, end).toString());
      let result: unknown = { ok: true };
      if (envelope.operation === "cancel")
        await workspace.cancel(identity(envelope.runId));
      else if (envelope.operation === "execute") {
        if (
          envelope.request.projectId !== definition.projectId ||
          envelope.request.organizationId !== definition.organizationId
        )
          throw new Error("Project identity mismatch");
        await workspace.admit(envelope.request);
      } else if (envelope.operation === "attach")
        result = await workspace.attach(identity(envelope.runId));
      else if (envelope.operation === "poll")
        result = await workspace.poll(
          identity(envelope.runId),
          envelope.after,
          envelope.waitMs,
        );
      else if (envelope.operation === "acknowledge")
        await workspace.acknowledge(identity(envelope.runId), envelope.cursor);
      else if (envelope.operation === "steer")
        await workspace.steer(
          identity(envelope.runId),
          envelope.attachment,
          envelope.input,
        );
      else if (envelope.operation === "stop-session")
        await workspace.stopSession(
          identity(envelope.conversationId),
          envelope.generation,
        );
      else if (envelope.operation === "policy") await refreshPolicy();
      else if (envelope.operation === "status")
        result = { ready: true, ...workspace.status() };
      else throw new Error("Unsupported operation");
      socket.end(JSON.stringify(result) + "\n");
    })().catch((error) => {
      socket.end(
        JSON.stringify({
          type: "failed",
          code: error instanceof RuntimeError ? error.code : "runtime_boundary",
          message: "The project runtime rejected execution.",
        }) + "\n",
      );
    });
  };
  socket.on("data", receive);
  socket.on("error", () => {});
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen("/control/runtime.sock", resolve);
});
await chmod("/control/runtime.sock", 0o600);

// Scheduling is deliberately a workspace file contract, never a platform UI.
// A persisted receipt prevents replay after an uncertain crash. No provider credential
// is available to unattended scripts. Only full sessions can write definitions.
const scheduled = new Map<
  string,
  { child: ChildProcess; revoke: () => void }
>();
type SchedulePolicy = {
  enabled: boolean;
  mounts: {
    source: string;
    target: string;
    access: "read" | "write";
  }[];
};
let policy: SchedulePolicy = {
    enabled: false,
    mounts: [],
  },
  policyText = "",
  policyEpoch = 0,
  policyLane = Promise.resolve();
function refreshPolicy() {
  const operation = policyLane
    .catch(() => {})
    .then(async () => {
      let text: string;
      try {
        text = await readFile("/control/schedule-policy.json", "utf8");
      } catch {
        text = JSON.stringify({
          enabled: false,
          mounts: [],
        });
      }
      if (text === policyText) return;
      const next = JSON.parse(text) as SchedulePolicy;
      if (!Array.isArray(next.mounts) || next.mounts.length > 500)
        throw new Error("Invalid schedule policy");
      policy = next;
      policyEpoch++;
      await Promise.all(
        [...scheduled.values()].map(async ({ child, revoke }) => {
          // Withdraw network authority even if process termination cannot be confirmed.
          revoke();
          const stopped = once(child, "close");
          let timeout: NodeJS.Timeout | undefined;
          try {
            await terminateSandboxProcess(child);
            await Promise.race([
              stopped,
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      new RuntimeError(
                        "stop_not_confirmed",
                        "Scheduled process stop was not confirmed.",
                      ),
                    ),
                  10000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timeout);
          }
        }),
      );
      policyText = text; // A failed stop must be retried even when the policy file is unchanged.
    });
  policyLane = operation;
  return operation;
}
async function readSafe(relative: string) {
  safeRelative(relative);
  const handles = [];
  try {
    let dir = await open(
      "/project/files",
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    handles.push(dir);
    const parts = relative.split("/");
    for (const part of parts.slice(0, -1)) {
      dir = await open(
        `/proc/self/fd/${dir.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(dir);
    }
    const file = await open(
      `/proc/self/fd/${dir.fd}/${parts.at(-1)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    handles.push(file);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384) throw new Error("Schedule limit");
    return await file.readFile("utf8");
  } finally {
    await Promise.all(handles.map((h) => h.close()));
  }
}
let scheduling = false;
async function schedules() {
  if (stopping || scheduling) return;
  scheduling = true;
  try {
    await refreshPolicy();
    if (!policy.enabled) return;
    let names: string[];
    try {
      names = await readdir("/project/files/.wme/schedules");
    } catch {
      return;
    }
    for (const name of names.slice(0, 100)) {
      if (!/^[a-z0-9_-]{1,64}\.json$/.test(name) || scheduled.has(name))
        continue;
      try {
        const epoch = policyEpoch,
          shares = policy.mounts;
        const config = JSON.parse(await readSafe(`.wme/schedules/${name}`));
        const interval = Number(config.everyMinutes);
        if (
          !Number.isSafeInteger(interval) ||
          interval < 1 ||
          interval > 43200 ||
          !Array.isArray(config.args ?? []) ||
          (config.args ?? []).some(
            (v: unknown) => typeof v !== "string" || v.length > 4000,
          )
        )
          continue;
        const script = safeRelative(config.script);
        if (!script.endsWith(".sh")) continue;
        await readSafe(script);
        const receipt = join("/state/scheduled", name);
        await mkdir(posix.dirname(receipt), {
          recursive: true,
          mode: 0o700,
        });
        let last = 0;
        try {
          last = Number(await readFile(receipt, "utf8"));
        } catch {}
        if (Date.now() - last < interval * 60000) continue;
        const temporary = receipt + ".tmp";
        const f = await open(temporary, "w", 0o600);
        await f.writeFile(String(Date.now()));
        await f.sync();
        await f.close();
        await rename(temporary, receipt);
        const receiptDir = await open(posix.dirname(receipt), "r");
        try {
          await receiptDir.sync();
        } finally {
          await receiptDir.close();
        }
        const session = join(
          "schedule-sessions",
          createHash("sha256").update(name).digest("hex"),
        );
        const broker = join(
          "/control/brokers",
          `schedule-${createHash("sha256").update(name).digest("hex")}`,
        );
        const current = JSON.parse(
          await readFile("/control/definition.json", "utf8"),
        );
        const closeRelay = await relay(broker, {
          egressProxyUrl: current.egressProxyUrl,
        });
        try {
          const sandbox = await prepareSandbox(
            session,
            "write",
            shares,
            broker,
          );
          if (epoch !== policyEpoch || !policy.enabled) {
            await sandbox.close();
            closeRelay();
            continue;
          }
          const args = sandbox.args;
          args[args.length - 1] = "/opt/runtime/src/schedule-entrypoint.js";
          const child = spawn("bwrap", args, {
            uid: 10001,
            gid: 10001,
            stdio: ["pipe", "ignore", "ignore", ...sandbox.fds],
            env: {
              PATH: "/usr/bin:/bin:/usr/local/bin",
            },
          });
          trackSandboxProcess(child);
          const close = () => {
            void sandbox.close();
            closeRelay();
            scheduled.delete(name);
            void rm(broker, {
              recursive: true,
              force: true,
            });
          };
          child.once("close", close);
          child.once("error", () => {});
          scheduled.set(name, { child, revoke: closeRelay });
          child.stdin!.on("error", () => {
            closeRelay();
            void terminateSandboxProcess(child).catch(() => {});
          });
          child.stdin!.end(
            JSON.stringify({
              projectId: definition.projectId,
              script,
              args: config.args ?? [],
              mountEvidence: sandbox.attestations,
              ...(current.egressProxyUrl
                ? {
                    egressToken: current.egressToken,
                  }
                : {}),
            }),
          );
        } catch (e) {
          closeRelay();
          throw e;
        }
      } catch {
        /* Invalid or unavailable definitions fail closed; corrected files are re-read. */
      }
    }
  } finally {
    scheduling = false;
  }
}
const timer = setInterval(() => void schedules().catch(() => {}), 30000);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopping = true;
    clearInterval(timer);
    void workspace.close();
    for (const { child, revoke } of scheduled.values()) {
      revoke();
      void terminateSandboxProcess(child).catch(() => {});
    }
    server.close(() => process.exit(0));
  });
