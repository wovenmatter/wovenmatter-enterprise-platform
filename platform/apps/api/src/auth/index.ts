import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  AppError,
  mapUser,
  objectBody,
  stringValue,
  type AppContext,
} from "../context.js";
import { hashPassword, validatePassword, verifyPassword } from "./password.js";
import {
  hashToken,
  newSession,
  readSession,
  requestSessionId,
  setSessionCookie,
} from "./session.js";
import { jobStatement } from "../jobs/index.js";
export async function registerAuth(app: FastifyInstance, ctx: AppContext) {
  const limits = new Map<
    string,
    {
      count: number;
      until: number;
    }
  >();
  function limit(key: string, maximum = 200) {
    const now = Date.now();
    let entry = limits.get(key);
    if (!entry || entry.until <= now) {
      if (limits.size >= 10000) {
        for (const [k, v] of limits) if (v.until <= now) limits.delete(k);
        if (limits.size >= 10000)
          throw new AppError(429, "rate_limited", "Please try again later");
      }
      entry = {
        count: 0,
        until: now + 15 * 60_000,
      };
      limits.set(key, entry);
    }
    if (++entry.count > maximum)
      throw new AppError(
        429,
        "rate_limited",
        "Too many sign-in attempts. Please try again later",
      );
  }
  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0]!;
    const routeConfig = request.routeOptions.config as unknown as Record<
      string,
      unknown
    >;
    if (
      routeConfig.internalInference === true ||
      routeConfig.libraryContent === true ||
      routeConfig.isolatedContent === true
    )
      return;
    if (!pathname.startsWith("/enterprise/api/")) return;
    reply.header("cache-control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (
        request.headers.origin !== ctx.config.publicOrigin ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw new AppError(
          403,
          "invalid_origin",
          "Request origin is not allowed",
        );
      if (
        pathname === "/enterprise/api/login" ||
        pathname === "/enterprise/api/activate" ||
        pathname === "/enterprise/api/password-reset/request" ||
        pathname === "/enterprise/api/password-reset/confirm"
      ) {
        limit(request.ip);
        return;
      }
      const session = await readSession(
        ctx.db,
        request,
        ctx.config.secureCookies,
      );
      if (!session)
        throw new AppError(401, "unauthorized", "Sign in to continue");
      if (
        typeof request.headers["x-csrf-token"] !== "string" ||
        request.headers["x-csrf-token"] !== session.csrfToken
      )
        throw new AppError(
          403,
          "invalid_csrf",
          "Reload this page and try again",
        );
    }
  });
  app.get("/enterprise/api/session", async (request) => {
    const session = await readSession(
      ctx.db,
      request,
      ctx.config.secureCookies,
    );
    return {
      user: session?.user ?? null,
      csrfToken: session?.csrfToken ?? null,
    };
  });
  app.post("/enterprise/api/login", async (request, reply) => {
    const body = objectBody(request.body);
    const email = stringValue(body.email, "email", 254).toLowerCase();
    limit(`login:${request.ip}:${hashToken(email)}`, 20);
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length > 1024)
      throw new AppError(400, "invalid_request", "Invalid password");
    const row = await ctx.db.get<any>("SELECT * FROM users WHERE email=?", [
      email,
    ]);
    const valid = await verifyPassword(password, row?.password_hash ?? null);
    if (!valid || !row?.enabled)
      throw new AppError(
        401,
        "invalid_credentials",
        "Email or password is incorrect",
      );
    const session = newSession(row.id);
    const old = requestSessionId(request, ctx.config.secureCookies);
    await ctx.db.batch([
      ...(old
        ? [
            {
              sql: "DELETE FROM sessions WHERE id=?",
              params: [old],
            },
          ]
        : []),
      session.statement,
    ]);
    setSessionCookie(reply, ctx.config, session.token);
    return {
      user: mapUser(row),
      csrfToken: session.csrfToken,
    };
  });
  app.post("/enterprise/api/logout", async (request, reply) => {
    const id = requestSessionId(request, ctx.config.secureCookies);
    if (id) await ctx.db.run("DELETE FROM sessions WHERE id=?", [id]);
    setSessionCookie(reply, ctx.config, "", true);
    await ctx.onAccessChanged?.();
    return {
      ok: true,
    };
  });
  app.get("/enterprise/api/me", async (request) => {
    const user = await ctx.requireUser(request);
    const [organizations, projects] = await Promise.all([
      ctx.db.all<any>(
        user.role === "owner"
          ? "SELECT *, 'admin' AS membership_role,'write' AS library_access FROM organizations ORDER BY name"
          : "SELECT o.*,m.role AS membership_role,CASE WHEN m.role='admin' THEN 'write' ELSE m.library_access END AS library_access FROM organizations o JOIN organization_memberships m ON m.org_id=o.id WHERE m.user_id=? ORDER BY o.name",
        user.role === "owner" ? [] : [user.id],
      ),
      ctx.db.all<any>(
        user.role === "owner"
          ? "SELECT p.*,o.name AS organization_name FROM projects p JOIN organizations o ON o.id=p.org_id WHERE p.status NOT IN ('deleted','deleting','purged') ORDER BY o.name,p.created_at DESC"
          : "SELECT p.*,o.name AS organization_name,CASE WHEN p.access='read' OR (m.role<>'admin' AND pm.access='read') THEN 'read' ELSE 'write' END AS effective_access FROM projects p JOIN organizations o ON o.id=p.org_id JOIN organization_memberships m ON m.org_id=p.org_id AND m.user_id=? LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=m.user_id WHERE (m.role='admin' OR pm.user_id IS NOT NULL) AND p.status NOT IN ('deleted','deleting','purged') ORDER BY o.name,p.created_at DESC",
        user.role === "owner" ? [] : [user.id],
      ),
    ]);
    return {
      user,
      organizations: organizations.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        role: r.membership_role,
        libraryAccess: r.library_access,
        defaultHostId: r.default_host_id,
      })),
      projects: projects.map((r) => ({
        id: r.id,
        orgId: r.org_id,
        organizationName: r.organization_name,
        name: r.name,
        description: r.description,
        status: r.status,
        access: r.effective_access ?? r.access,
        createdAt: r.created_at,
      })),
    };
  });
  app.patch("/enterprise/api/me", async (request) => {
    const user = await ctx.requireUser(request);
    const body = objectBody(request.body);
    const name =
      body.name === undefined ? user.name : stringValue(body.name, "name", 160);
    const theme = body.theme === undefined ? user.theme : body.theme;
    if (theme !== "green" && theme !== "cognac")
      throw new AppError(
        400,
        "invalid_request",
        "Theme must be green or cognac",
      );
    const defaultModel =
      body.defaultModel === undefined
        ? (user.defaultModel ?? null)
        : body.defaultModel === null || body.defaultModel === ""
          ? null
          : stringValue(body.defaultModel, "defaultModel", 240);
    await ctx.db.run("UPDATE users SET name=?,theme=?,default_model=? WHERE id=?", [
      name,
      theme,
      defaultModel,
      user.id,
    ]);
    await ctx.audit(user, null, "user.profile_updated", user.id, {
      theme,
      defaultModel,
    });
    return mapUser(
      await ctx.db.get("SELECT * FROM users WHERE id=?", [user.id]),
    );
  });
  app.post("/enterprise/api/password-reset/request", async (request, reply) => {
    const body = objectBody(request.body);
    const email = stringValue(body.email, "email", 254).toLowerCase();
    limit(`reset:${request.ip}:${hashToken(email)}`, 5);
    const row = await ctx.db.get<any>(
      "SELECT * FROM users WHERE email=? AND enabled=1 AND password_hash IS NOT NULL",
      [email],
    );
    if (row) {
      const recent = await ctx.db.get<{
        count: number;
      }>(
        "SELECT COUNT(*) AS count FROM password_reset_tokens WHERE user_id=? AND created_at>?",
        [row.id, new Date(Date.now() - 3600_000).toISOString()],
      );
      if ((recent?.count ?? 0) < 5) {
        const id = randomUUID();
        const token = randomBytes(32).toString("hex");
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
        const resetUrl = `${ctx.config.publicOrigin}/enterprise/reset-password?token=${token}`;
        const job = jobStatement({
          type: "password_reset.deliver",
          idempotencyKey: id,
          payload: {
            resetId: id,
            email: row.email,
            name: row.name,
            resetUrl,
          },
        });
        try {
          await ctx.db.batch([
            {
              sql: "INSERT INTO password_reset_tokens SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM password_reset_tokens WHERE user_id=? AND created_at>?) < 5",
              expectChanges: 1,
              params: [
                id,
                row.id,
                hashToken(token),
                expiresAt,
                null,
                now,
                hashToken(request.ip),
                row.id,
                new Date(Date.now() - 3600_000).toISOString(),
              ],
            },
            job.statement,
          ]);
        } catch (error) {
          // A parallel request can consume the final slot. Keep the public
          // response identical for unknown users and exhausted reset quotas.
          if ((error as Error).message !== "Concurrent update conflict")
            throw error;
        }
      }
    }
    reply.code(202);
    return {
      ok: true,
      message:
        "If an account matches that email, a password reset link will be sent.",
    };
  });
  app.post("/enterprise/api/password-reset/confirm", async (request, reply) => {
    const body = objectBody(request.body);
    const token = stringValue(body.token, "reset token", 128);
    const password = validatePassword(body.password);
    const row = await ctx.db.get<any>(
      "SELECT t.*,u.id AS uid,u.enabled FROM password_reset_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.used_at IS NULL AND t.expires_at>?",
      [hashToken(token), new Date().toISOString()],
    );
    if (!row?.enabled)
      throw new AppError(
        400,
        "invalid_reset",
        "This password reset link has expired or was already used",
      );
    const passwordHash = await hashPassword(password);
    const session = newSession(row.uid);
    const now = new Date().toISOString();
    try {
      await ctx.db.batch([
        {
          sql: "UPDATE password_reset_tokens SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?",
          params: [now, row.id, now],
          expectChanges: 1,
        },
        {
          sql: "UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL",
          params: [now, row.uid],
        },
        {
          sql: "UPDATE users SET password_hash=? WHERE id=? AND enabled=1",
          params: [passwordHash, row.uid],
          expectChanges: 1,
        },
        {
          sql: "DELETE FROM sessions WHERE user_id=?",
          params: [row.uid],
        },
        session.statement,
      ]);
    } catch (e) {
      if ((e as Error).message === "Concurrent update conflict")
        throw new AppError(
          400,
          "invalid_reset",
          "This password reset link has expired or was already used",
        );
      throw e;
    }
    const user = mapUser(
      await ctx.db.get("SELECT * FROM users WHERE id=?", [row.uid]),
    );
    setSessionCookie(reply, ctx.config, session.token);
    await ctx.onAccessChanged?.();
    return {
      user,
      csrfToken: session.csrfToken,
    };
  });
  app.post("/enterprise/api/activate", async (request, reply) => {
    const body = objectBody(request.body);
    const token = stringValue(body.token, "invitation token", 128);
    const password = validatePassword(body.password);
    const invitation = await ctx.db.get<any>(
      "SELECT i.*,u.name FROM invitations i JOIN users u ON u.id=i.user_id JOIN organization_memberships m ON m.user_id=i.user_id AND m.org_id=i.org_id WHERE i.token_hash=? AND i.accepted_at IS NULL AND i.expires_at>?",
      [hashToken(token), new Date().toISOString()],
    );
    if (!invitation)
      throw new AppError(
        400,
        "invalid_invitation",
        "This invitation has expired or was already used",
      );
    const name =
      body.name === undefined
        ? invitation.name
        : stringValue(body.name, "name");
    const passwordHash = await hashPassword(password);
    const session = newSession(invitation.user_id);
    const now = new Date().toISOString();
    try {
      await ctx.db.batch([
        {
          sql: "UPDATE invitations SET accepted_at=? WHERE id=? AND accepted_at IS NULL AND expires_at>?",
          params: [now, invitation.id, now],
          expectChanges: 1,
        },
        {
          sql: "UPDATE users SET password_hash=?,name=?,enabled=1 WHERE id=? AND password_hash IS NULL",
          params: [passwordHash, name, invitation.user_id],
          expectChanges: 1,
        },
        {
          sql: "DELETE FROM sessions WHERE user_id=?",
          params: [invitation.user_id],
        },
        session.statement,
      ]);
    } catch (e) {
      if ((e as Error).message === "Concurrent update conflict")
        throw new AppError(
          400,
          "invalid_invitation",
          "This invitation has expired or was already used",
        );
      throw e;
    }
    const user = mapUser(
      await ctx.db.get("SELECT * FROM users WHERE id=?", [invitation.user_id]),
    );
    setSessionCookie(reply, ctx.config, session.token);
    return {
      user,
      csrfToken: session.csrfToken,
    };
  });
}
