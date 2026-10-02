import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  AppError,
  objectBody,
  stringValue,
  type AppContext,
  type User,
} from "../context.js";
import { authorizeFile } from "../files/index.js";
import { readCurrentFile } from "../files/service.js";
import {
  creator,
  headers,
  imageType,
  renderReport,
  source,
  validateReport,
  type Asset,
} from "./reports.js";

type StoredAsset = Asset & {
  description: string;
  draft_document: string;
  draft_revision: number;
  published_version: number;
};
type Version = {
  number: number;
  name: string;
  description: string;
  document: string;
  created_at: string;
};
const initial = JSON.stringify({
  version: 1,
  blocks: [{ type: "text", text: "" }],
});
const activeProject =
  "(r.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.status NOT IN ('deleted','deleting','purged')))";
const conflict = () =>
  new AppError(
    409,
    "asset_changed",
    "This asset changed. Reload it before saving or publishing.",
  );

export async function migrateAssets(ctx: AppContext) {
  await ctx.db.migrate(
    "safe-reports-v1",
    `CREATE TABLE reports(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),project_id TEXT NOT NULL REFERENCES projects(id),creator_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,visibility TEXT NOT NULL DEFAULT 'project' CHECK(visibility IN ('project','organization','public')),document TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);CREATE INDEX reports_org ON reports(org_id);`,
  );
  // Existing published IDs, URLs, visibility and definitions survive this atomic migration.
  await ctx.db.migrate(
    "asset-drafts-v1",
    `
    CREATE TABLE reports_next(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),project_id TEXT REFERENCES projects(id),creator_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',visibility TEXT NOT NULL CHECK(visibility IN ('project','organization','public')),document TEXT NOT NULL,draft_document TEXT NOT NULL,draft_revision INTEGER NOT NULL DEFAULT 1,published_version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,CHECK(project_id IS NOT NULL OR visibility<>'project'));
    INSERT INTO reports_next(id,org_id,project_id,creator_id,name,visibility,document,draft_document,published_version,created_at,updated_at,deleted_at) SELECT id,org_id,project_id,creator_id,name,visibility,document,document,1,created_at,updated_at,deleted_at FROM reports;
    DROP TABLE reports;
    ALTER TABLE reports_next RENAME TO reports;
    CREATE INDEX reports_org ON reports(org_id);
    CREATE TABLE asset_versions(asset_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,number INTEGER NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,document TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(asset_id,number));
    INSERT INTO asset_versions SELECT id,1,name,description,document,updated_at FROM reports;
  `,
  );
}
async function get(ctx: AppContext, id: string) {
  const a = await ctx.db.get<StoredAsset>(
    `SELECT r.* FROM reports r WHERE r.id=? AND r.deleted_at IS NULL AND ${activeProject}`,
    [id],
  );
  if (!a) throw new AppError(404, "asset_not_found", "Asset not found.");
  return a;
}
async function manage(
  ctx: AppContext,
  a: StoredAsset,
  user: User,
  edit = false,
) {
  await ctx.requireOrgMember(user, a.org_id);
  if (user.id !== a.creator_id) await ctx.requireOrgAdmin(user, a.org_id);
  if (a.project_id)
    await ctx.requireProject(user, a.project_id, edit ? "write" : "read");
  else if (edit) await ctx.requireLibraryFull(user, a.org_id);
}
async function access(ctx: AppContext, a: StoredAsset, user?: User) {
  if (!a.published_version) {
    if (!user)
      throw new AppError(
        404,
        "asset_not_published",
        "This asset is not published.",
      );
    return manage(ctx, a, user);
  }
  if (a.visibility === "public") return;
  if (!user)
    throw new AppError(401, "unauthorized", "Sign in to view this asset.");
  if (a.visibility === "organization")
    await ctx.requireOrgMember(user, a.org_id);
  else if (a.project_id) await ctx.requireProject(user, a.project_id);
  else throw new AppError(404, "asset_not_found", "Asset not found.");
}
function visibility(
  value: unknown,
  projectId: string | null,
  fallback?: Asset["visibility"],
) {
  const v = value ?? fallback ?? (projectId ? "project" : "organization");
  if (
    !["project", "organization", "public"].includes(String(v)) ||
    (!projectId && v === "project")
  )
    throw new AppError(
      400,
      "invalid_visibility",
      "Choose a visibility available for this asset's owner.",
    );
  return v as Asset["visibility"];
}
async function content(
  ctx: AppContext,
  user: User,
  a: Asset,
  body: Record<string, unknown>,
  fallback: string,
) {
  let document = body.document;
  if (body.sourceFileId !== undefined) {
    if (document !== undefined)
      throw new AppError(400, "invalid_request", "Choose one content source.");
    const id = stringValue(body.sourceFileId, "content file");
    const auth = await authorizeFile(ctx, user, id, a.project_id ?? undefined);
    if (
      auth.row.org_id !== a.org_id ||
      (auth.row.project_id && auth.row.project_id !== a.project_id)
    )
      throw new AppError(
        403,
        "asset_source_scope",
        "Choose content belonging to this asset's workspace or library shares.",
      );
    const bytes = await readCurrentFile(ctx, user, id, {
      projectId: a.project_id ?? undefined,
      maxBytes: 256 * 1024,
    });
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new AppError(
        400,
        "invalid_content",
        "This file is not a supported asset definition.",
      );
    }
  }
  return document === undefined
    ? fallback
    : JSON.stringify(validateReport(document));
}
function revision(a: StoredAsset, body: Record<string, unknown>) {
  if (body.expectedRevision !== a.draft_revision) throw conflict();
}
export async function registerReports(app: FastifyInstance, ctx: AppContext) {
  await migrateAssets(ctx);
  const locks = new Map<string, Promise<unknown>>();
  async function locked<T>(id: string, fn: () => Promise<T>) {
    const task = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(id, task);
    try {
      return await task;
    } finally {
      if (locks.get(id) === task) locks.delete(id);
    }
  }
  async function dto(a: StoredAsset, user: User, detail = false) {
    let canManage = false,
      canEdit = false;
    try {
      await manage(ctx, a, user);
      canManage = true;
      await manage(ctx, a, user, true);
      canEdit = true;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
    const published = a.published_version
      ? await ctx.db.get<Version>(
          "SELECT * FROM asset_versions WHERE asset_id=? AND number=?",
          [a.id, a.published_version],
        )
      : undefined;
    return {
      id: a.id,
      orgId: a.org_id,
      projectId: a.project_id,
      createdBy: a.creator_id,
      name: canManage ? a.name : published!.name,
      description: canManage ? a.description : published!.description,
      type: "report",
      visibility: a.visibility,
      status: a.published_version ? "published" : "draft",
      url: `/enterprise/reports/${a.id}`,
      publishedVersion: a.published_version,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
      canManage,
      canEdit,
      ...(canManage && detail
        ? {
            document: JSON.parse(a.draft_document),
            revision: a.draft_revision,
            hasUnpublishedChanges:
              !published ||
              a.name !== published.name ||
              a.description !== published.description ||
              a.draft_document !== published.document,
            versions: await ctx.db.all(
              "SELECT number,name,created_at AS createdAt FROM asset_versions WHERE asset_id=? ORDER BY number DESC",
              [a.id],
            ),
          }
        : {}),
    };
  }
  app.get<{ Params: { orgId: string } }>(
    "/enterprise/api/organizations/:orgId/assets",
    async (req) => {
      const user = await ctx.requireUser(req);
      await ctx.requireOrgMember(user, req.params.orgId);
      const items = [];
      for (const a of await ctx.db.all<StoredAsset>(
        `SELECT r.* FROM reports r WHERE r.org_id=? AND r.deleted_at IS NULL AND ${activeProject} ORDER BY r.updated_at DESC`,
        [req.params.orgId],
      )) {
        try {
          await access(ctx, a, user);
          items.push(await dto(a, user));
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
        }
      }
      return { items };
    },
  );
  app.post<{ Params: { orgId: string } }>(
    "/enterprise/api/organizations/:orgId/assets",
    async (req, reply) => {
      const user = await ctx.requireUser(req),
        b = objectBody(req.body),
        orgId = req.params.orgId;
      await ctx.requireOrgMember(user, orgId);
      if (b.type !== undefined && b.type !== "report")
        throw new AppError(
          400,
          "invalid_type",
          "Assets use safe content, not executable applications.",
        );
      const projectId = b.projectId
        ? stringValue(b.projectId, "project")
        : null;
      if (projectId) {
        if (
          (await ctx.requireProject(user, projectId, "write")).orgId !== orgId
        )
          throw new AppError(404, "not_found", "Project not found.");
      } else await ctx.requireOrgAdmin(user, orgId);
      const time = new Date().toISOString();
      const a: StoredAsset = {
        id: randomUUID(),
        org_id: orgId,
        project_id: projectId,
        creator_id: user.id,
        name: stringValue(b.name, "name"),
        description:
          b.description === undefined
            ? ""
            : stringValue(b.description, "description", 2000, true),
        visibility: visibility(b.visibility, projectId),
        document: initial,
        draft_document: initial,
        draft_revision: 1,
        published_version: 0,
        created_at: time,
        updated_at: time,
      };
      a.draft_document = await content(ctx, user, a, b, initial);
      // Creation is private by default, including when initial content or public visibility is supplied.
      // Programmatic callers may explicitly request atomic creation and publication.
      if (b.publish === true && b.draft !== true) {
        a.document = a.draft_document;
        a.published_version = 1;
      }
      await renderReport(ctx, { ...a, document: a.draft_document });
      if (projectId) await ctx.requireProject(user, projectId, "write");
      else await ctx.requireOrgAdmin(user, orgId);
      await ctx.db.batch([
        {
          sql: "INSERT INTO reports(id,org_id,project_id,creator_id,name,description,visibility,document,draft_document,draft_revision,published_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
          params: [
            a.id,
            orgId,
            projectId,
            user.id,
            a.name,
            a.description,
            a.visibility,
            a.document,
            a.draft_document,
            1,
            a.published_version,
            time,
            time,
          ],
        },
        ...(a.published_version
          ? [
              {
                sql: "INSERT INTO asset_versions VALUES(?,?,?,?,?,?)",
                params: [a.id, 1, a.name, a.description, a.document, time],
              },
            ]
          : []),
      ]);
      await ctx.audit(user, orgId, "asset.created", a.id, {
        published: !!a.published_version,
      });
      return reply.code(201).send(await dto(a, user, true));
    },
  );
  app.get<{ Params: { assetId: string } }>(
    "/enterprise/api/assets/:assetId",
    async (req) => {
      const user = await ctx.requireUser(req),
        a = await get(ctx, req.params.assetId);
      await access(ctx, a, user);
      return dto(a, user, true);
    },
  );
  app.patch<{ Params: { assetId: string } }>(
    "/enterprise/api/assets/:assetId",
    (req) =>
      locked(req.params.assetId, async () => {
        const user = await ctx.requireUser(req),
          a = await get(ctx, req.params.assetId),
          b = objectBody(req.body);
        const editing =
          b.name !== undefined ||
          b.description !== undefined ||
          b.document !== undefined ||
          b.sourceFileId !== undefined;
        await manage(ctx, a, user, editing);
        if (editing) revision(a, b);
        const updated = {
          ...a,
          name: b.name === undefined ? a.name : stringValue(b.name, "name"),
          description:
            b.description === undefined
              ? a.description
              : stringValue(b.description, "description", 2000, true),
          visibility: visibility(b.visibility, a.project_id, a.visibility),
          draft_document: await content(ctx, user, a, b, a.draft_document),
          draft_revision: a.draft_revision + 1,
          updated_at: new Date().toISOString(),
        };
        if (editing)
          await renderReport(ctx, {
            ...updated,
            document: updated.draft_document,
          });
        await manage(ctx, a, user, editing);
        const result = await ctx.db.run(
          "UPDATE reports SET name=?,description=?,visibility=?,draft_document=?,draft_revision=?,updated_at=? WHERE id=? AND draft_revision=? AND deleted_at IS NULL",
          [
            updated.name,
            updated.description,
            updated.visibility,
            updated.draft_document,
            updated.draft_revision,
            updated.updated_at,
            a.id,
            a.draft_revision,
          ],
        );
        if (!result.changes) throw conflict();
        await ctx.audit(user, a.org_id, "asset.updated", a.id, {
          visibility: updated.visibility,
        });
        return dto(updated, user, true);
      }),
  );
  app.post<{ Params: { assetId: string } }>(
    "/enterprise/api/assets/:assetId/publish",
    (req) =>
      locked(req.params.assetId, async () => {
        const user = await ctx.requireUser(req),
          a = await get(ctx, req.params.assetId),
          b = objectBody(req.body);
        await manage(ctx, a, user, true);
        revision(a, b);
        const v = visibility(b.visibility, a.project_id, a.visibility),
          time = new Date().toISOString(),
          number = a.published_version + 1;
        await renderReport(ctx, { ...a, document: a.draft_document });
        await manage(ctx, a, user, true);
        await ctx.db.batch([
          {
            sql: "UPDATE reports SET document=draft_document,visibility=?,published_version=?,draft_revision=draft_revision+1,updated_at=? WHERE id=? AND draft_revision=? AND deleted_at IS NULL",
            params: [v, number, time, a.id, a.draft_revision],
            expectChanges: 1,
          },
          {
            sql: "INSERT INTO asset_versions VALUES(?,?,?,?,?,?)",
            params: [
              a.id,
              number,
              a.name,
              a.description,
              a.draft_document,
              time,
            ],
          },
        ]);
        await ctx.audit(user, a.org_id, "asset.published", a.id, {
          version: number,
          visibility: v,
        });
        return dto(await get(ctx, a.id), user, true);
      }),
  );
  app.post<{ Params: { assetId: string; number: string } }>(
    "/enterprise/api/assets/:assetId/versions/:number/restore",
    (req) =>
      locked(req.params.assetId, async () => {
        const user = await ctx.requireUser(req),
          a = await get(ctx, req.params.assetId),
          b = objectBody(req.body);
        await manage(ctx, a, user, true);
        revision(a, b);
        const v = await ctx.db.get<Version>(
          "SELECT * FROM asset_versions WHERE asset_id=? AND number=?",
          [a.id, Number(req.params.number)],
        );
        if (!v)
          throw new AppError(404, "version_not_found", "Version not found.");
        await renderReport(ctx, { ...a, name: v.name, document: v.document });
        await manage(ctx, a, user, true);
        const result = await ctx.db.run(
          "UPDATE reports SET name=?,description=?,draft_document=?,draft_revision=draft_revision+1,updated_at=? WHERE id=? AND draft_revision=? AND deleted_at IS NULL",
          [
            v.name,
            v.description,
            v.document,
            new Date().toISOString(),
            a.id,
            a.draft_revision,
          ],
        );
        if (!result.changes) throw conflict();
        return dto(await get(ctx, a.id), user, true);
      }),
  );
  app.delete<{ Params: { assetId: string } }>(
    "/enterprise/api/assets/:assetId",
    (req) =>
      locked(req.params.assetId, async () => {
        const user = await ctx.requireUser(req),
          a = await get(ctx, req.params.assetId);
        await manage(ctx, a, user);
        await ctx.db.run("UPDATE reports SET deleted_at=? WHERE id=?", [
          new Date().toISOString(),
          a.id,
        ]);
        return { ok: true };
      }),
  );
  const safe = { config: { safeReport: true } };
  app.get<{ Params: { assetId: string } }>(
    "/enterprise/reports/:assetId/preview",
    safe,
    async (req, reply) => {
      const user = await ctx.requireUser(req),
        a = await get(ctx, req.params.assetId);
      await manage(ctx, a, user);
      const html = await renderReport(ctx, {
        ...a,
        document: a.draft_document,
      });
      await manage(ctx, await get(ctx, a.id), user);
      headers(reply);
      return reply.type("text/html; charset=utf-8").send(html);
    },
  );
  async function published(
    id: string,
    req: Parameters<AppContext["requireUser"]>[0],
  ) {
    const a = await get(ctx, id);
    if (!a.published_version)
      throw new AppError(
        404,
        "asset_not_published",
        "This asset is not published.",
      );
    await access(
      ctx,
      a,
      a.visibility === "public" ? undefined : await ctx.requireUser(req),
    );
    const v = await ctx.db.get<Version>(
      "SELECT * FROM asset_versions WHERE asset_id=? AND number=?",
      [id, a.published_version],
    );
    if (!v)
      throw new AppError(
        404,
        "version_not_found",
        "Published version unavailable.",
      );
    return { ...a, name: v.name, document: v.document };
  }
  app.get<{ Params: { assetId: string } }>(
    "/enterprise/reports/:assetId",
    safe,
    async (req, reply) => {
      const a = await published(req.params.assetId, req),
        html = await renderReport(ctx, a);
      await published(a.id, req);
      headers(reply);
      return reply.type("text/html; charset=utf-8").send(html);
    },
  );
  app.get<{ Params: { assetId: string; index: string } }>(
    "/enterprise/reports/:assetId/images/:index",
    safe,
    async (req, reply) => {
      const a = await published(req.params.assetId, req);
      if (!/^(?:0|[1-9][0-9]?)$/.test(req.params.index))
        throw new AppError(404, "not_found", "Image not found.");
      const b = validateReport(JSON.parse(a.document)).blocks[
        Number(req.params.index)
      ];
      if (b?.type !== "image")
        throw new AppError(404, "not_found", "Image not found.");
      const bytes = await source(ctx, a, await creator(ctx, a), b.fileId);
      await published(a.id, req);
      headers(reply);
      return reply.type(imageType(bytes)).send(bytes);
    },
  );
}
