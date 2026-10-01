import path from "node:path";
import { AppError, type AppContext, type User } from "../context.js";
import {
  type Access,
  type AuthorizedFile,
  type FileRow,
  type Scope,
  type ShareRow,
} from "./types.js";
import { cleanPath, scopeKey } from "./paths.js";
import { underneath, rowScope, sourceRow } from "./storage.js";
export async function validateScope(
  ctx: AppContext,
  user: User,
  scope: Scope,
  write = false,
): Promise<Access> {
  if (!scope.orgId)
    throw new AppError(400, "invalid_scope", "An organization is required.");
  if (scope.projectId) {
    const project = await ctx.requireProject(
      user,
      scope.projectId,
      write ? "write" : "read",
    );
    if (project.orgId !== scope.orgId)
      throw new AppError(404, "file_not_found", "Workspace not found.");
    return project.access;
  }
  await ctx.requireOrgMember(user, scope.orgId);
  const access = (await ctx.membership(user, scope.orgId)).libraryAccess;
  return access;
}
export async function orgAccess(
  ctx: AppContext,
  user: User,
  row: FileRow,
): Promise<Access | undefined> {
  const membership = await ctx.membership(user, row.org_id);
  if (membership.libraryAccess === "write") return "write";
  const grants = await ctx.db.all<{
    path: string;
    access: Access;
  }>(
    "SELECT f.path,g.access FROM workspace_file_grants g JOIN workspace_files f ON f.id=g.file_id WHERE g.user_id=? AND f.org_id=? AND f.project_id IS NULL AND f.deleted_at IS NULL",
    [user.id, row.org_id],
  );
  return grants.some(
    (g) => g.access === "write" && underneath(row.path, g.path),
  )
    ? "write"
    : "read";
}
export async function authorizeFile(
  ctx: AppContext,
  user: User,
  id: string,
  projectId?: string,
  write = false,
  includeDeleted = false,
): Promise<AuthorizedFile> {
  const row = await sourceRow(ctx, id, includeDeleted);
  let access: Access | undefined;
  let share: ShareRow | undefined;
  if (row.project_id) {
    if (projectId && projectId !== row.project_id)
      throw new AppError(404, "file_not_found", "File or folder not found.");
    const project = await ctx.requireProject(
      user,
      row.project_id,
      write ? "write" : "read",
    );
    access = project.access;
  } else if (projectId) {
    const project = await ctx.requireProject(
      user,
      projectId,
      write ? "write" : "read",
    );
    if (project.orgId !== row.org_id)
      throw new AppError(404, "file_not_found", "File or folder not found.");
    const shares = await ctx.db.all<
      ShareRow & {
        path: string;
      }
    >(
      `SELECT s.*,f.path FROM workspace_file_shares s JOIN workspace_files f ON f.id=s.file_id WHERE s.project_id=? AND f.deleted_at IS NULL`,
      [projectId],
    );
    share = shares
      .filter((s) => underneath(row.path, s.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (share)
      access =
        share.access === "write" && project.access === "write"
          ? "write"
          : "read";
  } else access = await orgAccess(ctx, user, row);
  if (!access || (write && access !== "write"))
    throw new AppError(
      403,
      "file_access_denied",
      write
        ? "You do not have permission to change this file."
        : "You do not have access to this file.",
    );
  return {
    row,
    access,
    share,
    scope: rowScope(row),
    user,
  };
}
export async function resolveLocation(
  ctx: AppContext,
  user: User,
  scope: Scope,
  relative: string,
  write = false,
): Promise<{
  scope: Scope;
  path: string;
  share?: ShareRow & {
    sourcePath: string;
  };
  access: Access;
}> {
  const access = await validateScope(ctx, user, scope, write);
  if (scope.projectId) {
    const shares = await ctx.db.all<
      ShareRow & {
        sourcePath: string;
      }
    >(
      `SELECT s.*,f.path AS sourcePath FROM workspace_file_shares s JOIN workspace_files f ON f.id=s.file_id WHERE s.project_id=? AND f.deleted_at IS NULL`,
      [scope.projectId],
    );
    const share = shares.find((s) => underneath(relative, s.name));
    if (share) {
      const effective =
        access === "write" && share.access === "write" ? "write" : "read";
      if (write && effective !== "write")
        throw new AppError(
          403,
          "file_access_denied",
          "This shared folder is read-only.",
        );
      return {
        scope: {
          orgId: scope.orgId,
        },
        path: share.sourcePath + relative.slice(share.name.length),
        share,
        access: effective,
      };
    }
    return {
      scope,
      path: relative,
      access,
    };
  }
  if ((await ctx.membership(user, scope.orgId)).libraryAccess === "write")
    return {
      scope,
      path: relative,
      access: "write",
    };
  let current = relative;
  while (current) {
    const row = await ctx.db.get<FileRow>(
      "SELECT * FROM workspace_files WHERE scope_key=? AND path=? AND deleted_at IS NULL",
      [scopeKey(scope), current],
    );
    if (row) {
      const allowed = await orgAccess(ctx, user, row);
      if (allowed && (!write || allowed === "write"))
        return {
          scope,
          path: relative,
          access: allowed,
        };
    }
    current = path.posix.dirname(current);
    if (current === ".") break;
  }
  if (write)
    throw new AppError(
      403,
      "file_access_denied",
      "You do not have permission to write in this folder.",
    );
  return {
    scope,
    path: relative,
    access: "read",
  };
}
export async function getDirectoryAccess(
  ctx: AppContext,
  user: User,
  scope: Scope,
  relative = "",
): Promise<Access> {
  cleanPath(relative);
  return (await resolveLocation(ctx, user, scope, relative)).access;
}
