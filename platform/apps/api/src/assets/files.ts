import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { AppError, type AppContext, type User } from "../context.js";
import { cleanPath, readBytes, scopeRoot } from "../files/paths.js";
import { authorizeFile } from "../files/access.js";
import { quotaBytes, MAX_ENTRIES } from "../files/paths.js";
import { underneath } from "../files/storage.js";
import type { Asset } from "../library/reports.js";

export const assetRoot = (ctx: AppContext, id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    throw new AppError(400, "invalid_asset", "Invalid asset.");
  return join(ctx.config.stateDir, "workspaces", "assets", id, "files");
};
/** Generated references identify immutable private snapshots, not container paths or
 * ordinary NULL-project library rows. Publications cannot expose scratch files. */
export async function registerAssetOutput(
  ctx: AppContext,
  a: Asset,
  path: string,
) {
  cleanPath(path, false);
  const root = a.project_id
    ? scopeRoot(ctx, { orgId: a.org_id, projectId: a.project_id })
    : assetRoot(ctx, a.id);
  const bytes = await readBytes(root, path, 4 * 1024 * 1024),
    hash = createHash("sha256").update(bytes).digest("hex");
  let file = await ctx.db.get<{ id: string }>(
    "SELECT id FROM asset_output_files WHERE asset_id=? AND path=?",
    [a.id, path],
  );
  const time = new Date().toISOString();
  if (!file) {
    file = { id: randomUUID() };
    await ctx.db.run(
      "INSERT INTO asset_output_files(id,asset_id,path,version_id,updated_at) VALUES(?,?,?,?,?)",
      [file.id, a.id, path, "", time],
    );
  }
  const existing = await ctx.db.get<{ id: string }>(
    "SELECT id FROM asset_output_versions WHERE file_id=? AND hash=?",
    [file.id, hash],
  );
  if (existing) {
    await ctx.db.run(
      "UPDATE asset_output_files SET version_id=?,updated_at=? WHERE id=?",
      [existing.id, time, file.id],
    );
    return existing.id;
  }
  const usage = await ctx.db.get<{ bytes: number; count: number }>(
    "SELECT COALESCE(SUM(v.size),0) bytes,COUNT(*) count FROM asset_output_versions v JOIN asset_output_files f ON f.id=v.file_id WHERE f.asset_id=?",
    [a.id],
  );
  if (
    usage!.count >= MAX_ENTRIES ||
    usage!.bytes + bytes.length >
      Number(ctx.config.versionQuotaBytes ?? quotaBytes(ctx))
  )
    throw new AppError(
      413,
      "asset_output_limit",
      "Asset output history has reached its storage limit.",
    );
  const directory = join(ctx.config.stateDir, "asset-versions", a.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const f = await open(join(directory, hash), "wx", 0o600);
    try {
      await f.writeFile(bytes);
      await f.sync();
    } finally {
      await f.close();
    }
    const d = await open(directory, "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const id = "af_" + randomUUID();
  await ctx.db.batch([
    {
      sql: "INSERT INTO asset_output_versions VALUES(?,?,?,?,?)",
      params: [id, file.id, hash, bytes.length, time],
    },
    {
      sql: "UPDATE asset_output_files SET version_id=?,updated_at=? WHERE id=?",
      params: [id, time, file.id],
    },
  ]);
  return id;
}
export async function readAssetOutput(
  ctx: AppContext,
  a: Asset,
  id: string,
  max = 4 * 1024 * 1024,
) {
  const row = await ctx.db.get<{ hash: string; size: number }>(
    "SELECT v.hash,v.size FROM asset_output_versions v JOIN asset_output_files f ON f.id=v.file_id WHERE v.id=? AND f.asset_id=?",
    [id, a.id],
  );
  if (!row || !/^[0-9a-f]{64}$/.test(row.hash))
    throw new AppError(
      404,
      "asset_source_not_found",
      "Asset source not found.",
    );
  const bytes = await readBytes(
    join(ctx.config.stateDir, "asset-versions", a.id),
    row.hash,
    max,
  );
  if (createHash("sha256").update(bytes).digest("hex") !== row.hash)
    throw new AppError(
      409,
      "asset_source_changed",
      "Asset source is unavailable.",
    );
  return bytes;
}
export async function selectedSource(
  ctx: AppContext,
  user: User,
  a: Asset,
  id: string,
) {
  const auth = await authorizeFile(ctx, user, id, a.project_id ?? undefined);
  if (
    auth.row.org_id !== a.org_id ||
    (auth.row.project_id && auth.row.project_id !== a.project_id)
  )
    throw new AppError(
      403,
      "asset_source_scope",
      "Source is outside this asset's workspace.",
    );
  if (!a.project_id) {
    const grants = await ctx.db.all<{ path: string }>(
      "SELECT f.path FROM asset_sources s JOIN workspace_files f ON f.id=s.file_id WHERE s.asset_id=? AND f.org_id=? AND f.project_id IS NULL AND f.deleted_at IS NULL",
      [a.id, a.org_id],
    );
    if (!grants.some((g) => underneath(auth.row.path, g.path)))
      throw new AppError(
        403,
        "asset_source_scope",
        "Select this library source before using it in the conversation.",
      );
  }
  return auth;
}
