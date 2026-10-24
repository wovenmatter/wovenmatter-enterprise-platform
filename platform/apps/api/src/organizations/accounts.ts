import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError, accessValue, mapUser, objectBody, stringValue, type AppContext, type User } from "../context.js";
import { hashToken } from "../auth/session.js";
import { jobStatement } from "../jobs/index.js";

/** Platform identities are independent of organization memberships. Only the
 * single owner may create, disable or renew identities across organizations. */
export async function registerAccounts(app: FastifyInstance, ctx: AppContext) {
  async function owner(request: FastifyRequest) {
    const user = await ctx.requireUser(request);
    if (user.role !== "owner")
      throw new AppError(403, "forbidden", "Platform owner access required");
    return user;
  }
  async function account(id: string) {
    const row = await ctx.db.get<any>("SELECT * FROM users WHERE id=?", [id]);
    if (!row) throw new AppError(404, "not_found", "Account not found");
    return {
      ...mapUser(row),
      invitationPending: !row.password_hash,
      createdAt: row.created_at,
      memberships: await ctx.db.all(
        "SELECT m.org_id AS orgId,o.name AS organizationName,m.role,CASE WHEN m.role='admin' THEN 'write' ELSE m.library_access END AS libraryAccess FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=? ORDER BY o.name",
        [id],
      ),
    };
  }
  async function invite(actor: User, body: Record<string, unknown>, existingId?: string) {
    const existing = existingId
      ? await ctx.db.get<any>("SELECT * FROM users WHERE id=?", [existingId])
      : await ctx.db.get<any>("SELECT * FROM users WHERE email=?", [stringValue(body.email, "email", 254).toLowerCase()]);
    if (existingId && !existing) throw new AppError(404, "not_found", "Account not found");
    const email = existing?.email ?? stringValue(body.email, "email", 254).toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
      throw new AppError(400, "invalid_request", "Invalid email");
    if (body.role !== undefined && body.role !== "admin" && body.role !== "member")
      throw new AppError(400, "invalid_request", "Organization role must be admin or member");
    const orgId = body.orgId === undefined ? null : stringValue(body.orgId, "organization");
    if (orgId) await ctx.requireOrgAdmin(actor, orgId);
    if (existing?.role === "owner")
      throw new AppError(409, "owner_account", "The platform owner already has access to every organization");
    if (existing?.password_hash && !existing.enabled)
      throw new AppError(409, "account_disabled", "Enable the existing account before adding organization access");
    if (existingId && existing?.password_hash)
      throw new AppError(409, "account_active", "This account has already been activated");
    const id = existing?.id ?? randomUUID();
    const name = existing?.name ?? stringValue(body.name ?? email, "name");
    const role = body.role === "admin" ? "admin" : "member";
    const libraryAccess = accessValue(body.libraryAccess, role === "admin" ? "write" : "read");
    const now = new Date().toISOString();
    const membership = orgId ? [{
      sql: "INSERT OR IGNORE INTO organization_memberships VALUES(?,?,?,?,?)",
      params: [orgId, id, role, libraryAccess, now],
    }] : [];
    if (existing?.password_hash) {
      await ctx.db.batch(membership);
      await ctx.audit(actor, orgId, "account.reused", id);
      return { status: 201, value: { user: await account(id) } };
    }
    const token = randomBytes(32).toString("hex"), invitationId = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
    const activationUrl = `${ctx.config.publicOrigin}/enterprise/activate?token=${token}`;
    const job = jobStatement({ orgId, type: "invitation.deliver", idempotencyKey: invitationId,
      payload: { invitationId, email, name, activationUrl } });
    await ctx.db.batch([
      ...(existing ? [{
        sql: "UPDATE users SET name=name WHERE id=? AND password_hash IS NULL",
        params: [id], expectChanges: 1,
      }] : [{
        sql: "INSERT INTO users(id,org_id,email,name,role,enabled,created_at) VALUES(?,NULL,?,?,'member',0,?)",
        params: [id, email, name, now],
      }]),
      ...membership,
      { sql: "DELETE FROM invitations WHERE user_id=? AND accepted_at IS NULL", params: [id] },
      // Owner-issued activation belongs to the platform identity. Removing an
      // organization membership cannot disable an independently created account.
      { sql: "INSERT INTO invitations VALUES(?,NULL,?,?,?,NULL,?)", params: [invitationId, id, hashToken(token), expiresAt, now] },
      job.statement,
    ]);
    await ctx.audit(actor, orgId, existing ? "account.invitation_renewed" : "account.created", id);
    return { status: 202, value: { user: await account(id), invitation: { id: invitationId, expiresAt }, activationUrl, jobId: job.id } };
  }
  app.get("/enterprise/api/accounts", async (request) => {
    await owner(request);
    const rows = await ctx.db.all<{ id: string }>("SELECT id FROM users ORDER BY name,email");
    return { items: await Promise.all(rows.map((row) => account(row.id))) };
  });
  app.post("/enterprise/api/accounts", async (request, reply) => {
    const result = await invite(await owner(request), objectBody(request.body));
    return reply.code(result.status).send(result.value);
  });
  app.post<{ Params: { userId: string } }>("/enterprise/api/accounts/:userId/invitations", async (request, reply) => {
    const result = await invite(await owner(request), objectBody(request.body ?? {}), request.params.userId);
    return reply.code(result.status).send(result.value);
  });
  app.patch<{ Params: { userId: string } }>("/enterprise/api/accounts/:userId", async (request) => {
    const actor = await owner(request), body = objectBody(request.body), current = await account(request.params.userId);
    if (body.role !== undefined || body.email !== undefined || body.orgId !== undefined)
      throw new AppError(400, "invalid_request", "Change organization roles through organization membership settings");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean")
      throw new AppError(400, "invalid_request", "Invalid enabled value");
    const enabled = body.enabled ?? current.enabled;
    if (current.role === "owner" && !enabled)
      throw new AppError(409, "owner_account", "The platform owner cannot be disabled");
    if (enabled && current.invitationPending)
      throw new AppError(409, "invitation_pending", "The account must accept its invitation first");
    const name = body.name === undefined ? current.name : stringValue(body.name, "name");
    await ctx.db.batch([
      { sql: "UPDATE users SET enabled=?,name=? WHERE id=?", params: [enabled ? 1 : 0, name, current.id] },
      ...(!enabled ? [{ sql: "DELETE FROM sessions WHERE user_id=?", params: [current.id] },
        { sql: "DELETE FROM invitations WHERE user_id=? AND accepted_at IS NULL", params: [current.id] },
        { sql: "DELETE FROM password_reset_tokens WHERE user_id=?", params: [current.id] }] : []),
    ]);
    await ctx.onAccessChanged?.();
    await ctx.audit(actor, null, "account.updated", current.id, { enabled });
    return account(current.id);
  });
  app.get("/enterprise/api/platform/settings", async (request) => {
    const actor = await owner(request);
    return {
      owner: await account(actor.id),
      organizations: (await ctx.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM organizations"))!.count,
      accounts: (await ctx.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM users"))!.count,
      hosts: ctx.config.hosts ?? [{ id: "local", name: "Initial host" }],
    };
  });
}
