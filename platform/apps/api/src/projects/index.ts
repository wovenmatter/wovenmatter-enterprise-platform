import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  AppError,
  accessValue,
  mapProject,
  mapUser,
  objectBody,
  stringValue,
  type AppContext,
  type User,
} from "../context.js";
import { jobStatement } from "../jobs/index.js";
export async function registerProjects(app: FastifyInstance, ctx: AppContext) {
  async function admin(user: User, id: string) {
    const p = await ctx.requireProject(user, id);
    await ctx.requireOrgAdmin(user, p.orgId);
    return p;
  }
  app.get<{ Params: { orgId: string } }>(
    "/api/organizations/:orgId/projects",
    async (request) => {
      const user = await ctx.requireUser(request);
      const orgId = request.params.orgId;
      await ctx.requireOrgMember(user, orgId);
      const rows = await ctx.db.all<any>(
        user.role === "member"
          ? "SELECT p.*,CASE WHEN p.access='read' OR m.access='read' THEN 'read' ELSE 'write' END AS effective_access FROM projects p JOIN project_members m ON p.id=m.project_id WHERE p.org_id=? AND m.user_id=? AND p.status<>'deleted' ORDER BY p.created_at DESC"
          : "SELECT * FROM projects WHERE org_id=? AND status<>'deleted' ORDER BY created_at DESC",
        user.role === "member" ? [orgId, user.id] : [orgId],
      );
      return {
        items: rows.map((row) => mapProject(row, row.effective_access)),
      };
    },
  );
  app.post<{ Params: { orgId: string } }>(
    "/api/organizations/:orgId/projects",
    async (request, reply) => {
      const user = await ctx.requireUser(request);
      const orgId = request.params.orgId;
      await ctx.requireOrgAdmin(user, orgId);
      const body = objectBody(request.body);
      const project = {
        id: randomUUID(),
        orgId,
        name: stringValue(body.name, "name"),
        description:
          body.description === undefined
            ? ""
            : stringValue(body.description, "description", 4000, true),
        status: "provisioning",
        access: accessValue(body.access),
        createdAt: new Date().toISOString(),
      };
      const job = jobStatement({
        orgId,
        projectId: project.id,
        type: "project.provision",
        idempotencyKey: project.id,
        payload: { projectId: project.id, orgId },
      });
      await ctx.db.batch([
        {
          sql: "INSERT INTO projects (id,org_id,name,description,status,access,created_at) VALUES (?,?,?,?,?,?,?)",
          params: [
            project.id,
            orgId,
            project.name,
            project.description,
            project.status,
            project.access,
            project.createdAt,
          ],
        },
        job.statement,
      ]);
      await ctx.audit(user, "project.created", project.id);
      reply.code(202);
      return { ...project, jobId: job.id };
    },
  );
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId",
    async (request) =>
      ctx.requireProject(
        await ctx.requireUser(request),
        request.params.projectId,
      ),
  );
  app.patch<{ Params: { projectId: string } }>(
    "/api/projects/:projectId",
    async (request) => {
      const user = await ctx.requireUser(request);
      const project = await admin(user, request.params.projectId);
      const body = objectBody(request.body);
      const name =
        body.name === undefined ? project.name : stringValue(body.name, "name");
      const description =
        body.description === undefined
          ? project.description
          : stringValue(body.description, "description", 4000, true);
      const access = accessValue(body.access, project.access);
      await ctx.db.run(
        "UPDATE projects SET name=?,description=?,access=? WHERE id=?",
        [name, description, access, project.id],
      );
      await ctx.onAccessChanged?.();
      await ctx.audit(user, "project.updated", project.id, { access });
      return ctx.requireProject(user, project.id);
    },
  );
  app.delete<{ Params: { projectId: string } }>(
    "/api/projects/:projectId",
    async (request, reply) => {
      const user = await ctx.requireUser(request);
      const project = await admin(user, request.params.projectId);
      const job = jobStatement({
        orgId: project.orgId,
        projectId: project.id,
        type: "project.remove",
        idempotencyKey: project.id,
        payload: { projectId: project.id, orgId: project.orgId },
      });
      await ctx.db.batch([
        {
          sql: "UPDATE projects SET status='deleting' WHERE id=? AND status NOT IN ('deleted','deleting')",
          params: [project.id],
          expectChanges: 1,
        },
        {
          sql: "UPDATE jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE project_id=? AND type='project.provision' AND status IN ('pending','running','needs_attention')",
          params: [new Date().toISOString(), project.id],
        },
        job.statement,
      ]);
      await ctx.onAccessChanged?.();
      await ctx.audit(user, "project.removed", project.id);
      reply.code(202);
      return { ok: true, jobId: job.id };
    },
  );
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/members",
    async (request) => {
      const user = await ctx.requireUser(request);
      await ctx.requireProject(user, request.params.projectId);
      const rows = await ctx.db.all<any>(
        "SELECT u.*,m.access,m.created_at AS membership_created_at FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? AND u.enabled=1 ORDER BY u.name,u.email",
        [request.params.projectId],
      );
      return {
        items: rows.map((row) => ({
          ...mapUser(row),
          access: row.access,
          createdAt: row.membership_created_at,
        })),
      };
    },
  );
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/members",
    async (request, reply) => {
      const user = await ctx.requireUser(request);
      const project = await admin(user, request.params.projectId);
      const body = objectBody(request.body);
      const userId = stringValue(body.userId, "user ID", 64);
      const access = accessValue(body.access);
      if (
        !(await ctx.db.get(
          "SELECT id FROM users WHERE id=? AND org_id=? AND enabled=1",
          [userId, project.orgId],
        ))
      )
        throw new AppError(404, "not_found", "Organization member not found");
      await ctx.db.run(
        "INSERT INTO project_members (project_id,user_id,access,created_at) VALUES (?,?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET access=excluded.access",
        [project.id, userId, access, new Date().toISOString()],
      );
      await ctx.onAccessChanged?.();
      await ctx.audit(user, "project.member_added", project.id, {
        userId,
        access,
      });
      reply.code(201);
      return {
        ...mapUser(
          await ctx.db.get("SELECT * FROM users WHERE id=?", [userId]),
        ),
        access,
      };
    },
  );
  app.patch<{ Params: { projectId: string; userId: string } }>(
    "/api/projects/:projectId/members/:userId",
    async (request) => {
      const user = await ctx.requireUser(request);
      const project = await admin(user, request.params.projectId);
      const access = accessValue(objectBody(request.body).access);
      const result = await ctx.db.run(
        "UPDATE project_members SET access=? WHERE project_id=? AND user_id=?",
        [access, project.id, request.params.userId],
      );
      if (!result.changes)
        throw new AppError(404, "not_found", "Project member not found");
      await ctx.onAccessChanged?.();
      await ctx.audit(user, "project.member_updated", project.id, {
        userId: request.params.userId,
        access,
      });
      return {
        ...mapUser(
          await ctx.db.get("SELECT * FROM users WHERE id=?", [
            request.params.userId,
          ]),
        ),
        access,
      };
    },
  );
  app.delete<{ Params: { projectId: string; userId: string } }>(
    "/api/projects/:projectId/members/:userId",
    async (request) => {
      const user = await ctx.requireUser(request);
      const project = await admin(user, request.params.projectId);
      await ctx.db.run(
        "DELETE FROM project_members WHERE project_id=? AND user_id=?",
        [project.id, request.params.userId],
      );
      await ctx.onAccessChanged?.();
      await ctx.audit(user, "project.member_removed", project.id, {
        userId: request.params.userId,
      });
      return { ok: true };
    },
  );
}
