import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  AppError,
  accessValue,
  mapUser,
  objectBody,
  stringValue,
  type AppContext,
} from "../context.js";
import { hashToken } from "../auth/session.js";
import { jobStatement } from "../jobs/index.js";
const org = (r: any) => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  defaultHostId: r.default_host_id,
  role: r.membership_role ?? "admin",
  libraryAccess: r.library_access ?? "write",
});
function role(value: unknown): "admin" | "member" {
  if (value !== undefined && value !== "admin" && value !== "member")
    throw new AppError(400, "invalid_request", "Role must be admin or member");
  return value === "admin" ? "admin" : "member";
}
export async function registerOrganizations(
  app: FastifyInstance,
  ctx: AppContext,
) {
  async function organizationFor(
    user: import("../context.js").User,
    orgId: string,
  ) {
    const membership = await ctx.membership(user, orgId);
    return org({
      ...(await ctx.db.get("SELECT * FROM organizations WHERE id=?", [orgId])),
      membership_role: membership.role,
      library_access: membership.libraryAccess,
    });
  }
  async function removeMembership(orgId: string, userId: string) {
    const optional = [];
    if (
      await ctx.db.get(
        "SELECT name FROM sqlite_master WHERE name='conversation_members'",
      )
    )
      optional.push({
        sql: "DELETE FROM conversation_members WHERE user_id=? AND conversation_id IN (SELECT id FROM conversations WHERE org_id=?)",
        params: [userId, orgId],
      });
    if (
      await ctx.db.get(
        "SELECT name FROM sqlite_master WHERE name='workspace_file_grants'",
      )
    )
      optional.push({
        sql: "DELETE FROM workspace_file_grants WHERE user_id=? AND file_id IN (SELECT id FROM workspace_files WHERE org_id=?)",
        params: [userId, orgId],
      });
    await ctx.db.batch([
      ...optional,
      {
        sql: "DELETE FROM organization_memberships WHERE org_id=? AND user_id=?",
        params: [orgId, userId],
        expectChanges: 1,
      },
      {
        sql: "DELETE FROM project_members WHERE user_id=? AND project_id IN (SELECT id FROM projects WHERE org_id=?)",
        params: [userId, orgId],
      },
      {
        sql: "DELETE FROM invitations WHERE user_id=? AND org_id=? AND accepted_at IS NULL",
        params: [userId, orgId],
      },
    ]);
  }
  app.get("/enterprise/api/hosts", async (request) => {
    const user = await ctx.requireUser(request);
    if (user.role !== "owner")
      throw new AppError(403, "forbidden", "Platform owner access required");
    return {
      items: ctx.config.hosts ?? [
        {
          id: "local",
          name: "Initial host",
        },
      ],
    };
  });
  app.get("/enterprise/api/organizations", async (request) => {
    const user = await ctx.requireUser(request);
    return {
      items: (
        await ctx.db.all(
          user.role === "owner"
            ? "SELECT * FROM organizations ORDER BY name"
            : "SELECT o.*,m.role AS membership_role,m.library_access FROM organizations o JOIN organization_memberships m ON m.org_id=o.id WHERE m.user_id=? ORDER BY o.name",
          user.role === "owner" ? [] : [user.id],
        )
      ).map(org),
    };
  });
  app.post("/enterprise/api/organizations", async (request, reply) => {
    const user = await ctx.requireUser(request);
    if (user.role !== "owner")
      throw new AppError(403, "forbidden", "Platform owner access required");
    const body = objectBody(request.body);
    const value = {
      id: randomUUID(),
      name: stringValue(body.name, "name"),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.run(
      "INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)",
      [value.id, value.name, value.createdAt],
    );
    await ctx.audit(user, value.id, "organization.created", value.id);
    reply.code(201);
    return value;
  });
  app.get<{
    Params: {
      orgId: string;
    };
  }>("/enterprise/api/organizations/:orgId", async (request) => {
    const user = await ctx.requireUser(request);
    await ctx.requireOrgMember(user, request.params.orgId);
    return organizationFor(user, request.params.orgId);
  });
  app.patch<{
    Params: {
      orgId: string;
    };
  }>("/enterprise/api/organizations/:orgId", async (request) => {
    const user = await ctx.requireUser(request);
    await ctx.requireOrgAdmin(user, request.params.orgId);
    const body = objectBody(request.body);
    const current = await ctx.db.get<any>(
      "SELECT * FROM organizations WHERE id=?",
      [request.params.orgId],
    );
    const name =
      body.name === undefined ? current.name : stringValue(body.name, "name");
    if (body.defaultHostId !== undefined) {
      if (user.role !== "owner")
        throw new AppError(
          403,
          "forbidden",
          "Only the platform owner controls host placement.",
        );
      const hostId = stringValue(body.defaultHostId, "host");
      if (
        !(
          (ctx.config.hosts as
            | {
                id: string;
              }[]
            | undefined) ?? [
            {
              id: "local",
            },
          ]
        ).some((h) => h.id === hostId)
      )
        throw new AppError(400, "unknown_host", "Choose a configured host.");
      await ctx.db.run(
        "UPDATE organizations SET default_host_id=? WHERE id=?",
        [hostId, request.params.orgId],
      );
    }
    await ctx.db.run("UPDATE organizations SET name=? WHERE id=?", [
      name,
      request.params.orgId,
    ]);
    await ctx.audit(
      user,
      request.params.orgId,
      "organization.updated",
      request.params.orgId,
    );
    return organizationFor(user, request.params.orgId);
  });
  app.get<{
    Params: {
      orgId: string;
    };
  }>("/enterprise/api/organizations/:orgId/members", async (request) => {
    const user = await ctx.requireUser(request);
    await ctx.requireOrgMember(user, request.params.orgId);
    const rows = await ctx.db.all<any>(
      "SELECT u.*,m.org_id,m.role,m.library_access,password_hash IS NULL AS invitation_pending FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=? ORDER BY name,email",
      [request.params.orgId],
    );
    return {
      items: rows.map((row) => ({
        ...mapUser(row),
        libraryAccess: row.role === "admin" ? "write" : row.library_access,
        createdAt: row.created_at,
        invitationPending: !!row.invitation_pending,
      })),
    };
  });
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
    if (
      existing &&
      (existing.role === "owner" ||
        (existing.password_hash &&
          (await ctx.db.get(
            "SELECT 1 FROM organization_memberships WHERE org_id=? AND user_id=?",
            [orgId, existing.id],
          ))))
    )
      throw new AppError(
        409,
        "account_exists",
        "An account already exists for this email",
      );
    // Only the administrator that established an unverified identity can renew its
    // activation. A second organization must wait for the person to activate.
    if (
      existing &&
      ((!existing.password_hash && existing.org_id !== orgId) ||
        (existing.password_hash && !existing.enabled))
    )
      throw new AppError(
        409,
        "account_unavailable",
        "This account cannot receive another invitation until its original activation is complete.",
      );
    const libraryAccess = accessValue(
      body.libraryAccess,
      desiredRole === "admin" ? "write" : "read",
    );
    if (existing?.enabled) {
      await ctx.db.run(
        "INSERT INTO organization_memberships VALUES(?,?,?,?,?)",
        [
          orgId,
          existing.id,
          desiredRole,
          libraryAccess,
          new Date().toISOString(),
        ],
      );
      await ctx.audit(user, orgId, "member.added", existing.id, {
        orgId,
      });
      reply.code(201);
      return {
        user: {
          ...mapUser(existing),
          orgId,
          role: desiredRole,
          libraryAccess,
        },
      };
    }
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
        activationUrl: `${ctx.config.publicOrigin}/enterprise/activate?token=${token}`,
      },
    });
    await ctx.db.batch([
      ...(existing
        ? [
            {
              sql: "UPDATE users SET name=name WHERE id=? AND password_hash IS NULL AND NOT EXISTS(SELECT 1 FROM organization_memberships WHERE user_id=? AND org_id<>?)",
              params: [id, id, orgId],
              expectChanges: 1,
            },
          ]
        : [
            {
              sql: "INSERT INTO users (id,org_id,email,name,role,enabled,created_at) VALUES (?,?,?,?,?,0,?)",
              params: [id, orgId, email, name, "member", now],
            },
          ]),
      {
        sql: "INSERT INTO organization_memberships VALUES(?,?,?,?,?) ON CONFLICT(org_id,user_id) DO UPDATE SET role=excluded.role,library_access=excluded.library_access",
        params: [orgId, id, desiredRole, libraryAccess, now],
      },
      {
        sql: "DELETE FROM invitations WHERE user_id=? AND org_id=? AND accepted_at IS NULL",
        params: [id, orgId],
      },
      {
        sql: "INSERT INTO invitations VALUES (?,?,?,?,?,NULL,?)",
        params: [invitationId, orgId, id, hashToken(token), expiresAt, now],
      },
      job.statement,
    ]);
    await ctx.audit(user, orgId, "member.invited", id);
    reply.code(202);
    return {
      user: mapUser(await ctx.db.get("SELECT * FROM users WHERE id=?", [id])),
      invitation: {
        id: invitationId,
        expiresAt,
      },
      activationUrl: `${ctx.config.publicOrigin}/enterprise/activate?token=${token}`,
      jobId: job.id,
    };
  };
  app.post("/enterprise/api/organizations/:orgId/invitations", invite);
  app.post("/enterprise/api/organizations/:orgId/members", invite);
  app.patch<{
    Params: {
      orgId: string;
      userId: string;
    };
  }>(
    "/enterprise/api/organizations/:orgId/members/:userId",
    async (request) => {
      const actor = await ctx.requireUser(request);
      const { orgId, userId } = request.params;
      await ctx.requireOrgAdmin(actor, orgId);
      const target = await ctx.db.get<any>(
        "SELECT u.*,m.org_id,m.role,m.library_access FROM users u JOIN organization_memberships m ON m.user_id=u.id WHERE u.id=? AND m.org_id=?",
        [userId, orgId],
      );
      if (!target) throw new AppError(404, "not_found", "Member not found");
      const body = objectBody(request.body);
      const libraryAccess = accessValue(
        body.libraryAccess,
        target.library_access,
      );
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
      if (!enabled) {
        await removeMembership(orgId, userId);
      } else
        await ctx.db.run(
          "UPDATE organization_memberships SET role=?,library_access=? WHERE org_id=? AND user_id=?",
          [desiredRole, libraryAccess, orgId, userId],
        );
      await ctx.onAccessChanged?.();
      await ctx.audit(actor, orgId, "member.updated", userId, {
        role: desiredRole,
        enabled,
      });
      return {
        ...mapUser(target),
        orgId,
        role: desiredRole,
        libraryAccess,
        enabled,
      };
    },
  );
  app.post<{
    Params: {
      orgId: string;
      userId: string;
    };
  }>(
    "/enterprise/api/organizations/:orgId/members/:userId/password-reset",
    async (request, reply) => {
      const actor = await ctx.requireUser(request);
      const { orgId, userId } = request.params;
      await ctx.requireOrgAdmin(actor, orgId);
      const target = await ctx.db.get<any>(
        "SELECT u.*,m.org_id,m.role,m.library_access FROM users u JOIN organization_memberships m ON m.user_id=u.id WHERE u.id=? AND m.org_id=?",
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
      const recent = await ctx.db.get<{
        count: number;
      }>(
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
      const resetUrl = `${ctx.config.publicOrigin}/enterprise/reset-password?token=${token}`;
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
            params: [
              resetId,
              userId,
              hashToken(token),
              expiresAt,
              null,
              now,
              hashToken(request.ip),
              userId,
              new Date(Date.now() - 3600_000).toISOString(),
            ],
          },
          job.statement,
        ]);
      } catch (error) {
        if ((error as Error).message === "Concurrent update conflict")
          throw new AppError(
            429,
            "rate_limited",
            "Too many password reset requests. Try again later.",
          );
        throw error;
      }
      await ctx.audit(actor, orgId, "member.password_reset_requested", userId);
      reply.code(202);
      return {
        ok: true,
        message: "Password reset email queued.",
        expiresAt,
      };
    },
  );
  app.delete<{
    Params: {
      orgId: string;
      userId: string;
    };
  }>(
    "/enterprise/api/organizations/:orgId/members/:userId",
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
        !(await ctx.db.get(
          "SELECT user_id FROM organization_memberships WHERE user_id=? AND org_id=?",
          [userId, orgId],
        ))
      )
        throw new AppError(404, "not_found", "Member not found");
      await removeMembership(orgId, userId);
      await ctx.onAccessChanged?.();
      await ctx.audit(actor, orgId, "member.removed", userId);
      return {
        ok: true,
      };
    },
  );
}
