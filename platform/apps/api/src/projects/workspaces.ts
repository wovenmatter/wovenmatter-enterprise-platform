import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { AppError, type AppContext, type User } from "../context.js";
import { ensureRoot, withLeaf, cleanPath, safeStat } from "../files/paths.js";
import { locked } from "../files/storage.js";

export const managedRoot = ".WovenMatter";
export const workspaceSchema = `
CREATE TABLE project_folders (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
 root_path TEXT NOT NULL, root_device TEXT NOT NULL, root_inode TEXT NOT NULL,
 pinned INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
 reference_paths TEXT NOT NULL DEFAULT '[]', deleted_at TEXT, directory_deleted INTEGER NOT NULL DEFAULT 0, directory_removal_pending INTEGER NOT NULL DEFAULT 0, removal_path TEXT
);
CREATE INDEX project_folders_order ON project_folders(project_id,pinned,position);
ALTER TABLE conversations ADD COLUMN folder_id TEXT REFERENCES project_folders(id);
ALTER TABLE conversations ADD COLUMN working_directory TEXT;
ALTER TABLE conversations ADD COLUMN directory_device TEXT;
ALTER TABLE conversations ADD COLUMN directory_inode TEXT;
ALTER TABLE conversations ADD COLUMN scratch_name TEXT;
ALTER TABLE conversations ADD COLUMN workspace_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
`;
export type FolderRow = {
  id: string;
  project_id: string;
  name: string;
  root_path: string;
  root_device: string;
  root_inode: string;
  pinned: number;
  position: number;
  reference_paths: string;
  deleted_at: string | null;
  directory_deleted: number;
  directory_removal_pending: number;
  removal_path: string | null;
};
export const folderView = (f: FolderRow) => ({
  id: f.id,
  projectId: f.project_id,
  name: f.name,
  rootPath: f.root_path,
  pinned: !!f.pinned,
  position: f.position,
  removalPending: !!f.directory_removal_pending,
  referencePaths: JSON.parse(f.reference_paths),
});
const conflict = (message: string) =>
  new AppError(409, "workspace_unavailable", message);
