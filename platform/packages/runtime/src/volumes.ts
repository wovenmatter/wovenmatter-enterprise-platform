import { createHash } from "node:crypto";
import { relative, resolve, isAbsolute } from "node:path";
import { realpath, lstat } from "node:fs/promises";
import { RuntimeError } from "./types.ts";
import { isWithin } from "./validation.ts";

export type DockerCommand = (
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;
export function storageVolumeName(root: string): string {
  return (
    "wme-storage-" +
    createHash("sha256").update(resolve(root)).digest("hex").slice(0, 32)
  );
}

/** Root must be an administrator-controlled mount root, never an agent-editable directory. */
export async function ensureStorageVolumes(
  roots: string[],
  docker: DockerCommand,
): Promise<void> {
  for (const root of [...new Set(roots)]) {
    if (
      !isAbsolute(root) ||
      /[,\r\n\x00]/.test(root) ||
      (await realpath(root)) !== resolve(root) ||
      !(await lstat(root)).isDirectory()
    )
      throw new RuntimeError(
        "invalid_storage_root",
        "Storage root must be a canonical managed directory",
      );
    const name = storageVolumeName(root);
    // Create is idempotent, but an existing volume with different options is not acceptable.
    await docker([
      "volume",
      "create",
      "--driver",
      "local",
      "--opt",
      "type=none",
      "--opt",
      "o=bind",
      "--opt",
      "device=" + root,
      "--label",
      "com.wovenmatter.enterprise.storage=true",
      name,
    ]);
    const result = await docker(["volume", "inspect", name]);
    const value = JSON.parse(result.stdout)?.[0];
    if (
      value?.Driver !== "local" ||
      value?.Options?.device !== root ||
      value?.Options?.type !== "none" ||
      value?.Options?.o !== "bind"
    )
      throw new RuntimeError(
        "invalid_storage_volume",
        "Existing storage volume does not match its managed root",
      );
  }
}

/**
 * Do not replace with a bind source + realpath check: mutable nested source paths
 * can be swapped after validation. Docker's volume-subpath invokes safepath.Join,
 * opens without following symlinks and pins the validated inode via a temporary bind.
 * See moby/daemon/volume/safepath/join_linux.go. Requires Docker 26+ on Linux.
 */
export function volumeMount(
  source: string,
  target: string,
  roots: string[],
  readOnly: boolean,
): string {
  if (
    !isAbsolute(source) ||
    /[\x00-\x1f\x7f]/.test(source) ||
    !target.startsWith("/") ||
    /[\x00-\x1f\x7f]/.test(target)
  )
    throw new RuntimeError("invalid_mount", "Invalid managed volume mount");
  const root = [...roots]
    .sort((a, b) => b.length - a.length)
    .find((root) => isWithin(resolve(root), resolve(source)));
  if (!root)
    throw new RuntimeError(
      "invalid_mount",
      "Mount source is outside managed storage",
    );
  const subpath = relative(resolve(root), resolve(source)) || ".";
  // Docker parses --mount as CSV, not shell syntax. Quote complete fields so
  // commas/quotes in ordinary filenames cannot become mount options.
  const csv = (field: string) =>
    /[,"\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
  return [
    "type=volume",
    `src=${storageVolumeName(root)}`,
    `dst=${target}`,
    `volume-subpath=${subpath}`,
    "volume-nocopy",
    ...(readOnly ? ["readonly"] : []),
  ]
    .map(csv)
    .join(",");
}
