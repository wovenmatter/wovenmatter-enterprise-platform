import { projectRuntimeSpec } from "./runtime.js";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { readdir, rm, mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { AppError, type AppContext, type User } from "../context.js";
import {
  scopeRoot,
  withLeaf,
  safeStat,
  readBytes,
  maxFileBytes,
  removeTree,
} from "../files/paths.js";
import { createFolder, uploadFile } from "../files/service.js";
import { locked } from "../files/storage.js";
const locks = new WeakMap<AppContext, Map<string, Promise<unknown>>>();
export function requireProjectRuntime(
  ctx: AppContext,
  operation: "stopProject" | "restoreProject" | "purgeProject",
) {
  const method = ctx.runtime?.[operation];
  if (!method)
    throw new AppError(
      503,
      "runtime_unavailable",
      "Project runtime lifecycle is unavailable. Recovery data has been retained.",
    );
  return method.bind(ctx.runtime!);
}
export function withProjectLifecycle<T>(
  ctx: AppContext,
  id: string,
  work: () => Promise<T>,
) {
  let entries = locks.get(ctx);
  if (!entries) {
    entries = new Map();
    locks.set(ctx, entries);
  }
  const result = (entries.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(work);
  entries.set(id, result);
  void result
    .finally(() => {
      if (entries!.get(id) === result) entries!.delete(id);
    })
    .catch(() => {});
  return result;
}
async function deleted(ctx: AppContext, user: User, id: string) {
  const row = await ctx.db.get<any>(
    "SELECT * FROM projects WHERE id=? AND status IN ('deleted','deleting')",
    [id],
  );
  if (!row) throw new AppError(404, "not_found", "Deleted project not found.");
  await ctx.requireOrgAdmin(user, row.org_id);
  return row;
}
function unexpired(row: any) {
  if (!row.purge_after || row.purge_after <= new Date().toISOString())
    throw new AppError(
      410,
      "trash_expired",
      "This project's recovery period has expired.",
    );
}
function spec(row: any) {
  return {
    projectId: row.id,
    organizationId: row.org_id,
    hostId: row.host_id,
  };
}
/** Called only after expiry and confirmed runtime removal. Mutable tree deletion uses
 * unlink/rm which do not follow symlinks; the trusted parent itself must be canonical. */
export async function purgeExpiredProject(ctx: AppContext, id: string) {
  return withProjectLifecycle(ctx, id, async () => {
    const row = await ctx.db.get<any>(
      "SELECT * FROM projects WHERE id=? AND status IN ('deleted','deleting') AND purge_after<=?",
      [id, new Date().toISOString()],
    );
    if (!row) return false;
    const stop = requireProjectRuntime(ctx, "stopProject"),
      purge = requireProjectRuntime(ctx, "purgeProject");
    await stop(spec(row));
    await purge(spec(row));
    await locked(ctx, async () => {
      for (const [parent, name] of [
        [join(ctx.config.stateDir, "workspaces", "projects"), row.id],
        [join(ctx.config.stateDir, "agent-sessions", row.org_id), row.id],
      ]) {
        await mkdir(parent, {
          recursive: true,
          mode: 0o700,
        });
        const stat = await lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new AppError(
            409,
            "unsafe_path",
            "Recovery storage is unavailable.",
          );
        try {
          await removeTree(parent, name);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      const hashes = await ctx.db.all<{
        hash: string;
      }>(
        "SELECT DISTINCT hash FROM workspace_file_versions WHERE file_id IN (SELECT id FROM workspace_files WHERE project_id=?)",
        [id],
      );
      await ctx.db.batch([
        {
          sql: "DELETE FROM workspace_file_shares WHERE project_id=? OR file_id IN (SELECT id FROM workspace_files WHERE project_id=?)",
          params: [id, id],
        },
        {
          sql: "DELETE FROM workspace_file_grants WHERE file_id IN (SELECT id FROM workspace_files WHERE project_id=?)",
          params: [id],
        },
        {
          sql: "DELETE FROM workspace_file_versions WHERE file_id IN (SELECT id FROM workspace_files WHERE project_id=?)",
          params: [id],
        },
        {
          sql: "DELETE FROM workspace_files WHERE project_id=?",
          params: [id],
        },
        {
          sql: "DELETE FROM reports WHERE project_id=?",
          params: [id],
        },
        {
          sql: "DELETE FROM conversation_run_sources WHERE run_id IN (SELECT id FROM conversation_runs WHERE project_id=?)",
          params: [id],
        },
        {
          sql: "UPDATE conversation_runs SET native_session_id=NULL,error_message=NULL WHERE project_id=?",
          params: [id],
        },
        {
          sql: "DELETE FROM project_egress_capabilities WHERE project_id=?",
          params: [id],
        },
        {
          sql: "UPDATE conversation_messages SET content='',citations='[]' WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id=?)",
          params: [id],
        },
        {
          sql: "DELETE FROM conversation_events WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id=?)",
          params: [id],
        },
        {
          sql: "UPDATE conversations SET title='Deleted thread',deleted_at=? WHERE project_id=?",
          params: [new Date().toISOString(), id],
        },
        {
          sql: "DELETE FROM project_members WHERE project_id=?",
          params: [id],
        },
        {
          sql: "UPDATE projects SET status='purged',name='Deleted project',description='' WHERE id=?",
          params: [id],
        },
      ]);
      for (const { hash } of hashes)
        if (
          /^[a-f0-9]{64}$/.test(hash) &&
          !(await ctx.db.get(
            "SELECT id FROM workspace_file_versions WHERE hash=? LIMIT 1",
            [hash],
          ))
        )
          await rm(join(ctx.config.stateDir, "file-versions", hash), {
            force: true,
          });
    });
    return true;
  });
}
export async function registerTrash(app: FastifyInstance, ctx: AppContext) {
  app.get<{
    Params: {
      orgId: string;
    };
  }>("/enterprise/api/organizations/:orgId/deleted-projects", async (req) => {
    const user = await ctx.requireUser(req);
    await ctx.requireOrgAdmin(user, req.params.orgId);
    return {
      items: await ctx.db.all(
        "SELECT id,name,description,host_id AS hostId,status,deleted_at AS deletedAt,purge_after AS purgeAfter FROM projects WHERE org_id=? AND status IN ('deleted','deleting') ORDER BY deleted_at DESC",
        [req.params.orgId],
      ),
    };
  });
  app.post<{
    Params: {
      projectId: string;
    };
  }>("/enterprise/api/deleted-projects/:projectId/restore", async (req) =>
    withProjectLifecycle(ctx, req.params.projectId, async () => {
      const user = await ctx.requireUser(req),
        row = await deleted(ctx, user, req.params.projectId);
      unexpired(row);
      const restore = requireProjectRuntime(ctx, "restoreProject");
      // A previous deletion may have lost its stop acknowledgment. Confirm it
      // before restoring access so an old execution cannot survive the deletion.
      await requireProjectRuntime(ctx, "stopProject")(spec(row));
      await restore(await projectRuntimeSpec(ctx, row.id));
      await ctx.db.batch([
        {
          sql: "UPDATE jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE project_id=? AND type='project.remove' AND status IN ('pending','running','needs_attention')",
          params: [row.id],
        },
        {
          sql: "UPDATE projects SET status='ready',deleted_at=NULL,purge_after=NULL WHERE id=? AND status IN ('deleted','deleting')",
          params: [row.id],
          expectChanges: 1,
        },
      ]);
      await ctx.audit(user, row.org_id, "project.restored", row.id);
      return {
        ok: true,
      };
    }),
  );
  app.post<{
    Params: {
      projectId: string;
    };
  }>("/enterprise/api/deleted-projects/:projectId/recover-files", async (req) =>
    withProjectLifecycle(ctx, req.params.projectId, async () => {
      const user = await ctx.requireUser(req),
        row = await deleted(ctx, user, req.params.projectId);
      unexpired(row);
      await requireProjectRuntime(ctx, "stopProject")(spec(row));
      const root = scopeRoot(ctx, {
          orgId: row.org_id,
          projectId: row.id,
        }),
        destination = `Recovered ${row.name.slice(0, 80).replace(/[\\/\x00-\x1f]/g, "_")} ${randomUUID().slice(0, 8)}`;
      const scope = {
        orgId: row.org_id,
      };
      await createFolder(ctx, user, scope, destination);
      const shares = new Set(
        (
          await ctx.db.all<{
            name: string;
          }>("SELECT name FROM workspace_file_shares WHERE project_id=?", [
            row.id,
          ])
        ).map((s) => s.name),
      );
      let count = 0,
        bytes = 0;
      async function copy(relative: string) {
        const names = await withLeaf(root, relative, (leaf) => readdir(leaf));
        for (const name of names) {
          if (!relative && shares.has(name)) continue;
          if (++count > 20000)
            throw new AppError(
              413,
              "recovery_limit",
              "Recover fewer files at a time.",
            );
          const path = relative ? `${relative}/${name}` : name,
            stat = await safeStat(root, path),
            target = `${destination}/${path}`;
          if (stat.isDirectory()) {
            await createFolder(ctx, user, scope, target);
            await copy(path);
          } else if (stat.isFile()) {
            const data = await readBytes(root, path, maxFileBytes(ctx));
            bytes += data.length;
            if (bytes > 1024 ** 3)
              throw new AppError(
                413,
                "recovery_limit",
                "Recovery exceeds the 1 GiB request limit.",
              );
            await uploadFile(ctx, user, scope, target, data);
          } else
            throw new AppError(
              409,
              "unsafe_path",
              "Only ordinary files and folders can be recovered.",
            );
        }
      }
      try {
        await copy("");
      } catch (error) {
        const reason =
          error instanceof AppError
            ? error
            : new AppError(
                500,
                "recovery_failed",
                "File recovery could not finish.",
              );
        throw new AppError(
          reason.statusCode,
          reason.code,
          `${reason.message} Files already recovered remain in Library / ${destination}.`,
        );
      }
      await ctx.audit(user, row.org_id, "project.files_recovered", row.id, {
        count,
      });
      return {
        ok: true,
        path: destination,
        count,
      };
    }),
  );
  app.post<{
    Params: {
      projectId: string;
    };
  }>("/enterprise/api/deleted-projects/:projectId/purge", async (req) => {
    const user = await ctx.requireUser(req),
      row = await deleted(ctx, user, req.params.projectId);
    if (row.purge_after > new Date().toISOString())
      throw new AppError(
        409,
        "retention_active",
        "Projects remain recoverable for 30 days.",
      );
    await purgeExpiredProject(ctx, row.id);
    await ctx.audit(user, row.org_id, "project.purged", row.id);
    return {
      ok: true,
    };
  });
}
