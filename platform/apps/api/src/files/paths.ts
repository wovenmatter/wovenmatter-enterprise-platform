import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import { AppError } from "../context.js";
import type { AppContext } from "../context.js";
import type { Scope } from "./types.js";

export const MAX_DEPTH = 32;
export const MAX_ENTRIES = 20_000;
export const DEFAULT_MAX_FILE = 64 * 1024 * 1024;
export function maxFileBytes(ctx: AppContext): number {
  return Number(ctx.config.maxFileBytes ?? DEFAULT_MAX_FILE);
}
export function quotaBytes(ctx: AppContext): number {
  return Number(ctx.config.storageQuotaBytes ?? 10 * 1024 ** 3);
}
export function cleanPath(value: unknown, allowEmpty = true): string {
  if (typeof value !== "string")
    throw new AppError(400, "invalid_path", "A file path is required.");
  if (value === "" && allowEmpty) return "";
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/u.test(value) ||
    Buffer.byteLength(value) > 2048
  )
    throw new AppError(
      400,
      "invalid_path",
      "Use a relative path without special characters.",
    );
  const parts = value.split("/");
  if (
    parts.length > MAX_DEPTH ||
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        p.startsWith(".wme-upload-") ||
        Buffer.byteLength(p) > 240,
    )
  )
    throw new AppError(
      400,
      "invalid_path",
      "The file path contains an invalid name.",
    );
  return parts.join("/");
}
export function cleanName(value: unknown): string {
  const name = cleanPath(value, false);
  if (name.includes("/"))
    throw new AppError(
      400,
      "invalid_name",
      "Choose a single file or folder name.",
    );
  return name;
}
export function scopeKey(scope: Scope): string {
  return scope.projectId ? `project:${scope.projectId}` : `org:${scope.orgId}`;
}
export function scopeRoot(ctx: AppContext, scope: Scope): string {
  const id = scope.projectId || scope.orgId;
  if (!/^[a-zA-Z0-9_-]+$/u.test(id))
    throw new AppError(400, "invalid_scope", "Invalid workspace identifier.");
  return path.join(
    ctx.config.stateDir,
    "workspaces",
    scope.projectId ? "projects" : "organizations",
    id,
    "files",
  );
}
export async function ensureRoot(
  ctx: AppContext,
  scope: Scope,
): Promise<string> {
  const root = scopeRoot(ctx, scope);
  await fs.mkdir(root, { recursive: true, mode: 0o750 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AppError(
      409,
      "unsafe_path",
      "The workspace directory is unavailable.",
    );
  return root;
}

/** Linux uses directory descriptors for every segment: concurrent agent renames or
 * symlink replacements cannot redirect API operations outside an opened directory.
 * The portable path is for development only; deployed runtimes must use Linux. */
export async function withLeaf<T>(
  root: string,
  relative: string,
  operation: (leaf: string) => Promise<T>,
): Promise<T> {
  cleanPath(relative);
  const handles: FileHandle[] = [];
  try {
    if (process.platform === "linux") {
      let handle = await fs.open(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(handle);
      const parts = relative ? relative.split("/") : [];
      for (const part of parts.slice(0, -1)) {
        handle = await fs.open(
          `/proc/self/fd/${handle.fd}/${part}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        handles.push(handle);
      }
      return await operation(
        parts.length
          ? `/proc/self/fd/${handle.fd}/${parts.at(-1)!}`
          : `/proc/self/fd/${handle.fd}/.`,
      );
    }
    let candidate = root;
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink())
      throw new AppError(
        409,
        "unsafe_path",
        "Symbolic links cannot be accessed.",
      );
    for (const part of relative.split("/").filter(Boolean).slice(0, -1)) {
      candidate = path.join(candidate, part);
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new AppError(
          409,
          "unsafe_path",
          "Symbolic links cannot be accessed.",
        );
    }
    return await operation(path.join(root, relative));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR")
      throw new AppError(
        409,
        "unsafe_path",
        "Symbolic links cannot be accessed.",
      );
    throw error;
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

export async function safeStat(
  root: string,
  relative: string,
): Promise<import("node:fs").Stats> {
  return withLeaf(root, relative, async (leaf) => {
    const stat = await fs.lstat(leaf);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new AppError(
        409,
        "unsafe_path",
        "Only ordinary files and folders are supported.",
      );
    if (stat.isFile() && stat.nlink > 1)
      throw new AppError(
        409,
        "unsafe_path",
        "Hard-linked files cannot be accessed.",
      );
    return stat;
  });
}
export async function readBytes(
  root: string,
  relative: string,
  limit: number,
): Promise<Buffer> {
  return withLeaf(root, relative, async (leaf) => {
    const handle = await fs.open(
      leaf,
      // A native agent can replace the final entry with a FIFO after lstat.
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1)
        throw new AppError(
          409,
          "unsafe_path",
          "Only ordinary files are supported.",
        );
      if (stat.size > limit)
        throw new AppError(
          413,
          "file_too_large",
          "This file exceeds the supported size.",
        );
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        const buffer = Buffer.allocUnsafe(
          Math.min(64 * 1024, limit + 1 - size),
        );
        const result = await handle.read(buffer, 0, buffer.length, null);
        if (!result.bytesRead) break;
        size += result.bytesRead;
        if (size > limit)
          throw new AppError(
            413,
            "file_too_large",
            "This file exceeds the supported size.",
          );
        chunks.push(buffer.subarray(0, result.bytesRead));
      }
      return Buffer.concat(chunks, size);
    } finally {
      await handle.close();
    }
  });
}
export async function removeTree(
  root: string,
  relative: string,
): Promise<void> {
  cleanPath(relative, false);
  async function removeEntry(leaf: string): Promise<void> {
    const stat = await fs.lstat(leaf);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await fs.unlink(leaf);
      return;
    }
    if (process.platform === "linux") {
      const directory = await fs.open(
        leaf,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const anchored = `/proc/self/fd/${directory.fd}/.`;
        for (const name of await fs.readdir(anchored))
          await removeEntry(`${anchored}/${name}`);
      } finally {
        await directory.close();
      }
      // A replaced final name is never followed recursively. rmdir can remove
      // only an empty directory at this exact entry.
      await fs.rmdir(leaf);
    } else {
      // Only local development runs on this path; Linux isolates untrusted agents.
      for (const name of await fs.readdir(leaf))
        await removeEntry(path.join(leaf, name));
      await fs.rmdir(leaf);
    }
  }
  await withLeaf(root, relative, removeEntry);
}
export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
