import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { chmod, chown, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import type { RuntimeRequest } from "./types.js";

/** Stable private session endpoints. Native processes never receive upstream capabilities. */
export async function sessionBroker(
  directory: string,
  projectId: string,
  egress: { origin?: string; token?: string },
  currentEgress = async () => egress,
) {
  await mkdir(directory, { recursive: true, mode: 0o750 });
  await chown(directory, 0, 10001);
  await chmod(directory, 0o750);
  const token = randomBytes(32).toString("hex");
  let active: RuntimeRequest["gateway"] | undefined;
  let retired = false;
  const sockets = new Set<Socket>(),
    inference = new Set<Socket>();
  const gateway = createServer(
    { requestTimeout: 120000, maxHeaderSize: 32768 },
    (req, res) => {
      const grant = active,
        path = req.url ?? "";
      if (
        !grant ||
        req.headers.authorization !== `Bearer ${token}` ||
        !path.startsWith("/inference/") ||
        path.includes("..") ||
        path.includes("%")
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      const url = new URL(
        grant.baseUrl.replace(/\/$/, "") + path.slice("/inference".length),
      );
      const upstream = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: req.method,
          headers: {
            "content-type": String(
              req.headers["content-type"] ?? "application/json",
            ),
            authorization: `Bearer ${grant.token}`,
          },
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, {
            "content-type": String(
              reply.headers["content-type"] ?? "application/json",
            ),
          });
          reply.pipe(res);
        },
      );
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) upstream.destroy();
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    },
  );
  gateway.on("connection", (socket) => {
    inference.add(socket);
    socket.once("close", () => inference.delete(socket));
  });
  const servers = [gateway];
  const localAuthorization =
    "Basic " + Buffer.from(`${projectId}:${token}`).toString("base64");
  if (egress.origin && egress.token) {
    const upstreamOptions = async (
      source: import("node:http").IncomingMessage,
    ) => {
      const grant = await currentEgress();
      if (retired || !grant.origin || !grant.token)
        throw new Error("Egress disabled");
      const origin = new URL(grant.origin);
      return {
        hostname: origin.hostname,
        port: origin.port,
        path: source.url,
        method: source.method,
        headers: {
          ...source.headers,
          "proxy-authorization":
            "Basic " +
            Buffer.from(`${projectId}:${grant.token}`).toString("base64"),
        },
      };
    };
    const proxy = createServer(
      { requestTimeout: 120000, maxHeaderSize: 32768 },
      (req, res) => {
        if (req.headers["proxy-authorization"] !== localAuthorization) {
          res.writeHead(407);
          res.end();
          return;
        }
        void upstreamOptions(req)
          .then((options) => {
            const upstream = httpRequest(options, (reply) => {
              res.writeHead(reply.statusCode ?? 502, reply.headers);
              reply.pipe(res);
            });
            upstream.on("error", () => {
              if (!res.headersSent) res.writeHead(502);
              res.end();
            });
            res.on("close", () => upstream.destroy());
            req.pipe(upstream);
          })
          .catch(() => {
            if (!res.headersSent) res.writeHead(403);
            res.end();
          });
      },
    );
    proxy.on("connect", (req, socket, head) => {
      if (req.headers["proxy-authorization"] !== localAuthorization) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        return;
      }
      void upstreamOptions(req)
        .then((options) => {
          const upstream = httpRequest({ ...options, method: "CONNECT" });
          upstream.on("connect", (reply, tunnel, upstreamHead) => {
            sockets.add(tunnel);
            tunnel.once("close", () => sockets.delete(tunnel));
            if (reply.statusCode !== 200) {
              tunnel.destroy();
              socket.end(
                `HTTP/1.1 ${reply.statusCode ?? 502} Proxy Error\r\n\r\n`,
              );
              return;
            }
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (upstreamHead.length) socket.write(upstreamHead);
            if (head.length) tunnel.write(head);
            socket.pipe(tunnel).pipe(socket);
            socket.on("error", () => tunnel.destroy());
            tunnel.on("error", () => socket.destroy());
            socket.on("close", () => tunnel.destroy());
            tunnel.on("close", () => socket.destroy());
          });
          upstream.on("error", () => socket.destroy());
          socket.on("close", () => upstream.destroy());
          upstream.end();
        })
        .catch(() => socket.destroy());
    });
    servers.push(proxy);
  }
  try {
    for (const [index, server] of servers.entries()) {
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      const path = join(directory, index ? "egress.sock" : "gateway.sock");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });
      await chmod(path, 0o660);
      await chown(path, 0, 10001);
    }
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }
  return {
    token,
    activeGateway: () => (retired ? undefined : active),
    setGateway(value?: RuntimeRequest["gateway"]) {
      for (const socket of inference) socket.destroy();
      active = retired ? undefined : value;
    },
    close() {
      retired = true;
      active = undefined;
      for (const server of servers) server.close();
      for (const socket of sockets) socket.destroy();
    },
    hasEgress: servers.length > 1,
  };
}
