import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  AppError,
  mapUser,
  objectBody,
  stringValue,
  type AppContext,
} from "../context.js";
import { hashToken } from "../auth/session.js";
import { jobStatement } from "../jobs/index.js";
const org = (r: any) => ({ id: r.id, name: r.name, createdAt: r.created_at });
function role(value: unknown): "admin" | "member" {
  if (value !== undefined && value !== "admin" && value !== "member")
    throw new AppError(400, "invalid_request", "Role must be admin or member");
  return value === "admin" ? "admin" : "member";
}
export async function registerOrganizations(
  app: FastifyInstance,
  ctx: AppContext,
) {
  app.get("/api/organizations", async (request) => {
    const user = await ctx.requireUser(request);
    return {
      items: (
        await ctx.db.all(
          user.role === "owner"
            ? "SELECT * FROM organizations ORDER BY name"
            : "SELECT * FROM organizations WHERE id=?",
          user.role === "owner" ? [] : [user.orgId],
        )
      ).map(org),
    };
  });
  app.post("/api/organizations", async (request, reply) => {
    const user = await ctx.requireUser(request);
    if (user.role !== "owner")
      throw new AppError(403, "forbidden", "Platform owner access required");
    const body = objectBody(request.body);
    const value = {
      id: randomUUID(),
      name: stringValue(body.name, "name"),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.run("INSERT INTO organizations VALUES (?,?,?)", [
      value.id,
      value.name,
      value.createdAt,
    ]);
    await ctx.audit(user, "organization.created", value.id);
    reply.code(201);
    return value;
  });
  app.get<{ Params: { orgId: string } }>(
    "/api/organizations/:orgId",
    async (request) => {
      const user = await ctx.requireUser(request);
      await ctx.requireOrgMember(user, request.params.orgId);
      return org(
        await ctx.db.get("SELECT * FROM organizations WHERE id=?", [
          request.params.orgId,
        ]),
      );
    },
  );
  app.patch<{ Params: { orgId: string } }>(
    "/api/organizations/:orgId",
    async (request) => {
      const user = await ctx.requireUser(request);
      await ctx.requireOrgAdmin(user, request.params.orgId);
      const name = stringValue(objectBody(request.body).name, "name");
      await ctx.db.run("UPDATE organizations SET name=? WHERE id=?", [
        name,
        request.params.orgId,
      ]);
      await ctx.audit(user, "organization.updated", request.params.orgId);
      return org(
        await ctx.db.get("SELECT * FROM organizations WHERE id=?", [
          request.params.orgId,
        ]),
      );
    },
  );
  app.get<{ Params: { orgId: string } }>(
    "/api/organizations/:orgId/members",
    async (request) => {
      const user = await ctx.requireUser(request);
      await ctx.requireOrgMember(user, request.params.orgId);
      const rows = await ctx.db.all<any>(
        "SELECT *,password_hash IS NULL AS invitation_pending FROM users WHERE org_id=? ORDER BY name,email",
        [request.params.orgId],
      );
      return {
        items: rows.map((row) => ({
          ...mapUser(row),
          createdAt: row.created_at,
          invitationPending: !!row.invitation_pending,
        })),
      };
    },
  );
  const invite = async (request: any, reply: any) => {
    const user = await ctx.requireUser(request);
    const orgId = request.params.orgId;
    await ctx.requireOrgAdmin(user, orgId);
    const body = objectBody(request.body);
    const email = stringValue(body.email, "email", 254).toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
      throw new AppError(400, "invalid_request", "Invalid email");
    const name = stringValue(body.name ?? email, "name");
    const desiredRole = role(body.role);
    const existing = await ctx.db.get<any>(
      "SELECT * FROM users WHERE email=?",
      [email],
    );
    if (existing && (existing.org_id !== orgId || existing.enabled))
      throw new AppError(
        409,
        "account_exists",
        "An account already exists for this email",
      );
    const id = existing?.id ?? randomUUID();
    const invitationId = randomUUID();
    const token = randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
    const organization = await ctx.db.get<any>(
      "SELECT name FROM organizations WHERE id=?",
      [orgId],
    );
    const job = jobStatement({
      orgId,
      type: "invitation.deliver",
      idempotencyKey: invitationId,
      payload: {
        invitationId,
        email,
        name,
        organizationName: organization.name,
        activationUrl: `${ctx.config.publicOrigin}/activate?token=${token}`,
      },
    });
    await ctx.db.batch([
      ...(existing
        ? [
            {
              sql: "UPDATE users SET name=?,role=?,password_hash=NULL WHERE id=? AND enabled=0",
              params: [name, desiredRole, id],
              expectChanges: 1,
            },
            {
              sql: "DELETE FROM invitations WHERE user_id=? AND accepted_at IS NULL",
              params: [id],
            },
          ]
        : [
            {
              sql: "INSERT INTO users (id,org_id,email,name,role,enabled,created_at) VALUES (?,?,?,?,?,0,?)",
              params: [id, orgId, email, name, desiredRole, now],
            },
          ]),
      {
        sql: "INSERT INTO invitations VALUES (?,?,?,?,?,NULL,?)",
        params: [invitationId, orgId, id, hashToken(token), expiresAt, now],
      },
      job.statement,
    ]);
    await ctx.audit(user, "member.invited", id);
    reply.code(202);
    return {
      user: mapUser(await ctx.db.get("SELECT * FROM users WHERE id=?", [id])),
      invitation: { id: invitationId, expiresAt },
      activationUrl: `${ctx.config.publicOrigin}/activate?token=${token}`,
      jobId: job.id,
    };
  };
  app.post("/api/organizations/:orgId/invitations", invite);
  app.post("/api/organizations/:orgId/members", invite);
  app.patch<{ Params: { orgId: string; userId: string } }>(
    "/api/organizations/:orgId/members/:userId",
    async (request) => {
      const actor = await ctx.requireUser(request);
      const { orgId, userId } = request.params;
      await ctx.requireOrgAdmin(actor, orgId);
      const target = await ctx.db.get<any>(
        "SELECT * FROM users WHERE id=? AND org_id=?",
        [userId, orgId],
      );
      if (!target) throw new AppError(404, "not_found", "Member not found");
      const body = objectBody(request.body);
      const name =
        body.name === undefined ? target.name : stringValue(body.name, "name");
      const desiredRole =
        body.role === undefined ? target.role : role(body.role);
      if (body.enabled !== undefined && typeof body.enabled !== "boolean")
        throw new AppError(400, "invalid_request", "Invalid enabled value");
      const enabled =
        body.enabled === undefined ? !!target.enabled : body.enabled;
      if (enabled && !target.password_hash)
        throw new AppError(
          409,
          "invitation_pending",
          "The member must accept their invitation first",
        );
      if (actor.id === userId && (!enabled || desiredRole !== "admin"))
        throw new AppError(
          409,
          "self_removal",
          "Ask another administrator to change your access",
        );
      await ctx.db.batch([
        {
          sql: "UPDATE users SET name=?,role=?,enabled=? WHERE id=? AND org_id=?",
          params: [name, desiredRole, enabled ? 1 : 0, userId, orgId],
          expectChanges: 1,
        },
        ...(!enabled
          ? [
              { sql: "DELETE FROM sessions WHERE user_id=?", params: [userId] },
              {
                sql: "DELETE FROM project_members WHERE user_id=?",
                params: [userId],
              },
              {
                sql: "DELETE FROM invitations WHERE user_id=? AND accepted_at IS NULL",
                params: [userId],
              },
            ]
          : []),
      ]);
      await ctx.onAccessChanged?.();
      await ctx.audit(actor, "member.updated", userId, {
        role: desiredRole,
        enabled,
      });
      return mapUser(
        await ctx.db.get("SELECT * FROM users WHERE id=?", [userId]),
      );
    },
  );
  app.post<{ Params: { orgId: string; userId: string } }>(
    "/api/organizations/:orgId/members/:userId/password-reset",
    async (request, reply) => {
      const actor = await ctx.requireUser(request);
      const { orgId, userId } = request.params;
      await ctx.requireOrgAdmin(actor, orgId);
      const target = await ctx.db.get<any>(
        "SELECT * FROM users WHERE id=? AND org_id=?",
        [userId, orgId],
      );
      if (!target) throw new AppError(404, "not_found", "Member not found");
      if (target.role === "owner")
        throw new AppError(403, "forbidden", "Owners manage their own resets");
      if (!target.enabled || !target.password_hash)
        throw new AppError(
          409,
          "reset_unavailable",
          "Password reset is available after the member activates an enabled account",
        );
      const recent = await ctx.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM password_reset_tokens WHERE user_id=? AND created_at>?",
        [userId, new Date(Date.now() - 60 * 60_000).toISOString()],
      );
      if ((recent?.count ?? 0) >= 5)
        throw new AppError(
          429,
          "rate_limited",
          "Too many password reset requests. Try again later.",
        );
      const token = randomBytes(32).toString("hex");
      const resetId = randomUUID();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const resetUrl = `${ctx.config.publicOrigin}/reset-password?token=${token}`;
      const job = jobStatement({
        orgId,
        type: "password_reset.deliver",
        idempotencyKey: resetId,
        payload: {
          resetId,
          email: target.email,
          name: target.name,
          resetUrl,
        },
      });
      try {
        await ctx.db.batch([
          {
            sql: "INSERT INTO password_reset_tokens SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM password_reset_tokens WHERE user_id=? AND created_at>?) < 5",
            expectChanges: 1,
            params: [resetId, userId, hashToken(token), expiresAt, null, now, hashToken(request.ip), userId, new Date(Date.now() - 3600_000).toISOString()],
          },
          job.statement,
        ]);
      } catch (error) {
        if ((error as Error).message === "Concurrent update conflict")
          throw new AppError(429, "rate_limited", "Too many password reset requests. Try again later.");
        throw error;
      }
      await ctx.audit(actor, "member.password_reset_requested", userId);
      reply.code(202);
      return {
        ok: true,
        message: "Password reset email queued.",
        expiresAt,
      };
    },
  );
  app.delete<{ Params: { orgId: string; userId: string } }>(
    "/api/organizations/:orgId/members/:userId",
    async (request) => {
      const actor = await ctx.requireUser(request);
      const { orgId, userId } = request.params;
      await ctx.requireOrgAdmin(actor, orgId);
      if (actor.id === userId)
        throw new AppError(
          409,
          "self_removal",
          "Ask another administrator to remove your access",
        );
      if (
        !(await ctx.db.get("SELECT id FROM users WHERE id=? AND org_id=?", [
          userId,
          orgId,
        ]))
      )
        throw new AppError(404, "not_found", "Member not found");
      await ctx.db.batch([
        {
          sql: "UPDATE users SET enabled=0 WHERE id=? AND org_id=?",
          params: [userId, orgId],
          expectChanges: 1,
        },
        { sql: "DELETE FROM sessions WHERE user_id=?", params: [userId] },
        {
          sql: "DELETE FROM project_members WHERE user_id=?",
          params: [userId],
        },
        {
          sql: "DELETE FROM invitations WHERE user_id=? AND accepted_at IS NULL",
          params: [userId],
        },
      ]);
      await ctx.onAccessChanged?.();
      await ctx.audit(actor, "member.removed", userId);
      return { ok: true };
    },
  );
}
