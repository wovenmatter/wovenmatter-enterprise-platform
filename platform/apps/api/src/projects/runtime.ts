import type { AppContext } from "../context.js";
import { resolveScheduledMounts } from "../files/sharing.js";
import type { ProjectRuntimeSpec } from "../../../../packages/runtime/src/types.js";
/** Trusted project policy, never populated from workspace files or browser paths. */
export async function projectRuntimeSpec(
  ctx: AppContext,
  id: string,
): Promise<ProjectRuntimeSpec> {
  const project = await ctx.db.get<{
    id: string;
    org_id: string;
    host_id: string;
    access: string;
  }>("SELECT id,org_id,host_id,access FROM projects WHERE id=?", [id]);
  if (!project) throw new Error("Project runtime policy unavailable");
  return {
    projectId: id,
    organizationId: project.org_id,
    hostId: project.host_id,
    scheduleEnabled: project.access === "write",
    scheduleMounts: await resolveScheduledMounts(ctx, project.org_id, id),
  };
}
