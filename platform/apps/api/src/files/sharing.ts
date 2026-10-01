import * as fs from "node:fs/promises";
import path from "node:path";
import { AppError, type AppContext, type User } from "../context.js";
import {
  type Access,
  type FileRow,
  type RuntimeMount,
  type ShareRow,
} from "./types.js";
import {
  cleanName,
  ensureRoot,
  isMissing,
  safeStat,
  withLeaf,
} from "./paths.js";
import { locked, now, underneath, sourceRow, reconcile } from "./storage.js";
import { authorizeFile } from "./access.js";
export async function getShares(ctx: AppContext, user: User, id: string) {
  const row = await sourceRow(ctx, id);
  await ctx.requireLibraryFull(user, row.org_id);
  return ctx.db.all<{
    projectId: string;
    projectName: string;
    access: Access;
    name: string;
  }>(
    `SELECT s.project_id AS projectId,p.name AS projectName,s.access,s.name FROM workspace_file_shares s JOIN projects p ON p.id=s.project_id WHERE s.file_id=?`,
    [id],
  );
}
export async function shareFile(
  ctx: AppContext,
  user: User,
  id: string,
  projectId: string,
  access: Access,
  name?: string,
): Promise<void> {
  await locked(ctx, async () => {
    if (!["read", "write"].includes(access))
      throw new AppError(
        400,
        "invalid_access",
        "Choose read-only or full access.",
      );
    const row = await sourceRow(ctx, id);
    await ctx.requireLibraryFull(user, row.org_id);
    if (row.project_id)
      throw new AppError(
        400,
        "share_direction",
        "Only organization files can be shared with a project.",
      );
    const project = await ctx.db.get<{
      org_id: string;
    }>(
      "SELECT org_id FROM projects WHERE id=? AND status NOT IN ('deleted','deleting','purged')",
      [projectId],
    );
    if (!project || project.org_id !== row.org_id)
      throw new AppError(
        403,
        "cross_organization",
        "Files cannot be shared between organizations.",
      );
    const alias = cleanName(name ?? path.posix.basename(row.path));
    const root = await ensureRoot(ctx, {
      orgId: row.org_id,
      projectId,
    });
    const previous = await ctx.db.get<ShareRow>(
      "SELECT * FROM workspace_file_shares WHERE project_id=? AND file_id=?",
      [projectId, id],
    );
    if (previous && previous.name !== alias)
      throw new AppError(
        409,
        "shared_name_change",
        "Unshare this item before sharing it under a different name.",
      );
    if (previous?.name !== alias) {
      try {
        await safeStat(root, alias);
        throw new AppError(
          409,
          "name_conflict",
          "A project file already uses this name.",
        );
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    const conflict = await ctx.db.get(
      "SELECT file_id FROM workspace_file_shares WHERE project_id=? AND name=? AND file_id<>?",
      [projectId, alias, id],
    );
    if (conflict)
      throw new AppError(
        409,
        "name_conflict",
        "Another shared file already uses this name.",
      );
    await ensureMountpoint(root, alias, row.kind);
    await ctx.db.run(
      `INSERT INTO workspace_file_shares(file_id,project_id,name,access,created_at) VALUES(?,?,?,?,?) ON CONFLICT(file_id,project_id) DO UPDATE SET name=excluded.name,access=excluded.access`,
      [id, projectId, alias, access, now()],
    );
    await ctx.audit(user, row.org_id, "files.shared", id, {
      projectId,
      access,
    });
  });
  // Never wait for runtime lifecycle work while holding the file mutation lock.
  await ctx.onAccessChanged?.();
}
export async function revokeShare(
  ctx: AppContext,
  user: User,
  id: string,
  projectId: string,
): Promise<void> {
  const row = await sourceRow(ctx, id, true);
  await ctx.requireLibraryFull(user, row.org_id);
  const share = await ctx.db.get<ShareRow>(
    "SELECT * FROM workspace_file_shares WHERE file_id=? AND project_id=?",
    [id, projectId],
  );
  await ctx.db.run(
    "DELETE FROM workspace_file_shares WHERE file_id=? AND project_id=?",
    [id, projectId],
  );
  await ctx.onAccessChanged?.();
  if (share) {
    const root = await ensureRoot(ctx, {
      orgId: row.org_id,
      projectId,
    });
    await removeEmptyMountpoint(root, share.name);
  }
  await ctx.audit(user, row.org_id, "files.unshared", id, {
    projectId,
  });
}
export async function getGrants(ctx: AppContext, user: User, id: string) {
  const row = await sourceRow(ctx, id);
  await ctx.requireLibraryFull(user, row.org_id);
  return ctx.db.all(
    `SELECT g.user_id AS userId,u.name,u.email,g.access FROM workspace_file_grants g JOIN users u ON u.id=g.user_id WHERE g.file_id=?`,
    [id],
  );
}
export async function grantFile(
  ctx: AppContext,
  user: User,
  id: string,
  userId: string,
  access: Access,
): Promise<void> {
  const row = await sourceRow(ctx, id);
  await ctx.requireLibraryFull(user, row.org_id);
  if (row.project_id)
    throw new AppError(
      400,
      "project_grants",
      "Manage project membership to grant access to project files.",
    );
  if (!["read", "write"].includes(access))
    throw new AppError(
      400,
      "invalid_access",
      "Choose read-only or full access.",
    );
  const target = await ctx.db.get<{
    id: string;
  }>(
    "SELECT u.id FROM users u JOIN organization_memberships m ON m.user_id=u.id WHERE u.id=? AND m.org_id=? AND u.enabled=1",
    [userId, row.org_id],
  );
  if (!target)
    throw new AppError(
      404,
      "member_not_found",
      "Organization member not found.",
    );
  await ctx.db.run(
    `INSERT INTO workspace_file_grants(file_id,user_id,access,created_at) VALUES(?,?,?,?) ON CONFLICT(file_id,user_id) DO UPDATE SET access=excluded.access`,
    [id, userId, access, now()],
  );
  await ctx.audit(user, row.org_id, "files.granted", id, {
    userId,
    access,
  });
}
export async function revokeGrant(
  ctx: AppContext,
  user: User,
  id: string,
  userId: string,
): Promise<void> {
  const row = await sourceRow(ctx, id);
  await ctx.requireLibraryFull(user, row.org_id);
  await ctx.db.run(
    "DELETE FROM workspace_file_grants WHERE file_id=? AND user_id=?",
    [id, userId],
  );
  await ctx.audit(user, row.org_id, "files.grant_revoked", id, {
    userId,
  });
}
export async function resolveProjectMounts(
  ctx: AppContext,
  user: User,
  projectId: string,
  mode: Access,
  threadAuthority = false,
): Promise<RuntimeMount[]> {
  const project = await ctx.requireProject(
    user,
    projectId,
    threadAuthority ? "read" : mode,
  );
  const root = await ensureRoot(ctx, {
    orgId: project.orgId,
    projectId,
  });
  const mounts: RuntimeMount[] = [
    {
      source: root,
      target: "/workspace",
      readOnly:
        mode !== "write" || (!threadAuthority && project.access !== "write"),
    },
  ];
  const shares = await ctx.db.all<
    ShareRow & {
      path: string;
      org_id: string;
    }
  >(
    `SELECT s.*,f.path,f.org_id FROM workspace_file_shares s JOIN workspace_files f ON f.id=s.file_id WHERE s.project_id=? AND f.deleted_at IS NULL`,
    [projectId],
  );
  for (const share of shares) {
    if (share.org_id !== project.orgId)
      throw new AppError(
        409,
        "invalid_share",
        "This shared folder is unavailable.",
      );
    const sourceRoot = await ensureRoot(ctx, {
      orgId: project.orgId,
    });
    const stat = await safeStat(sourceRoot, share.path);
    await ensureMountpoint(
      root,
      share.name,
      stat.isDirectory() ? "folder" : "file",
    );
    mounts.push({
      source: path.join(sourceRoot, share.path),
      target: `/workspace/${share.name}`,
      readOnly:
        mode !== "write" ||
        (!threadAuthority && project.access !== "write") ||
        share.access !== "write",
      fileId: share.file_id,
    });
  }
  return mounts;
}
/** Scheduled work has project authority only; share modes remain strict. */
export async function resolveScheduledMounts(
  ctx: AppContext,
  orgId: string,
  projectId: string,
) {
  const root = await ensureRoot(ctx, {
      orgId,
      projectId,
    }),
    sourceRoot = await ensureRoot(ctx, {
      orgId,
    });
  const shares = await ctx.db.all<
    ShareRow & {
      path: string;
      org_id: string;
    }
  >(
    "SELECT s.*,f.path,f.org_id FROM workspace_file_shares s JOIN workspace_files f ON f.id=s.file_id WHERE s.project_id=? AND f.project_id IS NULL AND f.deleted_at IS NULL ORDER BY s.name",
    [projectId],
  );
  const mounts: import("../../../../packages/runtime/src/types.js").RuntimeMount[] =
    [];
  for (const share of shares) {
    if (share.org_id !== orgId)
      throw new AppError(409, "invalid_share", "Shared source is unavailable.");
    const stat = await safeStat(sourceRoot, share.path);
    await ensureMountpoint(
      root,
      share.name,
      stat.isDirectory() ? "folder" : "file",
    );
    mounts.push({
      source: path.join(sourceRoot, share.path),
      target: `/workspace/${share.name}`,
      access: share.access,
    });
  }
  return mounts;
}
async function ensureMountpoint(
  root: string,
  name: string,
  kind: "file" | "folder",
): Promise<void> {
  cleanName(name);
  try {
    const stat = await safeStat(root, name);
    if ((kind === "folder") !== stat.isDirectory())
      throw new AppError(
        409,
        "mountpoint_conflict",
        "A project file conflicts with a shared mount.",
      );
  } catch (error) {
    if (!isMissing(error)) throw error;
    await withLeaf(root, name, (leaf) =>
      kind === "folder"
        ? fs
            .mkdir(leaf, {
              mode: 0o750,
            })
            .then(() => undefined)
        : fs.writeFile(leaf, Buffer.alloc(0), {
            flag: "wx",
            mode: 0o640,
          }),
    );
  }
}
async function removeEmptyMountpoint(
  root: string,
  name: string,
): Promise<void> {
  try {
    const stat = await safeStat(root, name);
    if (stat.isDirectory())
      await withLeaf(root, name, (leaf) => fs.rmdir(leaf));
    else if (stat.size === 0)
      await withLeaf(root, name, (leaf) => fs.unlink(leaf));
  } catch (error) {
    if (
      !isMissing(error) &&
      (error as NodeJS.ErrnoException).code !== "ENOTEMPTY" &&
      !(error instanceof AppError && error.code === "unsafe_path")
    )
      throw error;
  }
}
/** Availability at dispatch, not proof that an agent cited or read these versions. */
export async function captureProjectManifest(
  ctx: AppContext,
  user: User,
  projectId: string,
): Promise<
  {
    fileId: string;
    path: string;
    versionId: string;
  }[]
> {
  return locked(ctx, async () => {
    const project = await ctx.requireProject(user, projectId);
    await reconcile(ctx, {
      orgId: project.orgId,
      projectId,
    });
    await reconcile(ctx, {
      orgId: project.orgId,
    });
    const rows = await ctx.db.all<FileRow>(
      "SELECT * FROM workspace_files WHERE project_id=? AND kind='file' AND deleted_at IS NULL AND version_id IS NOT NULL ORDER BY path",
      [projectId],
    );
    const result = rows.map((row) => ({
      fileId: row.id,
      path: row.path,
      versionId: row.version_id!,
    }));
    const shares = await ctx.db.all<
      ShareRow & {
        sourcePath: string;
      }
    >(
      `SELECT s.*,f.path AS sourcePath FROM workspace_file_shares s JOIN workspace_files f ON f.id=s.file_id WHERE s.project_id=? AND f.deleted_at IS NULL`,
      [projectId],
    );
    const orgFiles = await ctx.db.all<FileRow>(
      "SELECT * FROM workspace_files WHERE org_id=? AND project_id IS NULL AND kind='file' AND deleted_at IS NULL AND version_id IS NOT NULL ORDER BY path",
      [project.orgId],
    );
    for (const share of shares)
      for (const row of orgFiles)
        if (underneath(row.path, share.sourcePath))
          result.push({
            fileId: row.id,
            path: share.name + row.path.slice(share.sourcePath.length),
            versionId: row.version_id!,
          });
    return result;
  });
}
export async function resolveFileMount(
  ctx: AppContext,
  user: User,
  options: {
    fileId: string;
    projectId?: string;
    mode?: Access;
  },
): Promise<
  RuntimeMount & {
    orgId: string;
    projectId: string | null;
  }
> {
  const auth = await authorizeFile(
    ctx,
    user,
    options.fileId,
    options.projectId,
    options.mode === "write",
  );
  const root = await ensureRoot(ctx, auth.scope);
  await safeStat(root, auth.row.path);
  return {
    source: path.join(root, auth.row.path),
    target: `/data/${auth.row.id}`,
    readOnly: options.mode !== "write" || auth.access !== "write",
    fileId: auth.row.id,
    orgId: auth.row.org_id,
    projectId: auth.row.project_id,
  };
}
