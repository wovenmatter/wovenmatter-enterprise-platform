import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AppError, type AppContext, type User } from "../context.js";
import {
  type Access,
  type FileRecord,
  type FileRow,
  type Scope,
  type ShareRow,
} from "./types.js";
import {
  cleanName,
  cleanPath,
  ensureRoot,
  isMissing,
  MAX_ENTRIES,
  maxFileBytes,
  quotaBytes,
  readBytes,
  removeTree,
  safeStat,
  scopeKey,
  withLeaf,
} from "./paths.js";
import { locked, now, underneath, sourceRow, reconcile } from "./storage.js";
import { validateScope, orgAccess, authorizeFile, resolveLocation } from "./access.js";

function record(
  row: FileRow,
  access: Access,
  share?: ShareRow & { sourcePath: string },
): FileRecord {
  const visiblePath = share
    ? `${share.name}${row.path.slice(share.sourcePath.length)}`
    : row.path;
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: share?.project_id ?? row.project_id,
    name: path.posix.basename(visiblePath),
    path: visiblePath,
    kind: row.kind,
    size: row.size,
    updatedAt: row.updated_at,
    access,
    versionId: row.version_id,
    ...(row.kind === "file" && !row.version_id
      ? {
          needsAttention:
            "This file exceeds the supported size or the workspace version storage allowance.",
        }
      : {}),
    ...(share
      ? {
          sharedFrom: {
            fileId: share.file_id,
            orgId: row.org_id,
            path: row.path,
            access: share.access,
          },
        }
      : {}),
  };
}

export async function listFiles(
  ctx: AppContext,
  user: User,
  scope: Scope,
  relative = "",
): Promise<FileRecord[]> {
  return locked(ctx, async () => {
    cleanPath(relative);
    await validateScope(ctx, user, scope);
    await reconcile(ctx, scope);
    if (scope.projectId) await reconcile(ctx, { orgId: scope.orgId });
    const location = await resolveLocation(ctx, user, scope, relative);
    const all = await ctx.db.all<FileRow>(
      "SELECT * FROM workspace_files WHERE scope_key=? AND deleted_at IS NULL ORDER BY kind DESC,path",
      [scopeKey(location.scope)],
    );
    const results: FileRecord[] = [];
    for (const row of all) {
      const parent =
        path.posix.dirname(row.path) === "."
          ? ""
          : path.posix.dirname(row.path);
      if (parent !== location.path) continue;
      let access: Access | undefined = location.access;
      if (!scope.projectId) {
        access = await orgAccess(ctx, user, row);
        if (!access && row.kind === "folder") {
          const descendants = all.filter((child) =>
            underneath(child.path, row.path),
          );
          for (const child of descendants)
            if (await orgAccess(ctx, user, child)) {
              access = "read";
              break;
            }
        }
      }
      if (access) results.push(record(row, access, location.share));
    }
    if (scope.projectId && !relative) {
      const shares = await ctx.db.all<ShareRow>(
        "SELECT * FROM workspace_file_shares WHERE project_id=?",
        [scope.projectId],
      );
      for (const share of shares) {
        const source = await ctx.db.get<FileRow>(
          "SELECT * FROM workspace_files WHERE id=? AND deleted_at IS NULL",
          [share.file_id],
        );
        if (source)
          results.push(
            record(
              source,
              location.access === "write" && share.access === "write"
                ? "write"
                : "read",
              { ...share, sourcePath: source.path },
            ),
          );
      }
    }
    return results.sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name)
        : a.kind === "folder"
          ? -1
          : 1,
    );
  });
}

