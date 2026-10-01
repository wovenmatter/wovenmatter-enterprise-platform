import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AppError, type AppContext } from "../context.js";
import { type FileRow, type Scope } from "./types.js";
import {
  cleanPath,
  ensureRoot,
  isMissing,
  MAX_ENTRIES,
  maxFileBytes,
  quotaBytes,
  readBytes,
  safeStat,
  scopeKey,
  withLeaf,
} from "./paths.js";

const migration = `
CREATE TABLE IF NOT EXISTS workspace_files (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), project_id TEXT REFERENCES projects(id),
 scope_key TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','folder')),
 size INTEGER NOT NULL DEFAULT 0, hash TEXT, fs_key TEXT, stat_key TEXT, version_id TEXT,
 updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_files_live_path ON workspace_files(scope_key,path) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS workspace_files_identity ON workspace_files(scope_key,fs_key);
CREATE TABLE IF NOT EXISTS workspace_file_versions (
 id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES workspace_files(id), hash TEXT NOT NULL,
 size INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_file_version_lookup ON workspace_file_versions(file_id,created_at);
CREATE TABLE IF NOT EXISTS workspace_file_grants (
 file_id TEXT NOT NULL REFERENCES workspace_files(id), user_id TEXT NOT NULL REFERENCES users(id),
 access TEXT NOT NULL CHECK(access IN ('read','write')), created_at TEXT NOT NULL, PRIMARY KEY(file_id,user_id)
);
CREATE TABLE IF NOT EXISTS workspace_file_shares (
 file_id TEXT NOT NULL REFERENCES workspace_files(id), project_id TEXT NOT NULL REFERENCES projects(id),
 name TEXT NOT NULL, access TEXT NOT NULL CHECK(access IN ('read','write')), created_at TEXT NOT NULL,
 PRIMARY KEY(file_id,project_id), UNIQUE(project_id,name)
);`;
const locks = new WeakMap<AppContext, Promise<unknown>>();
export async function locked<T>(
  ctx: AppContext,
  operation: () => Promise<T>,
): Promise<T> {
  const before = locks.get(ctx) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(operation);
  locks.set(
    ctx,
    next.catch(() => undefined),
  );
  return next;
}
export async function initializeFiles(ctx: AppContext): Promise<void> {
  await ctx.db.migrate("workspace-files-v1", migration);
  await fs.mkdir(path.join(ctx.config.stateDir, "file-versions"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.join(ctx.config.stateDir, "file-staging"), {
    recursive: true,
    mode: 0o700,
  });
}
export const now = () => new Date().toISOString();
export const underneath = (child: string, parent: string) =>
  child === parent || child.startsWith(`${parent}/`);
export function rowScope(row: FileRow): Scope {
  return { orgId: row.org_id, projectId: row.project_id };
}
export async function sourceRow(
  ctx: AppContext,
  id: string,
  includeDeleted = false,
): Promise<FileRow> {
  const row = await ctx.db.get<FileRow>(
    `SELECT * FROM workspace_files WHERE id=?${includeDeleted ? "" : " AND deleted_at IS NULL"}`,
    [id],
  );
  if (!row)
    throw new AppError(404, "file_not_found", "File or folder not found.");
  return row;
}

async function snapshotBytes(ctx: AppContext, bytes: Buffer): Promise<string> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const destination = path.join(ctx.config.stateDir, "file-versions", hash);
  const temporary = path.join(
    ctx.config.stateDir,
    "file-versions",
    `.pending-${randomUUID()}`,
  );
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return hash;
}

