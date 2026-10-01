import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { AppError, mapUser, type AppContext } from "../context.js";
import { resolveFileMount } from "../files/index.js";
import { getAsset, type VersionRow } from "./model.js";
import type { LibraryRuntimeHost } from "./runtime.js";

const hosts = new WeakMap<AppContext, LibraryRuntimeHost>();
export function setLibraryRuntime(ctx: AppContext, host: LibraryRuntimeHost) {
  hosts.set(ctx, host);
}
export function libraryRuntime(ctx: AppContext) {
  return hosts.get(ctx);
}
export async function verifyLibrarySources(ctx: AppContext, versionId: string) {
  const sources = await ctx.db.all<{
    file_id: string;
    user_id: string;
    project_id: string | null;
    source_path: string;
    source_device: string;
    source_inode: string;
  }>("SELECT * FROM library_sources WHERE version_id=?", [versionId]);
  for (const source of sources) {
    const row = await ctx.db.get<any>(
      "SELECT * FROM users WHERE id=? AND enabled=1",
      [source.user_id],
    );
    if (!row)
      throw new AppError(
        403,
        "source_access_revoked",
        "Access to a linked source has been revoked.",
      );
    const mount = await resolveFileMount(ctx, mapUser(row), {
      fileId: source.file_id,
      ...(source.project_id ? { projectId: source.project_id } : {}),
      mode: "read",
    });
    if (mount.source !== source.source_path)
      throw new AppError(
        409,
        "source_moved",
        "A linked source moved. Republish this application to update its mount.",
      );
    const stat = await lstat(mount.source, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.dev.toString() !== source.source_device ||
      stat.ino.toString() !== source.source_inode
    )
      throw new AppError(
        409,
        "source_replaced",
        "A linked folder was replaced. Republish this application to update its mount.",
      );
  }
}
export async function recheckLibrary(ctx: AppContext) {
  const host = hosts.get(ctx);
  if (!host) return;
  const versions = await ctx.db.all<VersionRow>(
    "SELECT * FROM library_versions WHERE runtime_id IS NOT NULL AND runtime_status IN (?,?)",
    ["running", "stop_failed"],
  );
  for (const v of versions) {
    let stop = v.runtime_status === "stop_failed";
    if (!stop) {
      try {
        await getAsset(ctx, v.asset_id);
        await verifyLibrarySources(ctx, v.id);
      } catch {
        stop = true;
      }
    }
    if (stop) {
      try {
        await host.stop(v.runtime_id!);
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
  const abandoned = await ctx.db.all<{ id: string; asset_id: string }>(
    "SELECT * FROM library_launches WHERE created_at<?",
    [new Date(Date.now() - 120_000).toISOString()],
  );
  for (const launch of abandoned) {
    if (
      await ctx.db.get("SELECT id FROM library_versions WHERE id=?", [
        launch.id,
      ])
    ) {
      await ctx.db.run("DELETE FROM library_launches WHERE id=?", [launch.id]);
      continue;
    }
    try {
      await host.stop(launch.id);
      await ctx.db.run("DELETE FROM library_launches WHERE id=?", [launch.id]);
      await rm(
        join(ctx.config.stateDir, "library", launch.asset_id, launch.id),
        { recursive: true, force: true },
      );
    } catch {
      /* Keep the durable cleanup record for retry after a supervisor outage. */
    }
  }
}

/** One bounded, explicitly fenced lifecycle attempt; never replay a lost attempt. */
export async function resumeLibraryVersion(
  ctx: AppContext,
  versionId: string,
  manual = false,
) {
  const v = await ctx.db.get<VersionRow>(
    "SELECT * FROM library_versions WHERE id=?",
    [versionId],
  );
  if (!v?.runtime_id)
    throw new AppError(
      404,
      "runtime_not_found",
      "Application runtime not found.",
    );
  const a = await getAsset(ctx, v.asset_id);
  if (a.type !== "live" || a.current_version_id !== v.id)
    throw new AppError(
      409,
      "version_conflict",
      "The published application changed. Refresh and retry.",
    );
  const host = hosts.get(ctx);
  if (!host?.resume)
    throw new AppError(
      503,
      "resume_unavailable",
      "Application recovery is not configured.",
    );
  if (v.runtime_status === "resuming")
    throw new AppError(
      409,
      "resume_in_progress",
      "Application recovery is already in progress.",
    );
  await verifyLibrarySources(ctx, v.id);
  const state = await host.status(v.runtime_id);
  if (!manual && state.status === "failed") {
    await ctx.db.run(
      "UPDATE library_versions SET runtime_status='needs_attention',runtime_error='application_failed' WHERE id=? AND runtime_status=?",
      [v.id, v.runtime_status],
    );
    return;
  }
  const admitted = await ctx.db.run(
    "UPDATE library_versions SET runtime_status='resuming',runtime_error=NULL WHERE id=? AND runtime_status=? AND EXISTS (SELECT 1 FROM library_assets WHERE id=? AND current_version_id=? AND deleted_at IS NULL)",
    [v.id, v.runtime_status, a.id, v.id],
  );
  if (!admitted.changes)
    throw new AppError(
      409,
      "version_conflict",
      "The application changed while recovery was starting.",
    );
  try {
    // Even an already-running container must attest this deployment's storage
    // roots. A restored database must never reconnect to the old host's data.
    // The supervisor's resume operation does not restart healthy containers.
    const resumed = await host.resume(v.runtime_id);
    if (resumed.id !== v.runtime_id || resumed.status !== "running")
      throw new Error("Application did not become ready");
    const latest = await getAsset(ctx, a.id);
    await verifyLibrarySources(ctx, v.id);
    if (latest.current_version_id !== v.id) {
      await host.stop(v.runtime_id);
      throw new AppError(
        409,
        "version_conflict",
        "A newer application version replaced this recovery.",
      );
    }
    const updated = await ctx.db.run(
      "UPDATE library_versions SET runtime_status='running',runtime_error=NULL WHERE id=? AND runtime_status='resuming' AND EXISTS (SELECT 1 FROM library_assets WHERE id=? AND current_version_id=? AND deleted_at IS NULL)",
      [v.id, a.id, v.id],
    );
    if (!updated.changes) {
      await host.stop(v.runtime_id);
      throw new AppError(
        409,
        "version_conflict",
        "The application changed while recovery was completing.",
      );
    }
  } catch (error) {
    if (error instanceof AppError && [403, 404, 409].includes(error.statusCode))
      await host.stop(v.runtime_id).catch(() => {});
    await ctx.db.run(
      "UPDATE library_versions SET runtime_status='needs_attention',runtime_error=? WHERE id=? AND runtime_status='resuming'",
      [error instanceof AppError ? error.code : "resume_failed", v.id],
    );
    if (error instanceof AppError) throw error;
    throw new AppError(
      503,
      "resume_failed",
      "The application could not resume. Check its runtime or republish the source.",
    );
  }
}

export async function recoverPublishedLibrary(ctx: AppContext) {
  if (!hosts.get(ctx)?.resume) return;
  await recheckLibrary(ctx);
  const versions = await ctx.db.all<VersionRow>(
    "SELECT v.* FROM library_versions v JOIN library_assets a ON a.current_version_id=v.id WHERE a.deleted_at IS NULL AND v.runtime_id IS NOT NULL AND v.runtime_status IN ('running','resuming')",
  );
  for (const v of versions) {
    if (v.runtime_status === "resuming") {
      await ctx.db.run(
        "UPDATE library_versions SET runtime_status='needs_attention',runtime_error='interrupted_recovery' WHERE id=? AND runtime_status='resuming'",
        [v.id],
      );
      continue;
    }
    try {
      await resumeLibraryVersion(ctx, v.id);
    } catch (error) {
      await ctx.db.run(
        "UPDATE library_versions SET runtime_status='needs_attention',runtime_error=? WHERE id=? AND runtime_status IN ('running','resuming')",
        [error instanceof AppError ? error.code : "recovery_unavailable", v.id],
      );
    }
  }
}