async function mkdirParents(root: string, relative: string): Promise<void> {
  let current = "";
  for (const part of relative.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    try {
      await withLeaf(root, current, (leaf) => fs.mkdir(leaf, { mode: 0o750 }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await safeStat(root, current);
      if (!stat.isDirectory())
        throw new AppError(
          409,
          "name_conflict",
          "A file already uses this folder name.",
        );
    }
  }
}
async function ensureRoom(
  ctx: AppContext,
  scope: Scope,
  added: number,
  addedEntries = 1,
): Promise<void> {
  const usage = await ctx.db.get<{ size: number; count: number }>(
    "SELECT COALESCE(SUM(size),0) AS size,COUNT(*) AS count FROM workspace_files WHERE scope_key=? AND deleted_at IS NULL",
    [scopeKey(scope)],
  );
  if (Number(usage?.size ?? 0) + added > quotaBytes(ctx))
    throw new AppError(
      413,
      "storage_quota",
      "This workspace has reached its storage allowance.",
    );
  if (Number(usage?.count ?? 0) + addedEntries > MAX_ENTRIES)
    throw new AppError(
      413,
      "too_many_files",
      "This workspace has reached its file limit.",
    );
}
async function missingPathEntries(
  ctx: AppContext,
  scope: Scope,
  relative: string,
): Promise<number> {
  if (!relative || relative === ".") return 0;
  const parts = relative.split("/");
  const paths = parts.map((_part, index) =>
    parts.slice(0, index + 1).join("/"),
  );
  const existing = await ctx.db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM workspace_files WHERE scope_key=? AND deleted_at IS NULL AND path IN (${paths.map(() => "?").join(",")})`,
    [scopeKey(scope), ...paths],
  );
  return paths.length - Number(existing?.count ?? 0);
}
export async function createFolder(
  ctx: AppContext,
  user: User,
  scope: Scope,
  relative: string,
): Promise<FileRecord> {
  return locked(ctx, async () => {
    cleanPath(relative, false);
    await validateScope(ctx, user, scope, true);
    await reconcile(ctx, scope);
    const location = await resolveLocation(ctx, user, scope, relative, true);
    const root = await ensureRoot(ctx, location.scope);
    await ensureRoom(
      ctx,
      location.scope,
      0,
      await missingPathEntries(ctx, location.scope, location.path),
    );
    await mkdirParents(root, location.path);
    await reconcile(ctx, location.scope);
    const row = await ctx.db.get<FileRow>(
      "SELECT * FROM workspace_files WHERE scope_key=? AND path=? AND deleted_at IS NULL",
      [scopeKey(location.scope), location.path],
    );
    await ctx.audit(user, "files.folder_created", row!.id);
    return record(row!, location.access, location.share);
  });
}
export async function uploadFile(
  ctx: AppContext,
  user: User,
  scope: Scope,
  relative: string,
  bytes: Buffer,
): Promise<FileRecord> {
  return locked(ctx, async () => {
    cleanPath(relative, false);
    if (bytes.length > maxFileBytes(ctx))
      throw new AppError(
        413,
        "file_too_large",
        "This file exceeds the upload limit.",
      );
    await validateScope(ctx, user, scope, true);
    await reconcile(ctx, scope);
    if (scope.projectId) await reconcile(ctx, { orgId: scope.orgId });
    const location = await resolveLocation(ctx, user, scope, relative, true);
    const root = await ensureRoot(ctx, location.scope);
    let oldSize = 0;
    try {
      const stat = await safeStat(root, location.path);
      if (!stat.isFile())
        throw new AppError(
          409,
          "name_conflict",
          "A folder already uses this name.",
        );
      oldSize = stat.size;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await ensureRoom(
      ctx,
      location.scope,
      Math.max(0, bytes.length - oldSize),
      await missingPathEntries(ctx, location.scope, location.path),
    );
    const old = await ctx.db.get<FileRow>(
      "SELECT * FROM workspace_files WHERE scope_key=? AND path=? AND deleted_at IS NULL",
      [scopeKey(location.scope), location.path],
    );
    if (createHash("sha256").update(bytes).digest("hex") !== old?.hash) {
      const archiveUsage = await ctx.db.get<{ size: number }>(
        `SELECT COALESCE(SUM(v.size),0) AS size FROM workspace_file_versions v JOIN workspace_files f ON f.id=v.file_id WHERE f.scope_key=?`,
        [scopeKey(location.scope)],
      );
      if (
        Number(archiveUsage?.size ?? 0) + bytes.length >
        Number(ctx.config.versionQuotaBytes ?? quotaBytes(ctx))
      )
        throw new AppError(
          413,
          "version_quota",
          "This workspace has reached its version storage allowance.",
        );
    }
    const parent = path.posix.dirname(location.path);
    if (parent !== ".") await mkdirParents(root, parent);
    await withLeaf(root, location.path, async (leaf) => {
      const temporary = path.join(
        path.dirname(leaf),
        `.wme-upload-${randomUUID()}`,
      );
      try {
        const handle = await fs.open(temporary, "wx", 0o640);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, leaf);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    await reconcile(ctx, location.scope);
    const row = await ctx.db.get<FileRow>(
      "SELECT * FROM workspace_files WHERE scope_key=? AND path=? AND deleted_at IS NULL",
      [scopeKey(location.scope), location.path],
    );
    await ctx.audit(user, "files.uploaded", row!.id, { bytes: bytes.length });
    return record(row!, location.access, location.share);
  });
}
export async function readFileVersion(
  ctx: AppContext,
  user: User,
  id: string,
  options: { projectId?: string; versionId?: string } = {},
): Promise<{ bytes: Buffer; name: string; versionId: string; size: number }> {
  return locked(ctx, async () => {
    let authorized = await authorizeFile(
      ctx,
      user,
      id,
      options.projectId,
      false,
      Boolean(options.versionId),
    );
    if (!authorized.row.deleted_at && !options.versionId) {
      await reconcile(ctx, authorized.scope);
      authorized = await authorizeFile(
        ctx,
        user,
        id,
        options.projectId,
        false,
        Boolean(options.versionId),
      );
    }
    if (authorized.row.kind !== "file")
      throw new AppError(400, "not_a_file", "Select a file to download.");
    const versionId = options.versionId ?? authorized.row.version_id;
    if (!versionId)
      throw new AppError(
        413,
        "file_unavailable",
        "This file exceeds the supported size or the workspace version storage allowance.",
      );
    const version = await ctx.db.get<{
      id: string;
      hash: string;
      name: string;
      size: number;
    }>("SELECT * FROM workspace_file_versions WHERE id=? AND file_id=?", [
      versionId,
      id,
    ]);
    if (!version)
      throw new AppError(404, "version_not_found", "File version not found.");
    const bytes = await fs.readFile(
      path.join(ctx.config.stateDir, "file-versions", version.hash),
    );
    return {
      bytes,
      name: options.versionId
        ? version.name
        : path.posix.basename(authorized.row.path),
      versionId: version.id,
      size: version.size,
    };
  });
}
export async function fileVersions(
  ctx: AppContext,
  user: User,
  id: string,
  projectId?: string,
) {
  const authorized = await authorizeFile(ctx, user, id, projectId, false, true);
  if (!authorized.row.deleted_at)
    await locked(ctx, () => reconcile(ctx, authorized.scope));
  await authorizeFile(ctx, user, id, projectId, false, true);
  return ctx.db.all<{
    id: string;
    size: number;
    name: string;
    createdAt: string;
  }>(
    "SELECT id,size,name,created_at AS createdAt FROM workspace_file_versions WHERE file_id=? ORDER BY created_at DESC",
    [id],
  );
}
export async function renameFile(
  ctx: AppContext,
  user: User,
  id: string,
  name: string,
  projectId?: string,
): Promise<FileRecord> {
  return locked(ctx, async () => {
    cleanName(name);
    let auth = await authorizeFile(ctx, user, id, projectId, true);
    await reconcile(ctx, auth.scope);
    // Native moves can change inherited grants and project shares.
    auth = await authorizeFile(ctx, user, id, projectId, true);
    const row = auth.row;
    if (auth.share?.file_id === id)
      throw new AppError(
        409,
        "shared_root",
        "Rename the shared source in organization files.",
      );
    const parent = path.posix.dirname(row.path);
    const destination = parent === "." ? name : `${parent}/${name}`;
    const root = await ensureRoot(ctx, auth.scope);
    try {
      await safeStat(root, destination);
      throw new AppError(
        409,
        "name_conflict",
        "A file or folder already uses this name.",
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await withLeaf(root, row.path, (source) =>
      withLeaf(root, destination, (target) => fs.rename(source, target)),
    );
    await reconcile(ctx, auth.scope);
    const updated = await sourceRow(ctx, id);
    await ctx.audit(user, "files.renamed", id);
    return record(
      updated,
      auth.access,
      auth.share
        ? {
            ...auth.share,
            sourcePath: (await sourceRow(ctx, auth.share.file_id)).path,
          }
        : undefined,
    );
  });
}
export async function deleteFile(
  ctx: AppContext,
  user: User,
  id: string,
  projectId?: string,
): Promise<void> {
  return locked(ctx, async () => {
    const auth = await authorizeFile(ctx, user, id, projectId, true);
    const root = await ensureRoot(ctx, auth.scope);
    await safeStat(root, auth.row.path);
    await removeTree(root, auth.row.path);
    await reconcile(ctx, auth.scope);
    await ctx.audit(user, "files.deleted", id);
  });
}
export async function transferFile(
  ctx: AppContext,
  user: User,
  id: string,
  destination: Scope & { path: string },
  operation: "copy" | "move",
  projectId?: string,
): Promise<FileRecord> {
  return locked(ctx, async () => {
    if (!["copy", "move"].includes(operation))
      throw new AppError(400, "invalid_operation", "Choose copy or move.");
    cleanPath(destination.path);
    let auth = await authorizeFile(
      ctx,
      user,
      id,
      projectId,
      operation === "move",
    );
    if (destination.orgId !== auth.row.org_id)
      throw new AppError(
        403,
        "cross_organization",
        "Files cannot be transferred between organizations.",
      );
    await validateScope(ctx, user, destination, true);
    await reconcile(ctx, auth.scope);
    await reconcile(ctx, destination);
    auth = await authorizeFile(ctx, user, id, projectId, operation === "move");
    const source = auth.row;
    const targetPath = destination.path
      ? `${destination.path}/${path.posix.basename(source.path)}`
      : path.posix.basename(source.path);
    const location = await resolveLocation(
      ctx,
      user,
      destination,
      targetPath,
      true,
    );
    const sourceRoot = await ensureRoot(ctx, auth.scope);
    const targetRoot = await ensureRoot(ctx, location.scope);
    if (
      scopeKey(auth.scope) === scopeKey(location.scope) &&
      underneath(location.path, source.path)
    )
      throw new AppError(
        400,
        "recursive_transfer",
        "A folder cannot be transferred into itself.",
      );
    try {
      await safeStat(targetRoot, location.path);
      throw new AppError(
        409,
        "name_conflict",
        "A file or folder already uses this name.",
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const rows = (
      await ctx.db.all<FileRow>(
        "SELECT * FROM workspace_files WHERE scope_key=? AND deleted_at IS NULL",
        [scopeKey(auth.scope)],
      )
    ).filter((row) => underneath(row.path, source.path));
    const total = rows.reduce((sum, row) => sum + row.size, 0);
    const sameScope = scopeKey(auth.scope) === scopeKey(location.scope);
    await ensureRoom(
      ctx,
      location.scope,
      operation === "move" && sameScope ? 0 : total,
      (operation === "move" && sameScope ? 0 : rows.length) +
        (await missingPathEntries(
          ctx,
          location.scope,
          path.posix.dirname(location.path),
        )),
    );
    let allowedCopyBytes = quotaBytes(ctx);
    if (operation === "copy" || !sameScope) {
      const archiveUsage = await ctx.db.get<{ size: number }>(
        `SELECT COALESCE(SUM(v.size),0) AS size FROM workspace_file_versions v JOIN workspace_files f ON f.id=v.file_id WHERE f.scope_key=?`,
        [scopeKey(location.scope)],
      );
      const movedHistory =
        operation === "move"
          ? await ctx.db.get<{ size: number }>(
              `SELECT COALESCE(SUM(v.size),0) AS size FROM workspace_file_versions v JOIN workspace_files f ON f.id=v.file_id WHERE f.scope_key=? AND (f.path=? OR substr(f.path,1,?)=?)`,
              [
                scopeKey(auth.scope),
                source.path,
                source.path.length + 1,
                `${source.path}/`,
              ],
            )
          : undefined;
      const needed =
        operation === "move" ? Number(movedHistory?.size ?? 0) : total;
      const archiveRoom =
        Number(ctx.config.versionQuotaBytes ?? quotaBytes(ctx)) -
        Number(archiveUsage?.size ?? 0);
      if (needed > archiveRoom)
        throw new AppError(
          413,
          "version_quota",
          "This workspace has reached its version storage allowance.",
        );
      const currentUsage = await ctx.db.get<{ size: number }>(
        "SELECT COALESCE(SUM(size),0) AS size FROM workspace_files WHERE scope_key=? AND deleted_at IS NULL",
        [scopeKey(location.scope)],
      );
      allowedCopyBytes = Math.min(
        archiveRoom,
        quotaBytes(ctx) - Number(currentUsage?.size ?? 0),
      );
    }
    const parent = path.posix.dirname(location.path);
    if (parent !== ".") await mkdirParents(targetRoot, parent);
    if (operation === "move") {
      await withLeaf(sourceRoot, source.path, (from) =>
        withLeaf(targetRoot, location.path, (to) => fs.rename(from, to)),
      );
      await ctx.db.batch(
        rows.map((row) => ({
          sql: "UPDATE workspace_files SET scope_key=?,org_id=?,project_id=?,path=?,updated_at=? WHERE id=?",
          params: [
            scopeKey(location.scope),
            location.scope.orgId,
            location.scope.projectId ?? null,
            location.path + row.path.slice(source.path.length),
            now(),
            row.id,
          ],
        })),
      );
      if (location.scope.projectId)
        for (const row of rows)
          await ctx.db.batch([
            {
              sql: "DELETE FROM workspace_file_shares WHERE file_id=?",
              params: [row.id],
            },
            {
              sql: "DELETE FROM workspace_file_grants WHERE file_id=?",
              params: [row.id],
            },
          ]);
    } else {
      // Never stage a directory tree in an agent-writable mount: a concurrent
      // process could replace a staging parent with a symlink between writes.
      // All workspace roots and the private staging root live on the state volume.
      await withLeaf(targetRoot, location.path, async (target) => {
        const temporary = path.join(
          ctx.config.stateDir,
          "file-staging",
          randomUUID(),
        );
        try {
          if (source.kind === "folder")
            await fs.mkdir(temporary, { mode: 0o750 });
          let copiedBytes = 0;
          for (const row of rows.sort(
            (a, b) => a.path.length - b.path.length,
          )) {
            const suffix = row.path.slice(source.path.length);
            const target = temporary + suffix;
            if (row.kind === "folder") {
              if (suffix) await fs.mkdir(target, { mode: 0o750 });
            } else {
              const bytes = await readBytes(
                sourceRoot,
                row.path,
                maxFileBytes(ctx),
              );
              copiedBytes += bytes.length;
              if (copiedBytes > allowedCopyBytes)
                throw new AppError(
                  413,
                  "storage_quota",
                  "The copied files exceed the workspace storage allowance.",
                );
              await fs.writeFile(target, bytes, { flag: "wx", mode: 0o640 });
            }
          }
          await fs.rename(temporary, target);
        } catch (error) {
          await fs.rm(temporary, { recursive: true, force: true });
          throw error;
        }
      });
    }
    await reconcile(ctx, auth.scope);
    await reconcile(ctx, location.scope);
    const result = await ctx.db.get<FileRow>(
      "SELECT * FROM workspace_files WHERE scope_key=? AND path=? AND deleted_at IS NULL",
      [scopeKey(location.scope), location.path],
    );
    await ctx.audit(user, `files.${operation}`, id, {
      destinationId: result!.id,
    });
    return record(result!, location.access, location.share);
  });
}

export async function snapshotFileTree(
  ctx: AppContext,
  user: User,
  options: { fileId: string; versionId?: string; projectId?: string },
): Promise<{
  files: { path: string; bytes: Buffer; versionId: string }[];
  sourceVersionId: string;
  orgId: string;
  projectId: string | null;
}> {
  const auth = await authorizeFile(
    ctx,
    user,
    options.fileId,
    options.projectId,
  );
  if (auth.row.kind === "file") {
    const file = await readFileVersion(ctx, user, auth.row.id, options);
    return {
      files: [
        { path: file.name, bytes: file.bytes, versionId: file.versionId },
      ],
      sourceVersionId: file.versionId,
      orgId: auth.row.org_id,
      projectId: auth.row.project_id,
    };
  }
  if (options.versionId)
    throw new AppError(
      400,
      "folder_version",
      "Folder snapshots do not accept a file version.",
    );
  await locked(ctx, () => reconcile(ctx, auth.scope));
  const all = await ctx.db.all<FileRow>(
    "SELECT * FROM workspace_files WHERE scope_key=? AND kind='file' AND deleted_at IS NULL ORDER BY path",
    [scopeKey(auth.scope)],
  );
  const files: { path: string; bytes: Buffer; versionId: string }[] = [];
  let size = 0;
  for (const row of all.filter((row) => underneath(row.path, auth.row.path))) {
    const file = await readFileVersion(ctx, user, row.id, {
      projectId: options.projectId,
      ...(row.version_id ? { versionId: row.version_id } : {}),
    });
    size += file.size;
    if (size > 256 * 1024 * 1024)
      throw new AppError(
        413,
        "snapshot_too_large",
        "This folder is too large to publish as one asset.",
      );
    files.push({
      path: row.path.slice(auth.row.path.length + 1),
      bytes: file.bytes,
      versionId: file.versionId,
    });
  }
  const sourceVersionId = createHash("sha256")
    .update(JSON.stringify(files.map((file) => [file.path, file.versionId])))
    .digest("hex");
  return {
    files,
    sourceVersionId,
    orgId: auth.row.org_id,
    projectId: auth.row.project_id,
  };
}

export { initializeFiles, reconcileProjectFiles } from "./storage.js";
export { authorizeFile, getDirectoryAccess } from "./access.js";
export {
  getShares,
  shareFile,
  revokeShare,
  getGrants,
  grantFile,
  revokeGrant,
  resolveProjectMounts,
  captureProjectManifest,
  resolveFileMount,
} from "./sharing.js";
