import { execFile } from "node:child_process";
import { lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

/** Capture the identity of this invocation's mkdtemp fixture, before containers run. */
export async function createFixtureCleanup(root, prefix, options = {}) {
  const {
    temporaryRoot = tmpdir(),
    uid = process.getuid(),
    platform = process.platform,
    remove = rm,
    execute = promisify(execFile),
  } = options;
  const parent = await realpath(temporaryRoot);
  const target = await realpath(root);
  if (
    !/^wme-accept-\d+-\d+$/.test(prefix) ||
    dirname(target) !== parent ||
    !new RegExp(`^${prefix}[A-Za-z0-9]{6}$`).test(basename(target)) ||
    (await lstat(root)).isSymbolicLink()
  ) {
    throw new Error("Refusing cleanup outside the exact acceptance fixture");
  }
  const original = await lstat(target);
  if (!original.isDirectory() || original.uid !== uid) {
    throw new Error("Acceptance fixture must be owned by the invoking user");
  }
  async function verifyIdentity() {
    const current = await lstat(target);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.uid !== uid ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      (await realpath(target)) !== resolve(target)
    ) {
      throw new Error("Acceptance fixture changed before cleanup");
    }
  }
  return async () => {
    await verifyIdentity();
    try {
      await remove(target, { recursive: true, force: true });
    } catch (error) {
      if (
        platform !== "linux" ||
        uid === 0 ||
        !["EACCES", "EPERM"].includes(error.code)
      ) {
        throw error;
      }
      // UID 10001 owns private native-session directories. Preserve those modes;
      // only elevate removal of this verified, disposable fixture after Docker cleanup.
      await verifyIdentity();
      await execute(
        "sudo",
        [
          "-n",
          "--",
          "/bin/rm",
          "--recursive",
          "--force",
          "--one-file-system",
          "--",
          target,
        ],
        { timeout: 15000, maxBuffer: 1024 * 1024 },
      );
    }
    try {
      await lstat(target);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    throw new Error("Acceptance fixture cleanup did not remove its directory");
  };
}
