import type { FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { Database } from "./db/index.js";
import type { AppConfig } from "./config.js";
import { readSession } from "./auth/session.js";
export type { Database, SqlValue } from "./db/index.js";
export type { AppConfig } from "./config.js";
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
export interface User {
  id: string;
  orgId: string | null;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
  enabled: boolean;
  theme: "green" | "cognac";
  defaultModel?: string | null;
}
export interface Project {
  id: string;
  orgId: string;
  name: string;
  description: string;
  status: string;
  /** The caller's own effective access, never a project-wide policy. */
  access: "read" | "write";
  createdAt: string;
  hostId: string;
}
export interface AppContext {
  db: Database;
  runtime?: import("../../../packages/runtime/src/types.js").Runtime;
  config: AppConfig;
  onAccessChanged?: () => Promise<void>;
  getSessionId(request: FastifyRequest): Promise<string | null>;
  isSessionActive(sessionId: string, userId: string): Promise<boolean>;
  requireUser(request: FastifyRequest): Promise<User>;
  requireOrgAdmin(user: User, orgId: string): Promise<void>;
  requireOrgMember(user: User, orgId: string): Promise<void>;
  membership(
    user: User,
    orgId: string,
  ): Promise<{ role: "admin" | "member"; libraryAccess: "read" | "write" }>;
  requireLibraryFull(user: User, orgId: string): Promise<void>;
  requireProject(
    user: User,
    projectId: string,
    access?: "read" | "write",
  ): Promise<Project>;
  audit(
    user: User,
    orgId: string | null,
    action: string,
    entityId: string,
    details?: Record<string, unknown>,
  ): Promise<void>;
}
export function mapUser(r: any): User {
  return {
    id: r.id,
    orgId: r.org_id,
    email: r.email,
    name: r.name,
    role: r.role,
    enabled: !!r.enabled,
    theme: r.theme === "cognac" ? "cognac" : "green",
    defaultModel: r.default_model ?? null,
  };
}
export function mapProject(r: any, access: "read" | "write"): Project {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    description: r.description,
    status: r.status,
    access,
    createdAt: r.created_at,
    hostId: r.host_id ?? "local",
  };
}
function auditDetails(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 2000);
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => auditDetails(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .filter(
          ([key]) =>
            !/password|secret|token|credential|authorization|api.?key/i.test(
              key,
            ),
        )
        .map(([key, item]) => [key, auditDetails(item, depth + 1)]),
    );
  return value;
}
export function createContext(db: Database, config: AppConfig): AppContext {
  const fresh = async (user: User) => {
    const r = await db.get<any>(
      "SELECT * FROM users WHERE id=? AND enabled=1",
      [user.id],
    );
    if (!r) throw new AppError(401, "unauthorized", "Sign in to continue");
    return mapUser(r);
  };
  const ctx: AppContext = {
    db,
    config,
    async getSessionId(request) {
      const session = await readSession(
        db,
        request,
        config.secureCookies,
        config.sessionCookieName,
      );
      return session?.id ?? null;
    },
    async isSessionActive(sessionId, userId) {
      return !!(await db.get(
        "SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.expires_at>? AND u.enabled=1",
        [sessionId, userId, new Date().toISOString()],
      ));
    },
    async requireUser(request) {
      const session = await readSession(
        db,
        request,
        config.secureCookies,
        config.sessionCookieName,
      );
      if (!session)
        throw new AppError(401, "unauthorized", "Sign in to continue");
      return session.user;
    },
    async membership(user, orgId) {
      user = await fresh(user);
      if (!(await db.get("SELECT id FROM organizations WHERE id=?", [orgId])))
        throw new AppError(404, "not_found", "Organization not found");
      if (user.role === "owner")
        return { role: "admin", libraryAccess: "write" };
      const membership = await db.get<{
        role: "admin" | "member";
        library_access: "read" | "write";
      }>(
        "SELECT role,library_access FROM organization_memberships WHERE org_id=? AND user_id=?",
        [orgId, user.id],
      );
      if (!membership)
        throw new AppError(404, "not_found", "Organization not found");
      return {
        role: membership.role,
        libraryAccess:
          membership.role === "admin" ? "write" : membership.library_access,
      };
    },
    async requireOrgMember(user, orgId) {
      await ctx.membership(user, orgId);
    },
    async requireOrgAdmin(user, orgId) {
      if ((await ctx.membership(user, orgId)).role !== "admin")
        throw new AppError(
          403,
          "forbidden",
          "Organization administrator access required",
        );
    },
    async requireLibraryFull(user, orgId) {
      if ((await ctx.membership(user, orgId)).libraryAccess !== "write")
        throw new AppError(403, "read_only", "Full library access required");
    },
    async requireProject(user, projectId, requested = "read") {
      const p = await db.get<any>(
        "SELECT * FROM projects WHERE id=? AND status NOT IN ('deleted','deleting','purged')",
        [projectId],
      );
      if (!p) throw new AppError(404, "not_found", "Project not found");
      // Access is per user: owner and organization admins always have full
      // access; everyone else has exactly their project membership grant.
      // The legacy projects.access column is not an authorization input.
      const membership = await ctx.membership(user, p.org_id);
      let effective: "read" | "write" = "write";
      if (membership.role !== "admin") {
        const projectMember = await db.get<{ access: "read" | "write" }>(
          "SELECT access FROM project_members WHERE project_id=? AND user_id=?",
          [projectId, user.id],
        );
        if (!projectMember)
          throw new AppError(404, "not_found", "Project not found");
        effective = projectMember.access === "write" ? "write" : "read";
      }
      if (requested === "write" && effective !== "write")
        throw new AppError(
          403,
          "read_only",
          "Your project access is read-only. Full access is required for this action.",
        );
      return mapProject(p, effective);
    },
    async audit(user, orgId, action, entityId, details = {}) {
      const clean = auditDetails(details);
      await db.run("INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)", [
        randomUUID(),
        orgId,
        user.id,
        action,
        entityId,
        JSON.stringify(clean),
        new Date().toISOString(),
      ]);
    },
  };
  return ctx;
}
export function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AppError(400, "invalid_request", "Expected a JSON object");
  return body as Record<string, unknown>;
}
export function stringValue(
  value: unknown,
  name: string,
  max = 200,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && !value.trim())
  )
    throw new AppError(400, "invalid_request", `Invalid ${name}`);
  return value.trim();
}
export function accessValue(
  value: unknown,
  fallback: "read" | "write" = "write",
): "read" | "write" {
  if (value === undefined) return fallback;
  if (value !== "read" && value !== "write")
    throw new AppError(400, "invalid_request", "Access must be read or write");
  return value;
}