export function folderName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  if (
    !name ||
    name.toLowerCase() === "scratch" ||
    name.startsWith(".") ||
    /[\\/:\x00-\x1f\x7f]/.test(name) ||
    Buffer.byteLength(name) > 240
  )
    throw new AppError(
      400,
      "invalid_folder",
      "Use a folder name without slashes or a leading period. Scratch is reserved for All Workspaces chats.",
    );
  return name;
}
async function root(ctx: AppContext, projectId: string) {
  const project = await ctx.db.get<{ org_id: string }>(
    "SELECT org_id FROM projects WHERE id=?",
    [projectId],
  );
  if (!project) throw new AppError(404, "not_found", "Project not found.");
  return ensureRoot(ctx, { orgId: project.org_id, projectId });
}
async function directory(
  ctx: AppContext,
  projectId: string,
  relative: string,
  create = false,
) {
  if (
    await ctx.db.get(
      "SELECT 1 FROM workspace_file_shares WHERE project_id=? AND name=?",
      [projectId, managedRoot],
    )
  )
    throw conflict("The managed workspace root cannot be a library share.");
  const base = await root(ctx, projectId);
  return withLeaf(base, relative, async (leaf) => {
    if (create) {
      try {
        await fs.mkdir(leaf, { mode: 0o750 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    const stat = await fs.lstat(leaf, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw conflict("Workspace folders must be ordinary directories.");
    return { device: String(stat.dev), inode: String(stat.ino) };
  });
}
export async function listFolders(
  ctx: AppContext,
  user: User,
  projectId: string,
) {
  await ctx.requireProject(user, projectId);
  return {
    items: (
      await ctx.db.all<FolderRow>(
        "SELECT * FROM project_folders WHERE project_id=? AND (deleted_at IS NULL OR directory_removal_pending=1) ORDER BY pinned DESC,position,id",
        [projectId],
      )
    ).map(folderView),
  };
}
export async function requireFolder(
  ctx: AppContext,
  projectId: string,
  id: unknown,
  retained = false,
) {
  if (typeof id !== "string")
    throw new AppError(
      400,
      "invalid_folder",
      "Choose a folder in this project.",
    );
  const f = await ctx.db.get<FolderRow>(
    `SELECT * FROM project_folders WHERE id=? AND project_id=?${retained ? "" : " AND deleted_at IS NULL"}`,
    [id, projectId],
  );
  if (!f || f.directory_deleted || f.directory_removal_pending)
    throw conflict(
      "This folder is unavailable. Choose another folder before sending.",
    );
  return f;
}
export async function createFolder(
  ctx: AppContext,
  user: User,
  projectId: string,
  input: Record<string, unknown>,
) {
  await ctx.requireProject(user, projectId, "write");
  const name = folderName(input.name);
  return locked(ctx, async () => {
    await directory(ctx, projectId, managedRoot, true);
    const base = await root(ctx, projectId),
      relative = `${managedRoot}/${name}`;
    try {
      await withLeaf(base, relative, (leaf) => fs.mkdir(leaf, { mode: 0o750 }));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw conflict("A directory with that name already exists.");
      throw e;
    }
    const stat = await directory(ctx, projectId, relative),
      id = randomUUID();
    await ctx.db.run(
      "INSERT INTO project_folders(id,project_id,name,root_path,root_device,root_inode,position) VALUES(?,?,?,?,?,?,COALESCE((SELECT MAX(position)+1 FROM project_folders WHERE project_id=?),0))",
      [id, projectId, name, relative, stat.device, stat.inode, projectId],
    );
    return folderView(await requireFolder(ctx, projectId, id));
  });
}
export async function updateFolder(
  ctx: AppContext,
  user: User,
  projectId: string,
  id: string,
  input: Record<string, unknown>,
) {
  await ctx.requireProject(user, projectId, "write");
  return locked(ctx, async () => {
    const f = await requireFolder(ctx, projectId, id);
    const name =
      input.name === undefined
        ? f.name
        : typeof input.name === "string"
          ? input.name.trim()
          : "";
    if (!name || name.length > 160 || /[\x00-\x1f\x7f]/.test(name))
      throw new AppError(
        400,
        "invalid_folder",
        "Choose a folder display name of 1–160 characters.",
      );
    if (
      input.direction !== undefined &&
      input.direction !== "up" &&
      input.direction !== "down"
    )
      throw new AppError(400, "invalid_order", "Choose up or down.");
    if (input.pinned !== undefined && typeof input.pinned !== "boolean")
      throw new AppError(400, "invalid_folder", "Pin must be true or false.");
    const pinned = input.pinned === undefined ? f.pinned : Number(input.pinned);
    let references = JSON.parse(f.reference_paths) as string[];
    if (input.referencePaths !== undefined) {
      if (
        !Array.isArray(input.referencePaths) ||
        input.referencePaths.length > 32
      )
        throw new AppError(
          400,
          "invalid_references",
          "Choose up to 32 project reference locations.",
        );
      references = [
        ...new Set(input.referencePaths.map((p) => cleanPath(p, false))),
      ];
      const base = await root(ctx, projectId);
      for (const p of references) {
        const s = await safeStat(base, p);
        if (!s || s.isSymbolicLink())
          throw conflict("A reference location is unavailable.");
      }
    }
    const position =
      pinned !== f.pinned
        ? (await ctx.db.get<{ n: number }>(
            "SELECT COALESCE(MAX(position)+1,0) n FROM project_folders WHERE project_id=? AND pinned=? AND deleted_at IS NULL",
            [projectId, pinned],
          ))!.n
        : f.position;
    await ctx.db.run(
      "UPDATE project_folders SET name=?,pinned=?,position=?,reference_paths=? WHERE id=?",
      [name, pinned, position, JSON.stringify(references), id],
    );
    if (input.direction !== undefined) {
      if (input.direction !== "up" && input.direction !== "down")
        throw new AppError(400, "invalid_order", "Choose up or down.");
      const rows = await ctx.db.all<FolderRow>(
        "SELECT * FROM project_folders WHERE project_id=? AND pinned=? AND deleted_at IS NULL ORDER BY position,id",
        [projectId, pinned],
      );
      const index = rows.findIndex((r) => r.id === id),
        other = index + (input.direction === "up" ? -1 : 1);
      if (other >= 0 && other < rows.length) {
        [rows[index], rows[other]] = [rows[other]!, rows[index]!];
        await ctx.db.batch(
          rows.map((r, i) => ({
            sql: "UPDATE project_folders SET position=? WHERE id=?",
            params: [i, r.id],
          })),
        );
      }
    }
    return folderView(await requireFolder(ctx, projectId, id));
  });
}
export async function markFolderRemoved(
  ctx: AppContext,
  user: User,
  projectId: string,
  id: string,
  physical: boolean,
) {
  await ctx.requireProject(user, projectId, "write");
  const f = await ctx.db.get<FolderRow>(
    "SELECT * FROM project_folders WHERE id=? AND project_id=? AND directory_deleted=0",
    [id, projectId],
  );
  if (!f) throw conflict("Folder not found.");
  if (f.directory_removal_pending && !physical)
    throw conflict(
      "Directory removal is pending. Retry the directory removal to finish it.",
    );
  await ctx.db.run(
    "UPDATE project_folders SET deleted_at=?,directory_removal_pending=? WHERE id=?",
    [physical ? null : new Date().toISOString(), Number(physical), id],
  );
  return f;
}
export async function deleteFolderDirectory(ctx: AppContext, f: FolderRow) {
  const base = await root(ctx, f.project_id);
  const reservation = join(
    ctx.config.stateDir,
    "file-staging",
    `folder-${randomUUID()}`,
  );
  await ctx.db.run(
    "UPDATE project_folders SET removal_path=COALESCE(removal_path,?) WHERE id=?",
    [reservation, f.id],
  );
  const canonical = (await ctx.db.get<FolderRow>(
    "SELECT * FROM project_folders WHERE id=?",
    [f.id],
  ))!;
  const stage = canonical.removal_path!;
  let staged = false;
  try {
    await fs.lstat(stage);
    staged = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (!staged && f.removal_path) {
    let sourceExists = true;
    try {
      await withLeaf(base, f.root_path, (leaf) => fs.lstat(leaf));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") sourceExists = false;
      else throw e;
    }
    if (!sourceExists) {
      await ctx.db.run(
        "UPDATE project_folders SET deleted_at=?,directory_deleted=1,directory_removal_pending=0 WHERE id=?",
        [new Date().toISOString(), f.id],
      );
      return;
    }
  }
  if (!staged)
    await withLeaf(base, f.root_path, async (leaf) => {
      const s = await fs.lstat(leaf, { bigint: true });
      if (
        s.isSymbolicLink() ||
        !s.isDirectory() ||
        String(s.dev) !== f.root_device ||
        String(s.ino) !== f.root_inode
      )
        throw conflict("The folder directory changed; no files were deleted.");
      await fs.rename(leaf, stage);
    });
  const moved = await fs.lstat(stage, { bigint: true });
  if (
    String(moved.dev) !== f.root_device ||
    String(moved.ino) !== f.root_inode ||
    moved.isSymbolicLink()
  )
    throw conflict("The folder directory changed; no files were deleted.");
  await fs.rm(stage, { recursive: true });
  await ctx.db.run(
    "UPDATE project_folders SET deleted_at=?,directory_deleted=1,directory_removal_pending=0 WHERE id=?",
    [new Date().toISOString(), f.id],
  );
}

export function scratchFolderName(
  id: string,
  content: string,
  date = new Date(),
  fullID = false,
) {
  const words = content
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return [
    date.toISOString().slice(0, 10),
    words,
    fullID
      ? id.replace(/[^a-z0-9]/gi, "").toLowerCase()
      : id
          .replace(/[^a-z0-9]/gi, "")
          .toLowerCase()
          .slice(-8),
  ]
    .filter(Boolean)
    .join("-");
}
export async function prepareConversationDirectory(
  ctx: AppContext,
  c: {
    id: string;
    project_id: string | null;
    asset_id?: string | null;
    folder_id?: string | null;
    working_directory?: string | null;
    directory_device?: string | null;
    directory_inode?: string | null;
    scratch_name?: string | null;
  },
  content: string,
) {
  if (c.asset_id) return { path: "/workspace", identity: undefined };
  const projectId = c.project_id!;
  let relative = c.working_directory,
    expected = c.directory_device
      ? { device: c.directory_device, inode: c.directory_inode! }
      : undefined;
  if (c.folder_id) {
    const f = await requireFolder(ctx, projectId, c.folder_id, true);
    relative = f.root_path;
    expected = { device: f.root_device, inode: f.root_inode };
  } else if (!relative) {
    let scratch = c.scratch_name ?? scratchFolderName(c.id, content);
    if (!c.scratch_name) {
      try {
        await directory(ctx, projectId, `${managedRoot}/scratch/${scratch}`);
        scratch = scratchFolderName(c.id, content, new Date(), true);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    relative = `${managedRoot}/scratch/${scratch}`;
    // Reserve durably before touching the filesystem; retries use this exact path.
    await ctx.db.run(
      "UPDATE conversations SET working_directory=?,scratch_name=? WHERE id=? AND working_directory IS NULL",
      [relative, scratch, c.id],
    );
  }
  if (!expected) {
    await directory(ctx, projectId, managedRoot, true);
    await directory(ctx, projectId, `${managedRoot}/scratch`, true);
  }
  const stat = await directory(ctx, projectId, relative, !expected);
  if (
    expected &&
    (stat.device !== expected.device || stat.inode !== expected.inode)
  )
    throw conflict(
      "The conversation's working directory changed. Start a new conversation.",
    );
  await ctx.db.run(
    "UPDATE conversations SET working_directory=?,directory_device=?,directory_inode=? WHERE id=?",
    [relative, stat.device, stat.inode, c.id],
  );
  return { path: `/workspace/${relative}`, identity: stat };
}

/** Private staged folder bytes belong to the project and must be purged too. */
export async function purgeFolderStaging(ctx: AppContext, projectId: string) {
  const staging = join(ctx.config.stateDir, "file-staging");
  const folders = await ctx.db.all<FolderRow>(
    "SELECT * FROM project_folders WHERE project_id=? AND removal_path IS NOT NULL",
    [projectId],
  );
  for (const f of folders) {
    const name = f.removal_path!.slice(staging.length + 1);
    if (
      f.removal_path !== join(staging, name) ||
      !/^folder-[0-9a-f-]{36}$/.test(name)
    )
      throw conflict(
        "Folder staging identity is unavailable; purge has not completed.",
      );
    try {
      await withLeaf(staging, name, async (leaf) => {
        const stat = await fs.lstat(leaf, { bigint: true });
        if (
          stat.isSymbolicLink() ||
          !stat.isDirectory() ||
          String(stat.dev) !== f.root_device ||
          String(stat.ino) !== f.root_inode
        )
          throw conflict(
            "Folder staging identity changed; purge has not completed.",
          );
        await fs.rm(leaf, { recursive: true });
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
