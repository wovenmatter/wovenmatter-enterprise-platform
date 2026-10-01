import { randomUUID, createHash } from "node:crypto";
import { AppError, type AppContext, type User } from "../context.js";

export interface AssetRow {
  id: string;
  org_id: string;
  hostname_slug: string;
  project_id: string | null;
  name: string;
  description: string;
  type: "static" | "live";
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
export interface VersionRow {
  id: string;
  asset_id: string;
  number: number;
  entrypoint: string;
  manifest_hash: string;
  source_file_id: string | null;
  source_version_id: string | null;
  runtime_id: string | null;
  runtime_status: string;
  runtime_error: string | null;
  created_at: string;
}
export interface ShareRow {
  id: string;
  asset_id: string;
  version_id: string | null;
  token_hash: string;
  visibility: "public" | "organization" | "people";
  user_ids: string;
  created_at: string;
  revoked_at: string | null;
}
export function organizationHostnameSlug(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 26).replace(/-+$/g, "") || "org";
}
export const now = () => new Date().toISOString();
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const uuid = () => randomUUID();
export const idPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function identifier(s: unknown): string {
  if (typeof s !== "string" || !idPattern.test(s))
    throw new AppError(400, "invalid_id", "A valid identifier is required.");
  return s;
}
export function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError(400, "invalid_body", "A JSON object is required.");
  return value as Record<string, unknown>;
}
export function textValue(
  value: unknown,
  max: number,
  fallback?: string,
): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new AppError(400, "invalid_field", "A field is empty or too long.");
  return value.trim();
}
export function safePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value ||
    /[\\\x00-\x1f\x7f]/.test(value) ||
    value.startsWith("/") ||
    value.includes(":")
  )
    throw new AppError(400, "invalid_path", "Invalid asset path.");
  const parts = value.split("/");
  if (parts.some((x) => !x || x === "." || x === ".." || x.startsWith(".")))
    throw new AppError(400, "invalid_path", "Invalid asset path.");
  return parts.join("/");
}
export const assetDto = (a: AssetRow) => ({
  id: a.id,
  orgId: a.org_id,
  projectId: a.project_id,
  name: a.name,
  description: a.description,
  type: a.type,
  currentVersionId: a.current_version_id,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
});
export const versionDto = (v: VersionRow) => ({
  id: v.id,
  assetId: v.asset_id,
  number: v.number,
  entrypoint: v.entrypoint,
  manifestHash: v.manifest_hash,
  sourceFileId: v.source_file_id,
  sourceVersionId: v.source_version_id,
  runtimeId: v.runtime_id,
  runtimeStatus: v.runtime_status,
  runtimeError: v.runtime_error ?? null,
  createdAt: v.created_at,
});
export const shareDto = (s: ShareRow) => ({
  id: s.id,
  assetId: s.asset_id,
  versionId: s.version_id,
  visibility: s.visibility,
  userIds: JSON.parse(s.user_ids) as string[],
  createdAt: s.created_at,
  revokedAt: s.revoked_at,
});
export async function getAsset(ctx: AppContext, id: string): Promise<AssetRow> {
  const a = await ctx.db.get<AssetRow>(
    "SELECT * FROM library_assets WHERE id=? AND deleted_at IS NULL",
    [id],
  );
  if (!a) throw new AppError(404, "asset_not_found", "Asset not found.");
  if (
    a.project_id &&
    !(await ctx.db.get(
      "SELECT id FROM projects WHERE id=? AND status NOT IN (?,?)",
      [a.project_id, "deleted", "deleting"],
    ))
  )
    throw new AppError(404, "asset_not_found", "Asset not found.");
  return a;
}
export async function access(
  ctx: AppContext,
  user: User,
  a: AssetRow,
  write = false,
) {
  await ctx.requireOrgMember(user, a.org_id);
  if (a.project_id)
    await ctx.requireProject(user, a.project_id, write ? "write" : "read");
  else if (write) await ctx.requireOrgAdmin(user, a.org_id);
}
export async function shareAccess(
  ctx: AppContext,
  s: ShareRow,
  userId: string | null,
) {
  if (s.revoked_at)
    throw new AppError(
      404,
      "share_unavailable",
      "This link is no longer available.",
    );
  const a = await getAsset(ctx, s.asset_id);
  if (s.visibility !== "public") {
    if (!userId)
      throw new AppError(
        401,
        "sign_in_required",
        "Sign in to view this asset.",
      );
    const u = await ctx.db.get<{
      org_id: string | null;
      enabled: number;
      role: string;
    }>("SELECT org_id,enabled,role FROM users WHERE id=?", [userId]);
    if (!u?.enabled || (u.role !== "owner" && u.org_id !== a.org_id))
      throw new AppError(
        403,
        "share_denied",
        "You do not have access to this asset.",
      );
    if (
      u.role !== "owner" &&
      s.visibility === "people" &&
      !(JSON.parse(s.user_ids) as string[]).includes(userId)
    )
      throw new AppError(
        403,
        "share_denied",
        "You do not have access to this asset.",
      );
  }
  return a;
}
export async function migrateLibrary(ctx: AppContext) {
  await ctx.db.migrate(
    "library-v1",
    `
CREATE TABLE library_assets(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),project_id TEXT REFERENCES projects(id),name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',type TEXT NOT NULL CHECK(type IN ('static','live')),current_version_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
CREATE INDEX library_assets_org ON library_assets(org_id,project_id);
CREATE TABLE library_versions(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES library_assets(id),number INTEGER NOT NULL,entrypoint TEXT NOT NULL,manifest_hash TEXT NOT NULL,source_file_id TEXT,source_version_id TEXT,runtime_id TEXT,runtime_status TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(asset_id,number));
CREATE TABLE library_shares(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES library_assets(id),version_id TEXT REFERENCES library_versions(id),token_hash TEXT NOT NULL UNIQUE,visibility TEXT NOT NULL CHECK(visibility IN ('public','organization','people')),user_ids TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT);
CREATE INDEX library_shares_asset ON library_shares(asset_id);
CREATE TABLE library_grants(id TEXT PRIMARY KEY,share_id TEXT NOT NULL REFERENCES library_shares(id),user_id TEXT REFERENCES users(id),session_id TEXT,expires_at TEXT NOT NULL,ticket INTEGER NOT NULL DEFAULT 1);
CREATE INDEX library_grants_expiry ON library_grants(expires_at);
CREATE TABLE library_sources(version_id TEXT NOT NULL REFERENCES library_versions(id),file_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),project_id TEXT,source_path TEXT NOT NULL,source_device TEXT NOT NULL,source_inode TEXT NOT NULL,PRIMARY KEY(version_id,file_id));
CREATE TABLE library_launches(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES library_assets(id),created_at TEXT NOT NULL);
`,
  );
  await ctx.db.migrate("library-hostname-v4",
    "ALTER TABLE library_assets ADD COLUMN hostname_slug TEXT;");
  const unnamed = await ctx.db.all<{id:string; name:string}>(
    "SELECT a.id,o.name FROM library_assets a JOIN organizations o ON o.id=a.org_id WHERE a.hostname_slug IS NULL");
  for (const asset of unnamed) await ctx.db.run(
    "UPDATE library_assets SET hostname_slug=? WHERE id=? AND hostname_slug IS NULL",
    [organizationHostnameSlug(asset.name), asset.id]);
  // Candidate installations may already contain the earlier v1 schema. Upgrade
  // without discarding published assets or pretending old mounts were attested.
  const sourceColumns = await ctx.db.all<{ name: string }>(
    "PRAGMA table_info(library_sources)",
  );
  const upgrades = [
    "CREATE TABLE IF NOT EXISTS library_sources(version_id TEXT NOT NULL REFERENCES library_versions(id),file_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),project_id TEXT,source_path TEXT NOT NULL,source_device TEXT NOT NULL,source_inode TEXT NOT NULL,PRIMARY KEY(version_id,file_id));",
    "CREATE TABLE IF NOT EXISTS library_launches(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES library_assets(id),created_at TEXT NOT NULL);",
  ];
  if (
    sourceColumns.length &&
    !sourceColumns.some((c) => c.name === "source_device")
  )
    upgrades.push(
      "ALTER TABLE library_sources ADD COLUMN source_device TEXT NOT NULL DEFAULT '';",
    );
  if (
    sourceColumns.length &&
    !sourceColumns.some((c) => c.name === "source_inode")
  )
    upgrades.push(
      "ALTER TABLE library_sources ADD COLUMN source_inode TEXT NOT NULL DEFAULT '';",
    );
  await ctx.db.migrate("library-runtime-durability-v2", upgrades.join("\n"));
  const versionColumns = await ctx.db.all<{ name: string }>(
    "PRAGMA table_info(library_versions)",
  );
  await ctx.db.migrate(
    "library-recovery-v3",
    versionColumns.some((c) => c.name === "runtime_error")
      ? "SELECT 1;"
      : "ALTER TABLE library_versions ADD COLUMN runtime_error TEXT;",
  );
}
