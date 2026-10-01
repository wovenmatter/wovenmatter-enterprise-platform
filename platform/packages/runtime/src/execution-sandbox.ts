import type { FileHandle } from "node:fs/promises";
import {
  openDirectory,
  openSource,
  evidence,
  sandboxArguments,
  type SandboxMount,
} from "./sandbox.js";
import { pinSandbox } from "./pinned-sandbox.js";
/** Called only by the trusted project daemon; never exposed to agent code. */
export async function prepareSandbox(
  relative: string,
  mode: "read" | "write",
  shares: { source: string; target: string; access: "read" | "write" }[],
  broker: string,
) {
  const handles: FileHandle[] = [];
  const add = (h: FileHandle) => {
    handles.push(h);
    return handles.length + 2;
  };
  try {
    const session = await openDirectory("/state", relative, true, 10001),
      sessionFd = add(session);
    // Home lookup stays below the held session descriptor even during rename races.
    const home = await openDirectory(
        `/proc/self/fd/${session.fd}/.`,
        "home",
        true,
        10001,
      ),
      homeFd = add(home);
    const brokerFd = add(await openDirectory(broker, ""));
    const workspace = await openDirectory("/project", "files"),
      mounts: SandboxMount[] = [
        { fd: add(workspace), target: "/workspace", access: mode },
      ];
    const attestations = [
      await evidence(workspace, "/workspace"),
      await evidence(session, "/session"),
      await evidence(home, "/home/agent"),
    ];
    for (const share of shares.filter((m) => m.target !== "/workspace")) {
      if (!share.source.startsWith("/library/"))
        throw new Error("Invalid share source");
      const source = await openSource("/library", share.source.slice(9));
      mounts.push({
        fd: add(source),
        target: share.target,
        access: share.access,
      });
      attestations.push(await evidence(source, share.target));
    }
    const pinned = await pinSandbox(handles);
    const args = sandboxArguments(
      mode,
      mounts,
      sessionFd,
      homeFd,
      brokerFd,
    ).map((arg) => {
      const fd = /^\/proc\/self\/fd\/(\d+)$/.exec(arg);
      return fd ? pinned.sources[Number(fd[1]) - 3] : arg;
    });
    return {
      args,
      fds: [] as number[],
      attestations,
      close: async () => {
        try {
          await pinned.close();
        } finally {
          await Promise.all(handles.map((h) => h.close()));
        }
      },
    };
  } catch (e) {
    await Promise.all(handles.map((h) => h.close()));
    throw e;
  }
}
