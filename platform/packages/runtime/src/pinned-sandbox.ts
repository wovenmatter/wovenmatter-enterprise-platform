import { spawn } from "node:child_process";
import {
  mkdir,
  lstat,
  chmod,
  rmdir,
  unlink,
  open,
  type FileHandle,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
/** Pin already validated descriptors in the trusted outer mount namespace.
 * Bubblewrap intentionally makes its /proc/self/fd inaccessible after an
 * unprivileged user-namespace transition. These root-owned transient mountpoints
 * preserve the same inode identity without reopening any agent-controlled path.
 * They are never exposed in the agent's mount namespace. */
export async function pinSandbox(handles: FileHandle[]) {
  const base = "/tmp/wme-pinned";
  await mkdir(base, { mode: 0o711 }).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
  const parent = await lstat(base);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== 0 ||
    (parent.mode & 0o022) !== 0
  )
    throw new Error("Invalid trusted pin directory");
  // The daemon uses umask 077; explicitly permit only traversal by the
  // unprivileged launcher, never directory listing or creation.
  await chmod(base, 0o711);
  const root = join(base, randomUUID());
  await mkdir(root, { mode: 0o711 });
  await chmod(root, 0o711);
  const pins: { path: string; directory: boolean }[] = [];
  async function command(binary: string, args: string[], fd?: number) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, {
        stdio: ["ignore", "ignore", "pipe", ...(fd === undefined ? [] : [fd])],
        env: { PATH: "/usr/bin:/bin" },
      });
      child.stderr?.resume();
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error("Trusted mount preparation failed")),
      );
    });
  }
  async function close() {
    // Never recursively remove a directory whose mount removal is uncertain.
    let failed = false;
    for (const pin of [...pins].reverse())
      try {
        await command("/usr/bin/umount", [pin.path]);
        if (pin.directory) await rmdir(pin.path);
        else await unlink(pin.path);
      } catch {
        failed = true;
      }
    if (!failed) await rmdir(root);
  }
  try {
    for (const [i, handle] of handles.entries()) {
      const path = join(root, String(i)),
        directory = (await handle.stat()).isDirectory();
      if (directory) await mkdir(path, { mode: 0o711 });
      else {
        const f = await open(path, "wx", 0o600);
        await f.close();
      }
      // Never canonicalize the descriptor back to its mutable original path or
      // invoke a filesystem helper selected from untrusted mount metadata.
      await command(
        "/usr/bin/mount",
        ["-c", "-i", "--bind", "/proc/self/fd/3", path],
        handle.fd,
      );
      pins.push({ path, directory });
    }
    return { sources: pins.map((p) => p.path), close };
  } catch (e) {
    await close();
    throw e;
  }
}
