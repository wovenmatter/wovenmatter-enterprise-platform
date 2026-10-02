import { createServer, connect } from "node:net";
import { readFile } from "node:fs/promises";
import { RuntimeError } from "./types.js";
export async function assertIsolation() {
  const status = await readFile("/proc/self/status", "utf8"),
    profile = await readFile("/proc/self/attr/current", "utf8");
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 10001 ||
    !/^NoNewPrivs:\s+1$/m.test(status) ||
    !/^Seccomp:\s+2$/m.test(status) ||
    !/^CapEff:\s+0+$/m.test(status) ||
    profile.trim() !== "wme-platform-agent//&wme-project-supervisor (enforce)"
  )
    throw new RuntimeError(
      "isolation_missing",
      "Required kernel isolation is missing.",
    );
}
export async function proxy(port: number, path: string) {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    const target = connect(path);
    sockets.add(socket);
    sockets.add(target);
    socket.on("error", () => target.destroy());
    target.on("error", () => socket.destroy());
    socket.on("close", () => {
      target.destroy();
      sockets.delete(socket);
    });
    target.on("close", () => {
      socket.destroy();
      sockets.delete(target);
    });
    socket.pipe(target).pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return () => {
    server.close();
    for (const socket of sockets) socket.destroy();
  };
}
