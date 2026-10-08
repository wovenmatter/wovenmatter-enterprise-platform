import { constants } from "node:fs";
import { open, mkdir, type FileHandle } from "node:fs/promises";
import type { MountEvidence } from "./mount-evidence.js";
export function safeRelative(value: string) {
  if (
    !value ||
    value.length > 2048 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Invalid relative path");
  return value;
}
/** Every lookup, creation and ownership change is anchored to an open parent.
 * Returning descriptors (not paths) also closes the validation-to-bind race. */
export async function openDirectory(
  root: string,
  relative: string,
  create = false,
  owner?: number,
): Promise<FileHandle> {
  const parts = relative ? safeRelative(relative).split("/") : [];
  let handle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const part of parts) {
      const path = `/proc/self/fd/${handle.fd}/${part}`;
      if (create)
        try {
          await mkdir(path, {
            mode: 0o700,
          });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
      const next = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await handle.close();
      handle = next;
    }
    if (owner !== undefined) await handle.chown(owner, owner);
    return handle;
  } catch (e) {
    await handle.close();
    throw e;
  }
}
export async function openSource(
  root: string,
  relative: string,
): Promise<FileHandle> {
  if (!relative) return openDirectory(root, "");
  const parts = safeRelative(relative).split("/"),
    parent = await openDirectory(root, parts.slice(0, -1).join("/"));
  try {
    const handle = await open(
      `/proc/self/fd/${parent.fd}/${parts.at(-1)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (
      (!stat.isFile() && !stat.isDirectory()) ||
      (stat.isFile() && stat.nlink !== 1)
    ) {
      await handle.close();
      throw new Error("Invalid mount source");
    }
    return handle;
  } finally {
    await parent.close();
  }
}
export async function evidence(
  handle: FileHandle,
  target: string,
): Promise<MountEvidence> {
  const stat = await handle.stat({
    bigint: true,
  });
  return {
    target,
    device: String(stat.dev),
    inode: String(stat.ino),
    kind: stat.isDirectory() ? "directory" : "file",
  };
}
export type SandboxMount = {
  fd: number;
  target: string;
  access: "read" | "write";
};
export function sandboxArguments(
  mode: "read" | "write",
  mounts: SandboxMount[],
  sessionFd: number,
  homeFd: number,
  brokerFd: number,
) {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--unshare-user",
    "--uid",
    "10001",
    "--gid",
    "10001",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--setenv",
    "PATH",
    "/workspace/.tools/bin:/opt/document-tools/bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/home/agent",
    "--setenv",
    "LANG",
    "C.UTF-8",
  ];
  // Runtime-owned paths are overlaid LAST. A malicious share target symlink may
  // never replace the launcher, its libraries, the current session, or its broker.
  for (const m of mounts) {
    if (m.target !== "/workspace" && !/^\/workspace\/[^/\\]+$/.test(m.target))
      throw new Error("Invalid mount target");
    args.push(
      mode === "read" || m.access === "read" ? "--ro-bind" : "--bind",
      `/proc/self/fd/${m.fd}`,
      m.target,
    );
  }
  for (const p of ["/usr", "/bin", "/lib", "/lib64", "/opt", "/etc"])
    args.push("--ro-bind", p, p);
  args.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/home",
    "--bind",
    `/proc/self/fd/${sessionFd}`,
    "/session",
    "--bind",
    `/proc/self/fd/${homeFd}`,
    "/home/agent",
    "--ro-bind",
    `/proc/self/fd/${brokerFd}`,
    "/broker",
  );
  args.push(
    "--chdir",
    "/workspace",
    "--",
    "/usr/bin/aa-exec",
    "-p",
    "&wme-platform-agent",
    "--",
    "/usr/local/bin/wme-restrict",
    "/usr/local/bin/node",
    "/opt/runtime/src/entrypoint.js",
  );
  return args;
}
