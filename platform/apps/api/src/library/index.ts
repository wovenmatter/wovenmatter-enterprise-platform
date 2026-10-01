import type { FastifyInstance } from "fastify";
import { mkdir, writeFile, rm, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { AppError, type AppContext } from "../context.js";
import { snapshotFileTree, resolveFileMount } from "../files/index.js";
import { registerContent, assetOrigin } from "./serving.js";
import {
  access,
  assetDto,
  bodyObject,
  getAsset,
  hash,
  identifier,
  migrateLibrary,
  organizationHostnameSlug,
  now,
  safePath,
  shareDto,
  textValue,
  uuid,
  versionDto,
  type AssetRow,
  type VersionRow,
  type ShareRow,
} from "./model.js";
import {
  libraryRuntime,
  recheckLibrary,
  resumeLibraryVersion,
  recoverPublishedLibrary,
} from "./lifecycle.js";
export {
  setLibraryRuntime,
  recheckLibrary,
  resumeLibraryVersion,
  recoverPublishedLibrary,
  verifyLibrarySources,
} from "./lifecycle.js";
export type { LibraryRuntimeHost } from "./runtime.js";

export async function registerLibrary(app: FastifyInstance, ctx: AppContext) {
  await migrateLibrary(ctx);
  app.addHook("onReady", async () => recoverPublishedLibrary(ctx));
  let checking = false;
  const recheckTimer = setInterval(() => {
    if (!checking) {
      checking = true;
      void recheckLibrary(ctx)
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    }
  }, 2000);
  recheckTimer.unref();
  app.addHook("onClose", async () => clearInterval(recheckTimer));
  app.get<{ Params: { orgId: string }; Querystring: { projectId?: string } }>(
    "/api/organizations/:orgId/assets",
    async (req) => {
      const user = await ctx.requireUser(req),
        orgId = identifier(req.params.orgId);
      await ctx.requireOrgMember(user, orgId);
      const rows = await ctx.db.all<AssetRow>(
        "SELECT * FROM library_assets WHERE org_id=? AND deleted_at IS NULL ORDER BY updated_at DESC",
        [orgId],
      );
      const items = [];
      for (const a of rows) {
        if (req.query.projectId && a.project_id !== req.query.projectId)
          continue;
        try {
          await access(ctx, user, a);
          items.push(assetDto(a));
        } catch (e) {
          if (!(e instanceof AppError) || ![403, 404].includes(e.statusCode))
            throw e;
        }
      }
      return { items };
    },
  );
  app.post<{ Params: { orgId: string } }>(
    "/api/organizations/:orgId/assets",
    async (req, reply) => {
      const user = await ctx.requireUser(req),
        orgId = identifier(req.params.orgId),
        body = bodyObject(req.body);
      await ctx.requireOrgMember(user, orgId);
      const projectId = body.projectId ? identifier(body.projectId) : null;
      if (projectId) {
        const p = await ctx.requireProject(user, projectId, "write");
        if (p.orgId !== orgId)
          throw new AppError(404, "project_not_found", "Project not found.");
      } else await ctx.requireOrgAdmin(user, orgId);
      if (body.type !== "static" && body.type !== "live")
        throw new AppError(400, "invalid_type", "Choose static or live.");
      const org = await ctx.db.get<{name: string}>("SELECT name FROM organizations WHERE id=?", [orgId]);
      const id = uuid(),
        time = now();
      await ctx.db.run(
        "INSERT INTO library_assets (id,org_id,project_id,name,description,type,created_at,updated_at,hostname_slug) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          id,
          orgId,
          projectId,
          textValue(body.name, 200),
          body.description === undefined || body.description === ""
            ? ""
            : textValue(body.description, 2000),
          body.type,
          time,
          time,
          organizationHostnameSlug(org!.name),
        ],
      );
      await ctx.audit(user, "library.create", id);
      return reply.code(201).send(assetDto(await getAsset(ctx, id)));
    },
  );
  app.post<{ Params: { assetId: string } }>(
    "/api/assets/:assetId/resume",
    async (req) => {
      const user = await ctx.requireUser(req),
        asset = await getAsset(ctx, identifier(req.params.assetId));
      await access(ctx, user, asset, true);
      const body = bodyObject(req.body);
      if (
        !asset.current_version_id ||
        body.expectedVersionId !== asset.current_version_id
      )
        throw new AppError(
          409,
          "version_conflict",
          "Refresh the current application before retrying.",
        );
      await resumeLibraryVersion(ctx, asset.current_version_id, true);
      await ctx.audit(user, "library.resume", asset.id, {
        versionId: asset.current_version_id,
      });
      return {
        asset: assetDto(await getAsset(ctx, asset.id)),
        version: versionDto(
          (await ctx.db.get<VersionRow>(
            "SELECT * FROM library_versions WHERE id=?",
            [asset.current_version_id],
          ))!,
        ),
      };
    },
  );
  app.get<{ Params: { assetId: string } }>(
    "/api/assets/:assetId",
    async (req) => {
      const user = await ctx.requireUser(req),
        a = await getAsset(ctx, identifier(req.params.assetId));
      await access(ctx, user, a);
      const versions = await ctx.db.all<VersionRow>(
        "SELECT * FROM library_versions WHERE asset_id=? ORDER BY number DESC",
        [a.id],
      );
      return { ...assetDto(a), versions: versions.map(versionDto) };
    },
  );
  app.patch<{ Params: { assetId: string } }>(
    "/api/assets/:assetId",
    async (req) => {
      const user = await ctx.requireUser(req),
        a = await getAsset(ctx, identifier(req.params.assetId));
      await access(ctx, user, a, true);
      const b = bodyObject(req.body);
      await ctx.db.run(
        "UPDATE library_assets SET name=?,description=?,updated_at=? WHERE id=?",
        [
          b.name === undefined ? a.name : textValue(b.name, 200),
          b.description === undefined
            ? a.description
            : b.description === ""
              ? ""
              : textValue(b.description, 2000),
          now(),
          a.id,
        ],
      );
      await ctx.audit(user, "library.update", a.id);
      return assetDto(await getAsset(ctx, a.id));
    },
  );
  app.delete<{ Params: { assetId: string } }>(
    "/api/assets/:assetId",
    async (req) => {
      const user = await ctx.requireUser(req),
        a = await getAsset(ctx, identifier(req.params.assetId));
      await access(ctx, user, a, true);
      await ctx.db.batch([
        {
          sql: "UPDATE library_assets SET deleted_at=?,updated_at=? WHERE id=?",
          params: [now(), now(), a.id],
        },
        {
          sql: "UPDATE library_shares SET revoked_at=? WHERE asset_id=? AND revoked_at IS NULL",
          params: [now(), a.id],
        },
      ]);
      await ctx.audit(user, "library.delete", a.id);
      const versions = await ctx.db.all<VersionRow>(
        "SELECT * FROM library_versions WHERE asset_id=? AND runtime_id IS NOT NULL",
        [a.id],
      );
      const host = libraryRuntime(ctx);
      for (const v of versions) {
        if (host && v.runtime_id) {
          try {
            await host.stop(v.runtime_id);
            await ctx.db.run(
              "UPDATE library_versions SET runtime_status=? WHERE id=?",
              ["stopped", v.id],
            );
          } catch {
            await ctx.db.run(
              "UPDATE library_versions SET runtime_status=? WHERE id=?",
              ["stop_failed", v.id],
            );
          }
        }
      }
      return { ok: true };
    },
  );
  app.post<{ Params: { assetId: string } }>(
    "/api/assets/:assetId/publish",
    { bodyLimit: 46 * 1024 * 1024 },
    async (req, reply) => {
      const user = await ctx.requireUser(req),
        a = await getAsset(ctx, identifier(req.params.assetId));
      await access(ctx, user, a, true);
      const b = bodyObject(req.body);
      if (
        b.expectedVersionId !== null &&
        typeof b.expectedVersionId !== "string"
      )
        throw new AppError(
          400,
          "version_required",
          "expectedVersionId is required (null for first publication).",
        );
      if (b.expectedVersionId !== a.current_version_id)
        throw new AppError(
          409,
          "version_conflict",
          "Another version was published. Refresh before publishing.",
        );
      if (!!b.sourceFileId === !!b.files)
        throw new AppError(
          400,
          "invalid_source",
          "Provide sourceFileId or files.",
        );
      let sourceVersionId: string | null = null,
        files: { path: string; bytes: Buffer }[];
      if (b.sourceFileId) {
        const snapshot = await snapshotFileTree(ctx, user, {
          fileId: identifier(b.sourceFileId),
          ...(b.sourceVersionId
            ? { versionId: identifier(b.sourceVersionId) }
            : {}),
          ...(a.project_id ? { projectId: a.project_id } : {}),
        });
        if (snapshot.orgId !== a.org_id)
          throw new AppError(
            403,
            "source_org_mismatch",
            "Copy the source into this organization before publishing it.",
          );
        sourceVersionId = snapshot.sourceVersionId;
        files = snapshot.files;
      } else {
        if (!Array.isArray(b.files) || !b.files.length || b.files.length > 1000)
          throw new AppError(
            400,
            "invalid_files",
            "Provide 1–1000 asset files.",
          );
        files = b.files.map((v: unknown) => {
          const f = bodyObject(v);
          if (
            typeof f.contentBase64 !== "string" ||
            !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              f.contentBase64,
            )
          )
            throw new AppError(
              400,
              "invalid_content",
              "File contents must be base64.",
            );
          return {
            path: safePath(f.path),
            bytes: Buffer.from(f.contentBase64, "base64"),
          };
        });
      }
      if (
        !files.length ||
        files.length > 1000 ||
        files.reduce((n, f) => n + f.bytes.length, 0) > 32 * 1024 * 1024
      )
        throw new AppError(
          413,
          "asset_too_large",
          "Assets are limited to 1000 files and 32 MiB.",
        );
      const seen = new Set<string>();
      for (const f of files) {
        f.path = safePath(f.path);
        if (seen.has(f.path))
          throw new AppError(400, "duplicate_path", "Duplicate asset path.");
        seen.add(f.path);
      }
      const entrypoint = safePath(
        b.entrypoint ?? (a.type === "static" ? "index.html" : "server.mjs"),
      );
      if (!seen.has(entrypoint))
        throw new AppError(
          400,
          "missing_entrypoint",
          "Entrypoint is missing from the bundle.",
        );
      if (a.type === "live" && !/\.(?:js|mjs|cjs)$/.test(entrypoint))
        throw new AppError(
          400,
          "invalid_entrypoint",
          "Live assets require a Node.js entrypoint.",
        );
      const origin = await assetOrigin(ctx, a.id),
        host = libraryRuntime(ctx);
      if (a.type === "live" && !host)
        throw new AppError(
          503,
          "runtime_unavailable",
          "Live application hosting is not configured.",
        );
      if (
        b.dataFileIds !== undefined &&
        (!Array.isArray(b.dataFileIds) ||
          b.dataFileIds.length > 30 ||
          a.type !== "live")
      )
        throw new AppError(
          400,
          "invalid_sources",
          "Only live assets may have up to 30 linked data sources.",
        );
      const dataMounts = [];
      for (const fileId of [...new Set((b.dataFileIds ?? []) as unknown[])]) {
        const mount = await resolveFileMount(ctx, user, {
          fileId: identifier(fileId),
          ...(a.project_id ? { projectId: a.project_id } : {}),
          mode: "read",
        });
        if (mount.orgId !== a.org_id)
          throw new AppError(
            403,
            "source_org_mismatch",
            "Linked data must belong to this organization.",
          );
        const stat = await lstat(mount.source, { bigint: true });
        if (!stat.isDirectory())
          throw new AppError(
            400,
            "data_folder_required",
            "Select a linked data folder so file replacements remain visible to the live application.",
          );
        dataMounts.push({
          source: mount.source,
          target: `/sources/${identifier(fileId)}`,
          readOnly: true as const,
          expectedDevice: stat.dev.toString(),
          expectedInode: stat.ino.toString(),
        });
      }
      const id = uuid(),
        versionNumber = (await ctx.db.get<{ n: number }>(
          "SELECT COALESCE(MAX(number),0)+1 AS n FROM library_versions WHERE asset_id=?",
          [a.id],
        ))!.n;
      const dir = join(ctx.config.stateDir, "library", a.id, id),
        manifest = files
          .map((f) => ({
            path: f.path,
            size: f.bytes.length,
            sha256: hash(f.bytes),
          }))
          .sort((x, y) => x.path.localeCompare(y.path)),
        manifestHash = hash(JSON.stringify(manifest));
      let runtimeId: string | null = null,
        committed = false;
      try {
        await mkdir(dir, { recursive: true, mode: 0o750 });
        for (const f of files) {
          const path = join(dir, f.path);
          await mkdir(dirname(path), { recursive: true, mode: 0o750 });
          await writeFile(path, f.bytes, { mode: 0o440, flag: "wx" });
        }
        await writeFile(
          join(dir, ".wme-manifest.json"),
          JSON.stringify(manifest),
          { mode: 0o440, flag: "wx" },
        );
        if (a.type === "live") {
          await ctx.db.run(
            "INSERT INTO library_launches (id,asset_id,created_at) VALUES (?,?,?)",
            [id, a.id, now()],
          );
          runtimeId = id;
          const started = await host!.start({
            assetId: a.id,
            orgId: a.org_id,
            projectId: a.project_id,
            versionId: id,
            sourceDir: dir,
            entrypoint,
            publicOrigin: origin,
            dataMounts,
          });
          if (started.id !== id || started.status !== "running")
            throw new AppError(
              503,
              "runtime_failed",
              "The application did not become ready.",
            );
        }
        // Recheck permissions after asynchronous source copying and runtime startup, before publishing.
        await access(ctx, user, await getAsset(ctx, a.id), true);
        for (const selected of dataMounts) {
          const current = await resolveFileMount(ctx, user, {
            fileId: selected.target.slice("/sources/".length),
            ...(a.project_id ? { projectId: a.project_id } : {}),
            mode: "read",
          });
          const stat = await lstat(current.source, { bigint: true });
          if (
            current.source !== selected.source ||
            stat.dev.toString() !== selected.expectedDevice ||
            stat.ino.toString() !== selected.expectedInode
          )
            throw new AppError(
              409,
              "source_changed",
              "A linked data folder changed while publishing. Refresh and retry.",
            );
        }
        await ctx.db.batch([
          {
            sql: "INSERT INTO library_versions (id,asset_id,number,entrypoint,manifest_hash,source_file_id,source_version_id,runtime_id,runtime_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            params: [
              id,
              a.id,
              versionNumber,
              entrypoint,
              manifestHash,
              b.sourceFileId ? String(b.sourceFileId) : null,
              sourceVersionId,
              runtimeId,
              a.type === "live" ? "running" : "static",
              now(),
            ],
          },
          {
            sql: "UPDATE library_assets SET current_version_id=?,updated_at=? WHERE id=? AND deleted_at IS NULL AND current_version_id IS ?",
            params: [id, now(), a.id, a.current_version_id],
            expectChanges: 1,
          },
          ...dataMounts.map((m) => ({
            sql: "INSERT INTO library_sources (version_id,file_id,user_id,project_id,source_path,source_device,source_inode) VALUES (?,?,?,?,?,?,?)",
            params: [
              id,
              m.target.slice("/sources/".length),
              user.id,
              a.project_id,
              m.source,
              m.expectedDevice,
              m.expectedInode,
            ],
          })),
          { sql: "DELETE FROM library_launches WHERE id=?", params: [id] },
        ]);
        committed = true;
      } catch (e) {
        if (runtimeId) {
          try {
            await host!.stop(runtimeId);
            await ctx.db.run("DELETE FROM library_launches WHERE id=?", [id]);
          } catch {
            /* Reconciler retries the persisted cleanup intent. */
          }
        }
        await rm(dir, { recursive: true, force: true });
        if (e instanceof AppError) throw e;
        if (
          (e as Error).message?.match(
            /UNIQUE|expect|changes|transaction|conflict/i,
          )
        )
          throw new AppError(
            409,
            "version_conflict",
            "Another publication changed this asset. Refresh and retry.",
          );
        throw new AppError(
          503,
          "publication_failed",
          "Publication could not be completed. Check runtime availability and the application entrypoint.",
        );
      }
      if (committed && a.type === "live" && a.current_version_id) {
        const previous = await ctx.db.get<VersionRow>(
          "SELECT * FROM library_versions WHERE id=?",
          [a.current_version_id],
        );
        if (previous?.runtime_id) {
          try {
            await host!.stop(previous.runtime_id);
            await ctx.db.run(
              "UPDATE library_versions SET runtime_status=? WHERE id=?",
              ["stopped", previous.id],
            );
          } catch {
            await ctx.db.run(
              "UPDATE library_versions SET runtime_status=? WHERE id=?",
              ["stop_failed", previous.id],
            );
          }
        }
      }
      await ctx.audit(user, "library.publish", a.id, { versionId: id });
      const version = await ctx.db.get<VersionRow>(
        "SELECT * FROM library_versions WHERE id=?",
        [id],
      );
      return reply.code(201).send({
        asset: assetDto(await getAsset(ctx, a.id)),
        version: versionDto(version!),
      });
    },
  );
  app.get<{ Params: { assetId: string } }>(
    "/api/assets/:assetId/shares",
    async (req) => {
      const user = await ctx.requireUser(req),
        a = await getAsset(ctx, identifier(req.params.assetId));
      await access(ctx, user, a, true);
      return {
        items: (
          await ctx.db.all<ShareRow>(
            "SELECT * FROM library_shares WHERE asset_id=? ORDER BY created_at DESC",
            [a.id],
          )
        ).map(shareDto),
      };
    },
  );
  app.post<{ Params: { assetId: string } }>(
    "/api/assets/:assetId/shares",
    async (req, reply) => {
      const user = await ctx.requireUser(req),
        a = await getAsset(ctx, identifier(req.params.assetId));
      await access(ctx, user, a, true);
      const b = bodyObject(req.body);
      if (!["public", "organization", "people"].includes(String(b.visibility)))
        throw new AppError(
          400,
          "invalid_visibility",
          "Choose public, organization, or people.",
        );
      if (!a.current_version_id)
        throw new AppError(
          409,
          "not_published",
          "Publish this asset before sharing it.",
        );
      await assetOrigin(ctx, a.id);
      const ids = b.userIds === undefined ? [] : b.userIds;
      if (!Array.isArray(ids) || ids.length > 1000)
        throw new AppError(400, "invalid_people", "Invalid people selection.");
      const userIds = [...new Set(ids.map(identifier))];
      if (b.visibility === "people" && !userIds.length)
        throw new AppError(
          400,
          "invalid_people",
          "Select at least one person.",
        );
      if (b.visibility !== "people" && userIds.length)
        throw new AppError(
          400,
          "invalid_people",
          "People are only valid for selected-person links.",
        );
      for (const id of userIds) {
        if (
          !(await ctx.db.get(
            "SELECT id FROM users WHERE id=? AND org_id=? AND enabled=1",
            [id, a.org_id],
          ))
        )
          throw new AppError(
            400,
            "invalid_people",
            "All selected people must be active organization members.",
          );
      }
      if (a.type === "live" && b.versionId)
        throw new AppError(
          400,
          "invalid_version",
          "Live links follow the current application version.",
        );
      const versionId =
        a.type === "live"
          ? null
          : b.versionId
            ? identifier(b.versionId)
            : a.current_version_id;
      if (
        versionId &&
        !(await ctx.db.get(
          "SELECT id FROM library_versions WHERE id=? AND asset_id=?",
          [versionId, a.id],
        ))
      )
        throw new AppError(
          400,
          "invalid_version",
          "The version does not belong to this asset.",
        );
      const id = uuid(),
        token = randomBytes(32).toString("base64url");
      await ctx.db.run(
        "INSERT INTO library_shares (id,asset_id,version_id,token_hash,visibility,user_ids,created_at) VALUES (?,?,?,?,?,?,?)",
        [
          id,
          a.id,
          versionId,
          hash(token),
          String(b.visibility),
          JSON.stringify(userIds),
          now(),
        ],
      );
      await ctx.audit(user, "library.share", a.id, {
        visibility: b.visibility,
        shareId: id,
      });
      const share = (await ctx.db.get<ShareRow>(
        "SELECT * FROM library_shares WHERE id=?",
        [id],
      ))!;
      return reply.code(201).send({
        share: shareDto(share),
        url: `${ctx.config.publicOrigin}/share/${token}`,
      });
    },
  );
  app.delete<{ Params: { assetId: string; shareId: string } }>(
    "/api/assets/:assetId/shares/:shareId",
    async (req) => {
      const user = await ctx.requireUser(req),
        a = await getAsset(ctx, identifier(req.params.assetId));
      await access(ctx, user, a, true);
      const result = await ctx.db.run(
        "UPDATE library_shares SET revoked_at=? WHERE id=? AND asset_id=? AND revoked_at IS NULL",
        [now(), identifier(req.params.shareId), a.id],
      );
      if (!result.changes)
        throw new AppError(404, "share_not_found", "Share not found.");
      await ctx.audit(user, "library.unshare", a.id, {
        shareId: req.params.shareId,
      });
      return { ok: true };
    },
  );
  await registerContent(app, ctx, () => libraryRuntime(ctx));
}
export default registerLibrary;
