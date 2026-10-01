import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import {
  AppError,
  objectBody,
  stringValue,
  type AppContext,
} from "../context.js";
import { cleanPath, maxFileBytes } from "./paths.js";
import type { Access, Scope } from "./types.js";
import * as service from "./service.js";
export * from "./service.js";
export type { RuntimeMount, FileRecord, Scope } from "./types.js";

function scope(value: Record<string, unknown>): Scope {
  return {
    orgId: stringValue(value.orgId, "organization", 128),
    ...(value.projectId
      ? { projectId: stringValue(value.projectId, "project", 128) }
      : {}),
  };
}
function query(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function access(value: unknown): Access {
  if (value !== "read" && value !== "write")
    throw new AppError(
      400,
      "invalid_access",
      "Choose read-only or full access.",
    );
  return value;
}
function projectId(value: unknown): string | undefined {
  return value ? stringValue(value, "project", 128) : undefined;
}
function id(value: unknown): string {
  return stringValue(value, "file", 128);
}

export async function registerFiles(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  await service.initializeFiles(ctx);
  await app.register(multipart, {
    limits: { fileSize: maxFileBytes(ctx), files: 500, fields: 16, parts: 520 },
    throwFileSizeLimit: true,
  });
  app.get<{ Params: { orgId: string } }>(
    "/enterprise/api/organizations/:orgId/library/share-targets",
    async (request) => {
      const user = await ctx.requireUser(request);
      await ctx.requireLibraryFull(user, request.params.orgId);
      return {
        items: await ctx.db.all(
          "SELECT id,name FROM projects WHERE org_id=? AND status NOT IN ('deleted','deleting','purged') ORDER BY name",
          [request.params.orgId],
        ),
      };
    },
  );
  app.get("/enterprise/api/files", async (request) => {
    const user = await ctx.requireUser(request);
    const q = query(request.query);
    const destination = scope(q);
    const relative = cleanPath(q.path ?? "");
    return {
      items: await service.listFiles(ctx, user, destination, relative),
      access: await service.getDirectoryAccess(
        ctx,
        user,
        destination,
        relative,
      ),
    };
  });
  app.post("/enterprise/api/files/folders", async (request) => {
    const user = await ctx.requireUser(request);
    const body = objectBody(request.body);
    return service.createFolder(
      ctx,
      user,
      scope(body),
      cleanPath(body.path, false),
    );
  });
  app.post("/enterprise/api/files/upload", async (request, reply) => {
    const user = await ctx.requireUser(request);
    const fields: Record<string, unknown> = {};
    const files: { name: string; bytes: Buffer }[] = [];
    let total = 0;
    if (!request.isMultipart())
      throw new AppError(415, "multipart_required", "Choose files to upload.");
    for await (const part of request.parts()) {
      if (part.type === "field") {
        if (typeof part.value !== "string")
          throw new AppError(400, "invalid_upload", "Invalid upload field.");
        fields[part.fieldname] = part.value;
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          total += chunk.length;
          if (total > 128 * 1024 * 1024)
            throw new AppError(
              413,
              "upload_too_large",
              "Upload up to 128 MB at a time.",
            );
          chunks.push(chunk);
        }
        if (part.file.truncated)
          throw new AppError(
            413,
            "file_too_large",
            "A file exceeds the upload limit.",
          );
        files.push({ name: part.filename, bytes: Buffer.concat(chunks) });
      }
    }
    if (!files.length)
      throw new AppError(400, "empty_upload", "Choose at least one file.");
    let paths: string[] | undefined;
    if (fields.paths !== undefined) {
      try {
        const parsed: unknown = JSON.parse(String(fields.paths));
        if (
          !Array.isArray(parsed) ||
          parsed.length !== files.length ||
          parsed.some((p) => typeof p !== "string")
        )
          throw new Error();
        paths = parsed;
      } catch {
        throw new AppError(
          400,
          "invalid_paths",
          "Upload paths must match the selected files.",
        );
      }
    }
    const destination = scope(fields);
    const directory = cleanPath(fields.path ?? "");
    const names = files.map((file, index) =>
      cleanPath(paths?.[index] ?? file.name, false),
    );
    const fullPaths = names.map((name) =>
      directory ? `${directory}/${name}` : name,
    );
    fullPaths.forEach((p) => cleanPath(p, false));
    const items: unknown[] = [];
    const errors: { path: string; code: string; message: string }[] = [];
    for (let index = 0; index < files.length; index++) {
      try {
        items.push(
          await service.uploadFile(
            ctx,
            user,
            destination,
            fullPaths[index]!,
            files[index]!.bytes,
          ),
        );
      } catch (error) {
        if (error instanceof AppError)
          errors.push({
            path: fullPaths[index]!,
            code: error.code,
            message: error.message,
          });
        else throw error;
      }
    }
    if (errors.length) reply.code(items.length ? 207 : 400);
    return { items, errors };
  });
  app.patch<{ Params: { fileId: string } }>(
    "/enterprise/api/files/:fileId",
    async (request) => {
      const user = await ctx.requireUser(request);
      const body = objectBody(request.body);
      const q = query(request.query);
      const result = await service.renameFile(
        ctx,
        user,
        id(request.params.fileId),
        stringValue(body.name, "name", 240),
        projectId(q.projectId),
      );
      await ctx.onAccessChanged?.();
      return result;
    },
  );
  app.post<{ Params: { fileId: string } }>(
    "/enterprise/api/files/:fileId/transfer",
    async (request) => {
      const user = await ctx.requireUser(request);
      const body = objectBody(request.body);
      const destination = objectBody(body.destination);
      const q = query(request.query);
      if (body.operation !== "copy" && body.operation !== "move")
        throw new AppError(400, "invalid_operation", "Choose copy or move.");
      const result = await service.transferFile(
        ctx,
        user,
        id(request.params.fileId),
        { ...scope(destination), path: cleanPath(destination.path ?? "") },
        body.operation,
        projectId(q.projectId),
      );
      await ctx.onAccessChanged?.();
      return result;
    },
  );
  app.delete<{ Params: { fileId: string } }>(
    "/enterprise/api/files/:fileId",
    async (request, reply) => {
      await service.deleteFile(
        ctx,
        await ctx.requireUser(request),
        id(request.params.fileId),
        projectId(query(request.query).projectId),
      );
      await ctx.onAccessChanged?.();
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { fileId: string } }>(
    "/enterprise/api/files/:fileId/content",
    async (request, reply) => {
      const q = query(request.query);
      const file = await service.readFileVersion(
        ctx,
        await ctx.requireUser(request),
        id(request.params.fileId),
        {
          projectId: projectId(q.projectId),
          ...(q.versionId
            ? { versionId: stringValue(q.versionId, "version", 128) }
            : {}),
        },
      );
      reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", file.bytes.length)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, no-store")
        .header("X-File-Version", file.versionId)
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`,
        );
      return reply.send(file.bytes);
    },
  );
  app.get<{ Params: { fileId: string } }>(
    "/enterprise/api/files/:fileId/versions",
    async (request) => ({
      items: await service.fileVersions(
        ctx,
        await ctx.requireUser(request),
        id(request.params.fileId),
        projectId(query(request.query).projectId),
      ),
    }),
  );
  app.get<{ Params: { fileId: string } }>(
    "/enterprise/api/files/:fileId/shares",
    async (request) => ({
      items: await service.getShares(
        ctx,
        await ctx.requireUser(request),
        id(request.params.fileId),
      ),
    }),
  );
  app.post<{ Params: { fileId: string } }>(
    "/enterprise/api/files/:fileId/shares",
    async (request, reply) => {
      const body = objectBody(request.body);
      await service.shareFile(
        ctx,
        await ctx.requireUser(request),
        id(request.params.fileId),
        stringValue(body.projectId, "project", 128),
        access(body.access),
        body.name ? stringValue(body.name, "name", 240) : undefined,
      );
      await ctx.onAccessChanged?.();
      return reply.code(204).send();
    },
  );
  app.delete<{ Params: { fileId: string; projectId: string } }>(
    "/enterprise/api/files/:fileId/shares/:projectId",
    async (request, reply) => {
      await service.revokeShare(
        ctx,
        await ctx.requireUser(request),
        id(request.params.fileId),
        stringValue(request.params.projectId, "project", 128),
      );
      await ctx.onAccessChanged?.();
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { fileId: string } }>(
    "/enterprise/api/files/:fileId/grants",
    async (request) => ({
      items: await service.getGrants(
        ctx,
        await ctx.requireUser(request),
        id(request.params.fileId),
      ),
    }),
  );
  app.post<{ Params: { fileId: string } }>(
    "/enterprise/api/files/:fileId/grants",
    async (request, reply) => {
      const body = objectBody(request.body);
      await service.grantFile(
        ctx,
        await ctx.requireUser(request),
        id(request.params.fileId),
        stringValue(body.userId, "user", 128),
        access(body.access),
      );
      await ctx.onAccessChanged?.();
      return reply.code(204).send();
    },
  );
  app.delete<{ Params: { fileId: string; userId: string } }>(
    "/enterprise/api/files/:fileId/grants/:userId",
    async (request, reply) => {
      await service.revokeGrant(
        ctx,
        await ctx.requireUser(request),
        id(request.params.fileId),
        stringValue(request.params.userId, "user", 128),
      );
      await ctx.onAccessChanged?.();
      return reply.code(204).send();
    },
  );
}
export default registerFiles;
