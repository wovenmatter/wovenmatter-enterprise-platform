import { constants } from "node:fs";
import { open, lstat, type FileHandle } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { isWithin } from "./validation.ts";
import { RuntimeError } from "./types.ts";

export interface MountEvidence {
  target: string;
  device: string;
  inode: string;
  kind: "file" | "directory";
}
export interface PinnedMounts {
  evidence: MountEvidence[];
  close(): Promise<void>;
}

/** Open each component against its already-open parent, never a mutable absolute path. */
export async function pinMountSources(
  mounts: { source: string; target: string }[],
  roots: string[],
): Promise<PinnedMounts> {
  if (process.platform !== "linux")
    throw new RuntimeError(
      "linux_required",
      "Secure mount admission requires Linux",
    );
  const retained: FileHandle[] = [],
    evidence: MountEvidence[] = [];
  try {
    for (const mount of mounts) {
      const root = [...roots]
        .sort((a, b) => b.length - a.length)
        .find((r) => isWithin(resolve(r), resolve(mount.source)));
      if (!root)
        throw new RuntimeError(
          "invalid_mount",
          "Mount is outside managed storage",
        );
      let handle = await open(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const components = relative(root, mount.source)
          .split("/")
          .filter(Boolean);
        for (let i = 0; i < components.length; i++) {
          const flags =
            constants.O_RDONLY |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK |
            (i < components.length - 1 ? constants.O_DIRECTORY : 0);
          const next = await open(
            `/proc/self/fd/${handle.fd}/${components[i]}`,
            flags,
          );
          await handle.close();
          handle = next;
        }
        const stat = await handle.stat({ bigint: true });
        if (
          (!stat.isDirectory() && !stat.isFile()) ||
          (stat.isFile() && stat.nlink !== 1n)
        )
          throw new RuntimeError(
            "invalid_mount",
            "Only ordinary directories and files may be mounted",
          );
        evidence.push({
          target: mount.target,
          device: String(stat.dev),
          inode: String(stat.ino),
          kind: stat.isDirectory() ? "directory" : "file",
        });
        retained.push(handle);
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
    return {
      evidence,
      async close() {
        await Promise.all(retained.map((file) => file.close()));
      },
    };
  } catch (error) {
    await Promise.all(retained.map((file) => file.close()));
    throw error;
  }
}

/** Must run in trusted image code before any user code, native harness or resource loader. */
export async function verifyMountEvidence(
  evidence: MountEvidence[],
): Promise<void> {
  if (!Array.isArray(evidence) || !evidence.length || evidence.length > 130)
    throw new RuntimeError(
      "mount_attestation_missing",
      "Mount admission evidence is required",
    );
  const seen = new Set<string>();
  for (const entry of evidence) {
    if (
      !entry ||
      typeof entry.target !== "string" ||
      !entry.target.startsWith("/") ||
      seen.has(entry.target) ||
      !/^\d+$/.test(entry.device) ||
      !/^\d+$/.test(entry.inode)
    )
      throw new RuntimeError(
        "mount_attestation_invalid",
        "Invalid mount admission evidence",
      );
    seen.add(entry.target);
    const actual = await lstat(entry.target, { bigint: true });
    if (
      String(actual.dev) !== entry.device ||
      String(actual.ino) !== entry.inode ||
      (entry.kind === "directory"
        ? !actual.isDirectory()
        : entry.kind === "file"
          ? !actual.isFile()
          : true)
    )
      throw new RuntimeError(
        "mount_changed",
        "A workspace source changed during admission; no agent work was started",
      );
  }
}
