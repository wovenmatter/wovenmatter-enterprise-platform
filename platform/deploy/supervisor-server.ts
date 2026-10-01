import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { isIP } from "node:net";
import type { Runtime, RuntimeRequest } from "../packages/runtime/src/types.ts";
import type { OrganizationProxyProvisioner } from "./provisioning.ts";
import type { LibraryLaunch, LibraryProcess } from "./client.ts";
import {
  validateNetworkBoundary,
  type NetworkBoundary,
} from "./network-boundary.js";
const ID = "[a-zA-Z0-9_-]{1,128}";
export interface SupervisorDependencies {
  token: string;
  runtime: Runtime;
  registry: Pick<OrganizationProxyProvisioner, "resolve" | "ensure">;
  recoveredRunIds?: string[];
  ready?: () => boolean;
  networkBoundary?: () => NetworkBoundary | Promise<NetworkBoundary>;
  /** Injected by unit tests only; production app backends use isolated bridge IP:8789. */
  allowTestLoopback?: boolean;
  library?: {
    start(input: LibraryLaunch): Promise<LibraryProcess>;
    status(id: string): Promise<LibraryProcess>;
    stop(id: string): Promise<void>;
    resume?(id: string): Promise<LibraryProcess>;
  };
}
function libraryOrigin(value: string, allowTestLoopback = false): URL {
  const origin = new URL(value);
  const privateIPv4 =
    isIP(origin.hostname) === 4 &&
    /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(origin.hostname);
  if (
    origin.protocol !== "http:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !(
      (privateIPv4 && origin.port === "8789") ||
      (allowTestLoopback && origin.hostname === "127.0.0.1" && origin.port)
    )
  )
    throw new Error("Invalid isolated asset backend");
  return origin;
}
async function body(request: IncomingMessage): Promise<any> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function reply(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
const forbiddenHeaders = new Set([
  "authorization",
  "host",
  "connection",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
  "content-length",
]);
const reservedCookie = (name: string) => /^(?:__Host-)?wme[_-]/i.test(name);
function safeRequestHeaders(
  raw: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (
      forbiddenHeaders.has(name.toLowerCase()) ||
      name.toLowerCase().startsWith("x-wme-") ||
      typeof value !== "string"
    )
      continue;
    headers[name] =
      name.toLowerCase() === "cookie"
        ? value
            .split(";")
            .filter((c) => !reservedCookie(c.trim().split("=")[0]!))
            .join(";")
        : value;
  }
  return headers;
}
function handshakeLines(response: IncomingMessage): string[] {
  const lines = [`HTTP/1.1 ${response.statusCode} Switching Protocols`];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index]!,
      value = response.rawHeaders[index + 1]!;
    if (name.toLowerCase() === "set-cookie") {
      if (!reservedCookie(value.split("=")[0]!.trim()))
        lines.push(`${name}: ${value.replace(/;\s*Domain=[^;]*/gi, "")}`);
    } else lines.push(`${name}: ${value}`);
  }
  return lines;
}
export function createSupervisorServer(deps: SupervisorDependencies) {
  if (!/^[0-9a-f]{64}$/.test(deps.token))
    throw new Error("Supervisor requires a random 256-bit credential");
  const server = createServer(
    { requestTimeout: 30_000, headersTimeout: 15_000, maxHeaderSize: 32_768 },
    async (request, response) => {
      const credential = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${deps.token}`);
      if (
        credential.length !== expected.length ||
        !timingSafeEqual(credential, expected)
      ) {
        reply(response, 401, { error: "unauthorized" });
        return;
      }
      if (deps.ready && !deps.ready()) {
        reply(response, 503, { error: "supervisor_initializing" });
        return;
      }
      const path = request.url ?? "";
      try {
        if (path === "/healthz" && request.method === "GET")
          return reply(response, 200, { ready: true });
        if (path === "/v1/network-boundary" && request.method === "GET") {
          if (!deps.networkBoundary)
            return reply(response, 503, {
              error: "network_boundary_unavailable",
            });
          return reply(
            response,
            200,
            validateNetworkBoundary(await deps.networkBoundary()),
          );
        }
        if (path === "/v1/recovery" && request.method === "GET")
          return reply(response, 200, { runIds: deps.recoveredRunIds ?? [] });
        let match = path.match(new RegExp(`^/v1/organizations/(${ID})$`));
        if (match && ["GET", "PUT"].includes(request.method ?? "")) {
          const existing =
            request.method === "GET"
              ? await deps.registry.resolve(match[1]!)
              : undefined;
          return reply(response, 200, {
            endpoint:
              request.method === "PUT" || existing
                ? await deps.registry.ensure(match[1]!)
                : undefined,
          });
        }
        match = path.match(new RegExp(`^/v1/runs/(${ID})$`));
        if (match && request.method === "DELETE") {
          await deps.runtime.cancel(match[1]!);
          return reply(response, 200, { ok: true });
        }
        if (path === "/v1/runs" && request.method === "POST") {
          const input = (await body(request)) as RuntimeRequest;
          const controller = new AbortController();
          response.once("close", () => {
            if (!response.writableEnded) controller.abort();
          });
          response.writeHead(200, {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
          });
          try {
            await deps.runtime.execute(
              input,
              async (event) => {
                if (response.destroyed) throw new Error("Client disconnected");
                if (!response.write(JSON.stringify(event) + "\n"))
                  await Promise.race([
                    once(response, "drain"),
                    once(response, "close").then(() => {
                      throw new Error("Client disconnected");
                    }),
                  ]);
              },
              controller.signal,
            );
          } catch {
            // A thrown driver operation can mean container cleanup was not acknowledged.
            // Closing without a terminal event preserves the caller's uncertain execution lease.
            response.destroy();
            return;
          }
          response.end();
          return;
        }
        if (
          path === "/v1/library/start" &&
          request.method === "POST" &&
          deps.library
        )
          return reply(
            response,
            200,
            await deps.library.start(await body(request)),
          );
        match = path.match(new RegExp(`^/v1/library/(${ID})/resume$`));
        if (match && request.method === "POST" && deps.library?.resume)
          return reply(response, 200, await deps.library.resume(match[1]!));
        match = path.match(new RegExp(`^/v1/library/(${ID})$`));
        if (match && deps.library) {
          if (request.method === "GET")
            return reply(response, 200, await deps.library.status(match[1]!));
          if (request.method === "DELETE") {
            await deps.library.stop(match[1]!);
            return reply(response, 200, { ok: true });
          }
        }
        match = path.match(new RegExp(`^/v1/library/(${ID})/http$`));
        if (match && request.method === "POST" && deps.library) {
          const process = await deps.library.status(match[1]!);
          if (process.status !== "running" || !process.origin)
            return reply(response, 503, { error: "asset_unavailable" });
          const origin = libraryOrigin(process.origin, deps.allowTestLoopback);
          const method = String(request.headers["x-wme-method"] ?? "GET");
          const path = Buffer.from(
            String(request.headers["x-wme-path"] ?? ""),
            "base64url",
          ).toString("utf8");
          if (
            ![
              "GET",
              "HEAD",
              "POST",
              "PUT",
              "PATCH",
              "DELETE",
              "OPTIONS",
            ].includes(method) ||
            !path.startsWith("/") ||
            path.startsWith("//") ||
            /[\r\n\\]/.test(path)
          )
            throw new Error("Invalid asset request");
          const rawHeaders = JSON.parse(
            Buffer.from(
              String(request.headers["x-wme-headers"] ?? "e30"),
              "base64url",
            ).toString("utf8"),
          ) as Record<string, unknown>;
          const headers = safeRequestHeaders(rawHeaders);
          const upstream = httpRequest(
            {
              hostname: origin.hostname,
              port: origin.port,
              path,
              method,
              headers,
            },
            (incoming) => {
              const outgoing: Record<string, string | string[]> = {};
              for (const [name, value] of Object.entries(incoming.headers))
                if (
                  value &&
                  !["connection", "transfer-encoding"].includes(name)
                )
                  outgoing[name] = value;
              response.writeHead(incoming.statusCode ?? 502, outgoing);
              incoming.pipe(response);
            },
          );
          upstream.once("error", () => {
            if (!response.headersSent)
              reply(response, 502, { error: "asset_unavailable" });
            else response.destroy();
          });
          upstream.setTimeout(120_000, () => upstream.destroy());
          response.once("close", () => upstream.destroy());
          request.pipe(upstream);
          return;
        }
        reply(response, 404, { error: "not_found" });
      } catch {
        if (!response.headersSent)
          reply(response, 400, { error: "operation_failed" });
        else response.destroy();
      }
    },
  );
  server.on("upgrade", async (request, downstream, head) => {
    const credential = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${deps.token}`);
    const match = (request.url ?? "").match(
      new RegExp(`^/v1/library/(${ID})/ws$`),
    );
    if (
      credential.length !== expected.length ||
      !timingSafeEqual(credential, expected) ||
      !match ||
      (deps.ready && !deps.ready()) ||
      !deps.library
    ) {
      downstream.destroy();
      return;
    }
    try {
      const process = await deps.library.status(match[1]!);
      if (process.status !== "running" || !process.origin)
        throw new Error("Asset unavailable");
      const origin = libraryOrigin(process.origin, deps.allowTestLoopback);
      const path = Buffer.from(
        String(request.headers["x-wme-path"] ?? ""),
        "base64url",
      ).toString("utf8");
      if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        /[\r\n\\]/.test(path)
      )
        throw new Error("Invalid asset path");
      const rawHeaders = JSON.parse(
        Buffer.from(
          String(request.headers["x-wme-headers"] ?? "e30"),
          "base64url",
        ).toString("utf8"),
      ) as Record<string, unknown>;
      const headers: Record<string, string> = {
        ...safeRequestHeaders(rawHeaders),
        connection: "Upgrade",
        upgrade: "websocket",
      };
      const upstreamRequest = httpRequest({
        hostname: origin.hostname,
        port: origin.port,
        path,
        method: "GET",
        headers,
      });
      upstreamRequest.once("upgrade", (response, upstream, upstreamHead) => {
        const lines = handshakeLines(response);
        downstream.write(lines.join("\r\n") + "\r\n\r\n");
        if (upstreamHead.length) downstream.write(upstreamHead);
        if (head.length) upstream.write(head);
        downstream.on("error", () => upstream.destroy());
        upstream.on("error", () => downstream.destroy());
        downstream.on("close", () => upstream.destroy());
        upstream.on("close", () => downstream.destroy());
        downstream.pipe(upstream).pipe(downstream);
      });
      upstreamRequest.once("response", (response) => {
        response.destroy();
        downstream.destroy();
      });
      upstreamRequest.once("error", () => downstream.destroy());
      downstream.once("close", () => upstreamRequest.destroy());
      upstreamRequest.setTimeout(15_000, () => upstreamRequest.destroy());
      upstreamRequest.end();
    } catch {
      downstream.destroy();
    }
  });
  return server;
}
