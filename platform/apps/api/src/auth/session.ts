import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database, Statement } from "../db/index.js";
import type { AppConfig } from "../config.js";
import { mapUser, type User } from "../context.js";
export const SESSION_COOKIE = "wme_session";
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function requestSessionId(
  request: FastifyRequest,
  secureCookies = false,
  sessionCookieName = SESSION_COOKIE,
): string | null {
  const cookies = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim());
  const cookieName = secureCookies
    ? `__Host-${sessionCookieName}`
    : sessionCookieName;
  const raw = cookies
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return raw && /^[a-f0-9]{64}$/.test(raw) ? hashToken(raw) : null;
}
export async function readSession(
  db: Database,
  request: FastifyRequest,
  secureCookies = false,
  sessionCookieName = SESSION_COOKIE,
): Promise<{
  id: string;
  user: User;
  csrfToken: string;
} | null> {
  const id = requestSessionId(request, secureCookies, sessionCookieName);
  if (!id) return null;
  const row = await db.get<any>(
    "SELECT u.*,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>? AND u.enabled=1",
    [id, new Date().toISOString()],
  );
  return row
    ? {
        id,
        user: mapUser(row),
        csrfToken: row.csrf_token,
      }
    : null;
}
export function newSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 12 * 3600_000).toISOString();
  const statement: Statement = {
    sql: "INSERT INTO sessions (id,user_id,csrf_token,expires_at,created_at) VALUES (?,?,?,?,?)",
    params: [hashToken(token), userId, csrfToken, expiresAt, now.toISOString()],
  };
  return {
    token,
    csrfToken,
    expiresAt,
    statement,
  };
}
export function setSessionCookie(
  reply: FastifyReply,
  config: AppConfig,
  token: string,
  clear = false,
) {
  reply.header(
    "set-cookie",
    `${config.secureCookies ? `__Host-${config.sessionCookieName ?? SESSION_COOKIE}` : (config.sessionCookieName ?? SESSION_COOKIE)}=${token}; HttpOnly; SameSite=Lax; Path=${config.secureCookies ? "/" : "/enterprise"}; Max-Age=${clear ? 0 : 43200}${config.secureCookies ? "; Secure" : ""}`,
  );
  reply.header("cache-control", "no-store");
}
