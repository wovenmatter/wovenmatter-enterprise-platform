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
  }>("SELECT id,org_id,host_id FROM projects WHERE id=?", [id]);
  if (!project) throw new Error("Project runtime policy unavailable");
  return {
    projectId: id,
    organizationId: project.org_id,
    hostId: project.host_id,
    // Projects are full-capability; only write-mounted sessions, which require
    // the actor's own full project access, can change schedule definitions.
    scheduleEnabled: true,
    scheduleMounts: await resolveScheduledMounts(ctx, project.org_id, id),
  };
}
