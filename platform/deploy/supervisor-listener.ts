import { mkdir, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { connect, createServer } from "node:net";
import { createHash } from "node:crypto";
import type { Server } from "node:http";

/** Claim the supervisor socket before performing destructive runtime recovery. */
export async function listenSupervisor(
  server: Server,
  socketPath: string,
  initialize: () => Promise<void>,
): Promise<void> {
  // Linux abstract sockets are exclusive and disappear on process death. Hold
  // one across stale filesystem-socket cleanup so concurrent restarts cannot
  // unlink a newly bound peer's socket between probing and binding.
  const ownership =
    process.platform === "linux"
      ? createServer((socket) => socket.destroy())
      : undefined;
  if (ownership) {
    await new Promise<void>((resolve, reject) => {
      ownership.once("error", (error) =>
        reject(
          (error as NodeJS.ErrnoException).code === "EADDRINUSE"
            ? new Error("Another supervisor is already running")
            : error,
        ),
      );
      ownership.listen(
        "\0wme-supervisor-" +
          createHash("sha256").update(socketPath).digest("hex"),
        resolve,
      );
    });
  }
  const release = () => {
    if (ownership?.listening) ownership.close();
  };
  server.once("close", release);
  try {
    await listenOwnedSupervisor(server, socketPath, initialize);
  } catch (error) {
    release();
    throw error;
  }
}

async function listenOwnedSupervisor(
  server: Server,
  socketPath: string,
  initialize: () => Promise<void>,
): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 });
  try {
    const stat = await lstat(socketPath);
    if (!stat.isSocket()) throw new Error("Supervisor path is not a socket");
    const active = await new Promise<boolean>((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED")
          resolve(false);
        else reject(error);
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        reject(new Error("Supervisor socket check timed out"));
      });
    });
    if (active) throw new Error("Another supervisor is already running");
    const current = await lstat(socketPath);
    if (current.dev !== stat.dev || current.ino !== stat.ino)
      throw new Error("Supervisor socket changed during startup");
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(socketPath, () => {
      server.off("error", failed);
      resolve();
    });
  });
  try {
    await initialize();
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}
