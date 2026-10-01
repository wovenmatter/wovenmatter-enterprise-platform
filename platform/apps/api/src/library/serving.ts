import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { Readable } from "node:stream";
import { AppError, type AppContext } from "../context.js";
import {
  getAsset,
  hash,
  idPattern,
  now,
  safePath,
  shareAccess,
  type ShareRow,
  type VersionRow,
} from "./model.js";
import type { LibraryRuntimeHost } from "./runtime.js";
import { verifyLibrarySources } from "./lifecycle.js";
declare module "fastify" {
  interface FastifyContextConfig {
    libraryContent?: boolean;
  }
}

interface Grant {
  id: string;
  share_id: string;
  user_id: string | null;
  session_id: string | null;
  expires_at: string;
  ticket: number;
}
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const reservedCookie = (name: string) => /^(?:__Host-)?wme[_-]/i.test(name);
const capabilityName = (ctx: AppContext) =>
  ctx.config.secureCookies ? "__Host-wme_asset" : "wme_asset";
const cookie = (request: FastifyRequest, name: string) =>
  request.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${name}=`))
    ?.slice(name.length + 1);
export async function assetOrigin(ctx: AppContext, assetId: string): Promise<string> {
  const slug = typeof ctx.config.contentOriginTemplate === "string" && ctx.config.contentOriginTemplate.includes("{orgSlug}")
    ? (await getAsset(ctx, assetId)).hostname_slug : "org";
  return renderAssetOrigin(ctx, assetId, slug);
}
function renderAssetOrigin(ctx: AppContext, assetId: string, slug: string): string {
  const template = ctx.config.contentOriginTemplate;
  if (
    typeof template !== "string" ||
    !template.includes("{assetId}") ||
    !idPattern.test(assetId)
  )
    throw new AppError(
      503,
      "hosting_unavailable",
      "A separate content origin must be configured.",
    );
  let u: URL;
  try {
    u = new URL(template.replace("{assetId}", assetId).replace("{orgSlug}", slug));
  } catch {
    throw new AppError(
      503,
      "hosting_unavailable",
      "Content origin configuration is invalid.",
    );
  }
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    u.origin === new URL(ctx.config.publicOrigin).origin ||
    !u.hostname.includes(assetId)
  )
    throw new AppError(
      503,
      "hosting_unavailable",
      "Content must use a separate origin per asset.",
    );
  if (ctx.config.secureCookies && u.protocol !== "https:")
    throw new AppError(
      503,
      "hosting_unavailable",
      "Content hosting requires HTTPS.",
    );
  return u.origin;
}
export function contentHostConstraint(ctx: AppContext): RegExp | undefined {
  if (typeof ctx.config.contentOriginTemplate !== "string") return undefined;
  const sample = renderAssetOrigin(ctx, "00000000-0000-0000-0000-000000000000", "orgslugplaceholder");
  const host = new URL(sample).hostname;
  return new RegExp(
    `^${host
      .split("00000000-0000-0000-0000-000000000000")
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("([a-f0-9-]{36})").replace("orgslugplaceholder", "[a-z0-9](?:[a-z0-9-]{0,24}[a-z0-9])?")}(?::[0-9]+)?$`,
    "i",
  );
}
async function hostAsset(ctx: AppContext, request: FastifyRequest) {
  const host = request.headers.host ?? "";
  const match = contentHostConstraint(ctx)?.exec(host);
  if (
    !match?.[1] ||
    !idPattern.test(match[1]) ||
    new URL(await assetOrigin(ctx, match[1])).host.toLowerCase() !==
      host.toLowerCase()
  )
    throw new AppError(404, "not_found", "Not found.");
  return match[1];
}
async function authorized(ctx: AppContext, grant: Grant, assetId: string) {
  if (grant.expires_at <= now())
    throw new AppError(
      401,
      "grant_expired",
      "Open the original share link again.",
    );
  const share = await ctx.db.get<ShareRow>(
    "SELECT * FROM library_shares WHERE id=?",
    [grant.share_id],
  );
  if (!share || share.asset_id !== assetId)
    throw new AppError(404, "share_unavailable", "This link is unavailable.");
  if (
    share.visibility !== "public" &&
    (!grant.user_id ||
      !grant.session_id ||
      !(await ctx.isSessionActive(grant.session_id, grant.user_id)))
  )
    throw new AppError(401, "sign_in_required", "Sign in to view this asset.");
  return { share, asset: await shareAccess(ctx, share, grant.user_id) };
}
async function readGrant(
  ctx: AppContext,
  request: FastifyRequest,
  assetId: string,
) {
  const token = cookie(request, capabilityName(ctx));
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new AppError(
      401,
      "share_required",
      "Open this asset using its share link.",
    );
  const grant = await ctx.db.get<Grant>(
    "SELECT * FROM library_grants WHERE id=? AND ticket=0",
    [hash(token)],
  );
  if (!grant)
    throw new AppError(
      401,
      "grant_expired",
      "Open the original share link again.",
    );
  const auth = await authorized(ctx, grant, assetId);
  return { grant, ...auth };
}
export async function registerContent(
  app: FastifyInstance,
  ctx: AppContext,
  getRuntime: () => LibraryRuntimeHost | undefined,
) {
  app.get<{ Params: { token: string } }>(
    "/share/:token",
    async (req, reply) => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(req.params.token))
        throw new AppError(
          404,
          "share_unavailable",
          "This link is unavailable.",
        );
      const share = await ctx.db.get<ShareRow>(
        "SELECT * FROM library_shares WHERE token_hash=? AND revoked_at IS NULL",
        [hash(req.params.token)],
      );
      if (!share)
        throw new AppError(
          404,
          "share_unavailable",
          "This link is unavailable.",
        );
      let userId: string | null = null,
        sessionId: string | null = null;
      if (share.visibility !== "public") {
        try {
          userId = (await ctx.requireUser(req)).id;
          sessionId = await ctx.getSessionId(req);
        } catch (e) {
          if (e instanceof AppError && e.statusCode === 401)
            return reply.redirect(
              `${ctx.config.publicOrigin}/?returnTo=${encodeURIComponent(`/share/${req.params.token}`)}`,
            );
          throw e;
        }
      }
      const a = await shareAccess(ctx, share, userId),
        origin = await assetOrigin(ctx, a.id),
        ticket = randomBytes(32).toString("base64url");
      await ctx.db.run("DELETE FROM library_grants WHERE expires_at<?", [
        now(),
      ]);
      await ctx.db.run(
        "INSERT INTO library_grants (id,share_id,user_id,session_id,expires_at,ticket) VALUES (?,?,?,?,?,1)",
        [
          hash(ticket),
          share.id,
          userId,
          sessionId,
          new Date(Date.now() + 60_000).toISOString(),
        ],
      );
      return reply
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .redirect(`${origin}/_wme/exchange?ticket=${ticket}`);
    },
  );
  const constraint = contentHostConstraint(ctx);
  if (!constraint) return;
  await app.register(async (contentApp) => {
    let closing = false;
    const activeHttp = new Map<AbortController, () => void>();
    const sockets = new Set<import("node:stream").Duplex>();
    const stopConnections = () => {
      closing = true;
      for (const stop of activeHttp.values()) stop();
      for (const socket of sockets) socket.destroy();
    };
    // onClose runs after the HTTP server drains; abort long-lived responses first.
    contentApp.addHook("preClose", async () => stopConnections());
    // Generated applications receive exact request bytes, including their own form,
    // multipart and binary bodies. Portal JSON parsers remain in the parent scope.
    contentApp.removeAllContentTypeParsers();
    contentApp.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    const config = { libraryContent: true };
    contentApp.get<{ Querystring: { ticket?: string } }>(
      "/_wme/exchange",
      { constraints: { host: constraint }, config },
      async (req, reply) => {
        const assetId = await hostAsset(ctx, req),
          ticket = req.query.ticket;
        if (!ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket))
          throw new AppError(
            401,
            "invalid_ticket",
            "Open the original share link again.",
          );
        const grant = await ctx.db.get<Grant>(
          "SELECT * FROM library_grants WHERE id=? AND ticket=1",
          [hash(ticket)],
        );
        if (!grant)
          throw new AppError(
            401,
            "invalid_ticket",
            "Open the original share link again.",
          );
        await authorized(ctx, grant, assetId);
        const token = randomBytes(32).toString("base64url");
        try {
          await ctx.db.batch([
            {
              sql: "DELETE FROM library_grants WHERE id=? AND ticket=1",
              params: [grant.id],
              expectChanges: 1,
            },
            {
              sql: "INSERT INTO library_grants (id,share_id,user_id,session_id,expires_at,ticket) VALUES (?,?,?,?,?,0)",
              params: [
                hash(token),
                grant.share_id,
                grant.user_id,
                grant.session_id,
                new Date(Date.now() + 3600_000).toISOString(),
              ],
            },
          ]);
        } catch {
          throw new AppError(
            401,
            "invalid_ticket",
            "This link was already used. Open the original share link again.",
          );
        }
        return reply
          .header(
            "Set-Cookie",
            `${capabilityName(ctx)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${ctx.config.secureCookies ? "; Secure" : ""}`,
          )
          .header("Cache-Control", "no-store")
          .header("Referrer-Policy", "no-referrer")
          .redirect("/");
      },
    );
    const handler = async (
      req: FastifyRequest,
      reply: import("fastify").FastifyReply,
    ) => {
      if (closing)
        throw new AppError(503, "shutting_down", "The service is restarting.");
      const assetId = await hostAsset(ctx, req),
        { grant, share, asset } = await readGrant(ctx, req, assetId);
      const origin = await assetOrigin(ctx, assetId);
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        req.headers.origin !== origin
      )
        throw new AppError(
          403,
          "invalid_origin",
          "Application requests must originate from this asset.",
        );
      const versionId = share.version_id ?? asset.current_version_id;
      if (!versionId)
        throw new AppError(
          404,
          "not_published",
          "This asset is not published.",
        );
      const v = await ctx.db.get<VersionRow>(
        "SELECT * FROM library_versions WHERE id=? AND asset_id=?",
        [versionId, asset.id],
      );
      if (!v)
        throw new AppError(
          404,
          "not_published",
          "This version is unavailable.",
        );
      reply
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cross-Origin-Resource-Policy", "same-origin");
      reply.header(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'; worker-src 'none'; frame-ancestors ${ctx.config.publicOrigin}; sandbox allow-scripts allow-same-origin allow-forms allow-downloads`,
      );
      reply.header(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=()",
      );
      if (asset.type === "static") {
        if (!["GET", "HEAD"].includes(req.method))
          throw new AppError(
            405,
            "method_not_allowed",
            "Static assets are read-only.",
          );
        let path: string;
        try {
          path = decodeURIComponent((req.raw.url ?? "/").split("?")[0]!);
        } catch {
          throw new AppError(400, "invalid_path", "Invalid path.");
        }
        const rel = safePath(path === "/" ? v.entrypoint : path.slice(1));
        const dir = join(ctx.config.stateDir, "library", asset.id, v.id);
        let manifest: { path: string; size: number; sha256: string }[];
        try {
          const serialized = await readFile(
            join(dir, ".wme-manifest.json"),
            "utf8",
          );
          if (hash(serialized) !== v.manifest_hash)
            throw new Error("Published manifest identity changed");
          manifest = JSON.parse(serialized);
        } catch {
          throw new AppError(
            503,
            "snapshot_unavailable",
            "Published content is unavailable.",
          );
        }
        const file = manifest.find((f) => f.path === rel);
        if (!file) throw new AppError(404, "file_not_found", "File not found.");
        const bytes = await readFile(join(dir, rel));
        if (bytes.length !== file.size || hash(bytes) !== file.sha256)
          throw new AppError(
            503,
            "snapshot_changed",
            "Published content failed its integrity check.",
          );
        return reply
          .type(mime[extname(rel).toLowerCase()] ?? "application/octet-stream")
          .header("Content-Length", bytes.length)
          .send(req.method === "HEAD" ? undefined : bytes);
      }
      const abort = new AbortController();
      let checking = false,
        revoked = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const cleanup = () => {
        if (timer) clearInterval(timer);
        activeHttp.delete(abort);
        abort.abort();
      };
      activeHttp.set(abort, () => {
        cleanup();
        reply.raw.destroy();
      });
      reply.raw.once("close", cleanup);
      const host = getRuntime();
      if (!host || !v.runtime_id || v.runtime_status !== "running")
        throw new AppError(
          503,
          "runtime_unavailable",
          "Application hosting is unavailable.",
        );
      await verifyLibrarySources(ctx, v.id);
      const state = await host.status(v.runtime_id);
      if (abort.signal.aborted || closing)
        throw new AppError(503, "shutting_down", "The service is restarting.");
      if (state.status !== "running")
        throw new AppError(
          503,
          "runtime_unavailable",
          "The application is not running.",
        );
      const headers: Record<string, string> = {};
      for (const [k, value] of Object.entries(req.headers)) {
        if (
          typeof value !== "string" ||
          [
            "host",
            "authorization",
            "connection",
            "upgrade",
            "content-length",
            "transfer-encoding",
            "accept-encoding",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
          ].includes(k) ||
          k.startsWith("x-wme-") ||
          k.startsWith("x-csrf-")
        )
          continue;
        if (k === "cookie") {
          const filtered = value
            .split(";")
            .filter((x) => !reservedCookie(x.trim().split("=")[0]!))
            .join(";");
          if (filtered) headers.cookie = filtered;
        } else headers[k] = value;
      }
      const payload =
        req.body == null
          ? undefined
          : Buffer.isBuffer(req.body)
            ? req.body
            : typeof req.body === "string"
              ? req.body
              : JSON.stringify(req.body);
      const requestPath = req.raw.url ?? "/";
      if (!requestPath.startsWith("/") || requestPath.startsWith("//"))
        throw new AppError(400, "invalid_path", "Invalid application path.");
      timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void authorized(ctx, grant, assetId)
          .then(() => verifyLibrarySources(ctx, v.id))
          .catch(() => {
            revoked = true;
            abort.abort();
          })
          .finally(() => {
            checking = false;
          });
      }, 1000);
      timer.unref();
      const init: RequestInit = {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method)
          ? undefined
          : (payload as BodyInit | undefined),
        redirect: "manual",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
      };
      let response: Response;
      try {
        if (host.fetch)
          response = await host.fetch(v.runtime_id, requestPath, init);
        else {
          if (!state.origin) throw new Error("No runtime endpoint");
          response = await fetch(
            `${state.origin.replace(/\/$/, "")}${requestPath}`,
            { ...init, headers: { ...headers, ...state.headers } },
          );
        }
      } catch {
        cleanup();
        if (revoked)
          throw new AppError(
            403,
            "access_revoked",
            "Asset access has been revoked.",
          );
        throw new AppError(
          502,
          "application_unreachable",
          "The application did not respond.",
        );
      }
      for (const [k, value] of response.headers) {
        if (
          [
            "set-cookie",
            "content-security-policy",
            "content-length",
            "content-encoding",
            "transfer-encoding",
            "connection",
            "access-control-allow-origin",
            "access-control-allow-credentials",
            "x-frame-options",
            "service-worker-allowed",
            "cache-control",
          ].includes(k)
        )
          continue;
        if (k === "location") {
          try {
            const target = new URL(value, origin);
            if (target.origin !== origin) {
              await response.body?.cancel();
              throw new AppError(
                502,
                "external_redirect_blocked",
                "The application returned an external redirect.",
              );
            }
            reply.header(k, target.pathname + target.search + target.hash);
          } catch (e) {
            if (e instanceof AppError) throw e;
            throw new AppError(
              502,
              "invalid_redirect",
              "The application returned an invalid redirect.",
            );
          }
        } else reply.header(k, value);
      }
      const cookies = response.headers.getSetCookie?.() ?? [];
      const safeCookies = cookies
        .filter((c) => !reservedCookie(c.split("=")[0]!.trim()))
        .map((c) => c.replace(/;\s*Domain=[^;]*/gi, ""));
      if (safeCookies.length) reply.header("Set-Cookie", safeCookies);
      reply.code(response.status);
      if (!response.body || req.method === "HEAD") {
        cleanup();
        return reply.send();
      }
      const upstream = response.body;
      const stream = Readable.from(
        (async function* () {
          let total = 0;
          try {
            for await (const chunk of upstream as unknown as AsyncIterable<Uint8Array>) {
              total += chunk.length;
              if (total > 32 * 1024 * 1024)
                throw new Error("Application response limit exceeded");
              yield chunk;
            }
          } finally {
            cleanup();
            await upstream.cancel().catch(() => {});
          }
        })(),
      );
      abort.signal.addEventListener("abort", () => stream.destroy(), {
        once: true,
      });
      stream.once("close", cleanup);
      req.raw.once("aborted", () => stream.destroy());
      return reply.send(stream);
    };
    for (const url of ["/", "/*"])
      contentApp.route({
        method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        url,
        constraints: { host: constraint },
        config,
        bodyLimit: 2 * 1024 * 1024,
        handler,
      });
    const upgrade = (
      raw: import("node:http").IncomingMessage,
      socket: import("node:stream").Duplex,
      head: Buffer,
    ) => {
      if (!constraint.test(raw.headers.host ?? "")) return;
      if (closing) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      void (async () => {
        const req = { headers: raw.headers, raw } as FastifyRequest,
          assetId = await hostAsset(ctx, req),
          { grant, share, asset } = await readGrant(ctx, req, assetId);
        if (
          raw.headers.origin !== await assetOrigin(ctx, assetId) ||
          asset.type !== "live"
        )
          throw new AppError(
            403,
            "invalid_origin",
            "WebSocket origin is not allowed.",
          );
        const version = await ctx.db.get<VersionRow>(
          "SELECT * FROM library_versions WHERE id=? AND asset_id=?",
          [share.version_id ?? asset.current_version_id, assetId],
        );
        const host = getRuntime();
        if (
          !version?.runtime_id ||
          version.runtime_status !== "running" ||
          !host?.upgrade
        )
          throw new AppError(
            503,
            "websocket_unavailable",
            "WebSocket hosting is not configured.",
          );
        await verifyLibrarySources(ctx, version.id);
        if ((await host.status(version.runtime_id)).status !== "running")
          throw new AppError(
            503,
            "runtime_unavailable",
            "Application is not running.",
          );
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw.headers)) {
          if (
            typeof v !== "string" ||
            ["authorization", "host", "connection", "upgrade"].includes(k) ||
            k.startsWith("x-wme-")
          )
            continue;
          if (k === "cookie") {
            const filtered = v
              .split(";")
              .filter((c) => !reservedCookie(c.trim().split("=")[0]!))
              .join(";");
            if (filtered) headers.cookie = filtered;
          } else headers[k] = v;
        }
        const path = raw.url ?? "/";
        if (!path.startsWith("/") || path.startsWith("//"))
          throw new AppError(400, "invalid_path", "Invalid application path.");
        if (closing || socket.destroyed) return;
        let checking = false;
        const timer = setInterval(() => {
          if (checking) return;
          checking = true;
          void authorized(ctx, grant, assetId)
            .then(() => verifyLibrarySources(ctx, version.id))
            .catch(() => socket.destroy())
            .finally(() => {
              checking = false;
            });
        }, 1000);
        timer.unref();
        socket.once("close", () => clearInterval(timer));
        await host.upgrade(version.runtime_id, path, headers, socket, head);
      })().catch((error) => {
        const code = error instanceof AppError ? error.statusCode : 502;
        if (!socket.destroyed)
          socket.end(
            `HTTP/1.1 ${code} Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
      });
    };
    app.server.on("upgrade", upgrade);
    contentApp.addHook("onClose", async () => {
      app.server.off("upgrade", upgrade);
      stopConnections();
    });
  });
}