/** Reconciles native agent edits into the UI and snapshots every observed file version. */
export async function reconcile(ctx: AppContext, scope: Scope): Promise<void> {
  const root = await ensureRoot(ctx, scope);
  const key = scopeKey(scope);
  const old = await ctx.db.all<FileRow & { stat_key: string | null }>(
    "SELECT * FROM workspace_files WHERE scope_key=? AND deleted_at IS NULL",
    [key],
  );
  const archiveUsage = await ctx.db.get<{ size: number }>(
    `SELECT COALESCE(SUM(v.size),0) AS size FROM workspace_file_versions v JOIN workspace_files f ON f.id=v.file_id WHERE f.scope_key=?`,
    [key],
  );
  let archivedBytes = Number(archiveUsage?.size ?? 0);
  const archiveLimit = Number(ctx.config.versionQuotaBytes ?? quotaBytes(ctx));
  const byPath = new Map(old.map((row) => [row.path, row]));
  const seen = new Set<string>();
  let count = 0;
  const reserved = new Set(
    scope.projectId
      ? (
          await ctx.db.all<{ name: string }>(
            "SELECT name FROM workspace_file_shares WHERE project_id=?",
            [scope.projectId],
          )
        ).map((s) => s.name)
      : [],
  );
  const rows: { relative: string; stat: import("node:fs").Stats }[] = [];
  async function walk(relative: string): Promise<void> {
    const names = await withLeaf(root, relative, (leaf) => fs.readdir(leaf));
    for (const name of names.sort()) {
      if (name.startsWith(".wme-upload-") || (!relative && reserved.has(name)))
        continue;
      const item = relative ? `${relative}/${name}` : name;
      try {
        cleanPath(item, false);
        if (++count > MAX_ENTRIES)
          throw new AppError(
            413,
            "too_many_files",
            "This workspace has too many files to list.",
          );
        const stat = await safeStat(root, item);
        rows.push({ relative: item, stat });
        if (stat.isDirectory()) await walk(item);
      } catch (error) {
        if (
          error instanceof AppError &&
          ["unsafe_path", "invalid_path"].includes(error.code)
        )
          continue;
        if (isMissing(error)) continue;
        throw error;
      }
    }
  }
  await walk("");
  // Tombstone missing paths before native rename reconciliation so the unique live path index is never transiently violated.
  const paths = new Set(rows.map((item) => item.relative));
  for (const row of old)
    if (!paths.has(row.path))
      await ctx.db.run("UPDATE workspace_files SET deleted_at=? WHERE id=?", [
        now(),
        row.id,
      ]);
  for (const { relative, stat } of rows) {
    const fsKey = `${stat.dev}:${stat.ino}`;
    const statKey = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    let row = byPath.get(relative);
    if (!row)
      row = old.find(
        (candidate) =>
          candidate.fs_key === fsKey &&
          !paths.has(candidate.path) &&
          !seen.has(candidate.id),
      );
    const kind = stat.isDirectory() ? "folder" : "file";
    if (row && row.kind !== kind) {
      await ctx.db.run("UPDATE workspace_files SET deleted_at=? WHERE id=?", [
        now(),
        row.id,
      ]);
      row = undefined;
    }
    const id = row?.id ?? randomUUID();
    seen.add(id);
    if (
      row &&
      row.stat_key === statKey &&
      row.path === relative &&
      (kind === "folder" || row.version_id)
    )
      continue;
    let hash: string | null = null;
    let size = 0;
    let versionId = row?.version_id ?? null;
    if (kind === "file") {
      if (stat.size > maxFileBytes(ctx)) {
        hash = null;
        size = stat.size;
        versionId = null;
      } else {
        const bytes = await readBytes(root, relative, maxFileBytes(ctx));
        size = bytes.length;
        const candidateHash = createHash("sha256").update(bytes).digest("hex");
        if (candidateHash === row?.hash && versionId) hash = candidateHash;
        else if (archivedBytes + size > archiveLimit) {
          hash = null;
          versionId = null;
        } else {
          hash = await snapshotBytes(ctx, bytes);
          versionId = randomUUID();
          archivedBytes += size;
        }
      }
    }
    const timestamp = now();
    const statements = [
      {
        sql: `INSERT INTO workspace_files(id,org_id,project_id,scope_key,path,kind,size,hash,fs_key,stat_key,version_id,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET path=excluded.path,kind=excluded.kind,size=excluded.size,hash=excluded.hash,fs_key=excluded.fs_key,stat_key=excluded.stat_key,version_id=excluded.version_id,updated_at=excluded.updated_at,deleted_at=NULL`,
        params: [
          id,
          scope.orgId,
          scope.projectId ?? null,
          key,
          relative,
          kind,
          size,
          hash,
          fsKey,
          statKey,
          versionId,
          timestamp,
        ],
      },
    ];
    if (hash && versionId && versionId !== row?.version_id)
      statements.push({
        sql: "INSERT INTO workspace_file_versions(id,file_id,hash,size,name,created_at) VALUES(?,?,?,?,?,?)",
        params: [
          versionId,
          id,
          hash,
          size,
          path.posix.basename(relative),
          timestamp,
        ],
      });
    await ctx.db.batch(statements);
  }
}
export async function reconcileProjectFiles(
  ctx: AppContext,
  projectId: string,
): Promise<void> {
  await locked(ctx, async () => {
    const project = await ctx.db.get<{ org_id: string }>(
      "SELECT org_id FROM projects WHERE id=?",
      [projectId],
    );
    if (!project) return;
    await reconcile(ctx, { orgId: project.org_id, projectId });
    // Shared files remain in organization storage; reconcile their native edits too.
    await reconcile(ctx, { orgId: project.org_id });
  });
}
