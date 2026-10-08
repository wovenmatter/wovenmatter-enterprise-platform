import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  type ServerOptions,
} from "node:https";
import { openSource } from "../packages/runtime/src/sandbox.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type {
  Runtime,
  RuntimeRequest,
  ProjectRuntimeSpec,
} from "../packages/runtime/src/types.js";
import { RuntimeError } from "../packages/runtime/src/types.js";
import type { OrganizationProxyProvisioner } from "./provisioning.js";
import {
  validateNetworkBoundary,
  type NetworkBoundary,
} from "./network-boundary.js";
const ID = "[a-zA-Z0-9_-]{1,128}";
export interface SupervisorDependencies {
  token: string;
  hostId?: string;
  runtime: Runtime;
  storageRoot?: string;
  registry: Pick<OrganizationProxyProvisioner, "resolve" | "ensure">;
  recoveredRunIds?: string[];
  ready?: () => boolean;
  networkBoundary?: () => NetworkBoundary | Promise<NetworkBoundary>;
}
async function body(request: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("Request too large");
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
/** Same handler for a private Unix socket or mutually authenticated TLS. */
export function supervisorHandler(deps: SupervisorDependencies) {
  if (!/^[0-9a-f]{64}$/.test(deps.token))
    throw new Error("Supervisor requires a random 256-bit credential");
  return async (request: IncomingMessage, response: ServerResponse) => {
    const actual = Buffer.from(request.headers.authorization ?? ""),
      expected = Buffer.from(`Bearer ${deps.token}`);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      reply(response, 401, {
        error: "unauthorized",
      });
      return;
    }
    if (deps.hostId && request.headers["x-wme-host"] !== deps.hostId) {
      reply(response, 403, {
        error: "wrong_host",
      });
      return;
    }
    if (deps.ready && !deps.ready()) {
      reply(response, 503, {
        error: "supervisor_initializing",
      });
      return;
    }
    const path = request.url ?? "";
    try {
      if (path === "/healthz" && request.method === "GET")
        return reply(response, 200, {
          ready: true,
          hostId: deps.hostId ?? "local",
        });
      if (path === "/v1/network-boundary" && request.method === "GET")
        return reply(
          response,
          deps.networkBoundary ? 200 : 503,
          deps.networkBoundary
            ? validateNetworkBoundary(await deps.networkBoundary())
            : {
                error: "network_boundary_unavailable",
              },
        );
      if (path === "/v1/recovery" && request.method === "GET")
        return reply(response, 200, {
          runIds: deps.recoveredRunIds ?? [],
        });
      let match = path.match(/^\/v1\/storage-probe\/([a-f0-9-]{36})$/);
      if (match && request.method === "GET") {
        if (!deps.storageRoot)
          return reply(response, 503, {
            error: "storage_unverified",
          });
        const file = await openSource(
          deps.storageRoot,
          `.host-probes/${match[1]}`,
        );
        try {
          if ((await file.stat()).size !== 64)
            throw new Error("Invalid storage probe");
          return reply(response, 200, {
            digest: createHash("sha256")
              .update(await file.readFile())
              .digest("hex"),
          });
        } finally {
          await file.close();
        }
      }
      match = path.match(new RegExp(`^/v1/organizations/(${ID})$`));
      if (match && ["GET", "PUT"].includes(request.method ?? "")) {
        return reply(response, 200, {
          endpoint:
            request.method === "PUT"
              ? await deps.registry.ensure(match[1])
              : await deps.registry.resolve(match[1]),
        });
      }
      match = path.match(
        new RegExp(
          `^/v1/projects/(${ID})/(ensure|stop|restore|purge|update|release-asset)$`,
        ),
      );
      if (match && request.method === "POST") {
        const spec = (await body(request)) as ProjectRuntimeSpec;
        if (
          spec.projectId !== match[1] ||
          spec.hostId !== (deps.hostId ?? "local")
        )
          return reply(response, 403, {
            error: "wrong_host",
          });
        const operations = {
          "release-asset": deps.runtime.releaseAsset,
          update: deps.runtime.updateProject,
          ensure: deps.runtime.ensureProject,
          stop: deps.runtime.stopProject,
          restore: deps.runtime.restoreProject,
          purge: deps.runtime.purgeProject,
        };
        const operation = operations[match[2] as keyof typeof operations];
        if (!operation)
          return reply(response, 503, {
            error: "runtime_unavailable",
          });
        await operation.call(deps.runtime, spec);
        return reply(response, 200, {
          ok: true,
        });
      }
      match = path.match(new RegExp(`^/v1/runs/(${ID})/steer$`));
      if (match && request.method === "POST") {
        if (!deps.runtime.steer)
          return reply(response, 409, {
            error: "steering_unavailable",
          });
        const input = await body(request);
        if (
          typeof input.id !== "string" ||
          !new RegExp(`^${ID}$`).test(input.id) ||
          typeof input.content !== "string" ||
          input.content.length > 100000 ||
          !Number.isSafeInteger(input.sequence) ||
          typeof input.authorId !== "string" ||
          typeof input.authorName !== "string"
        )
          return reply(response, 400, {
            error: "invalid_input",
          });
        await deps.runtime.steer(match[1], input);
        return reply(response, 200, {
          ok: true,
        });
      }
      match = path.match(new RegExp(`^/v1/runs/(${ID})$`));
      if (match && request.method === "DELETE") {
        await deps.runtime.cancel(match[1]);
        return reply(response, 200, {
          ok: true,
        });
      }
      match = path.match(
        new RegExp(`^/v1/projects/(${ID})/sessions/(${ID})/stop$`),
      );
      if (match && request.method === "POST") {
        const input = await body(request);
        if (
          !deps.runtime.stopSession ||
          !Number.isSafeInteger(input.generation) ||
          input.generation < 0
        )
          return reply(response, 409, { error: "session_stop_unavailable" });
        await deps.runtime.stopSession(match[1], match[2], input.generation);
        return reply(response, 200, { ok: true });
      }
      match = path.match(new RegExp(`^/v1/runs/(${ID})/acknowledge$`));
      if (match && request.method === "POST") {
        const input = await body(request);
        if (
          !deps.runtime.acknowledge ||
          !Number.isSafeInteger(input.cursor) ||
          input.cursor < 0
        )
          return reply(response, 409, { error: "invalid_cursor" });
        await deps.runtime.acknowledge(match[1], input.cursor);
        return reply(response, 200, { ok: true });
      }
      match = path.match(new RegExp(`^/v1/runs/(${ID})/attach$`));
      if (request.method === "POST" && (path === "/v1/runs" || match)) {
        const input = await body(request),
          controller = new AbortController();
        if (
          match &&
          (!deps.runtime.attach ||
            !Number.isSafeInteger(input.after) ||
            input.after < 0)
        )
          return reply(response, 409, { error: "attachment_unavailable" });
        response.once("close", () => {
          if (!response.writableEnded) controller.abort();
        });
        response.setHeader("content-type", "application/x-ndjson");
        response.setHeader("cache-control", "no-store");
        const emit = async (
          event: import("../packages/runtime/src/types.js").RuntimeEvent,
        ) => {
          if (response.destroyed) throw new Error("Client disconnected");
          if (!response.write(JSON.stringify(event) + "\n"))
            await Promise.race([
              once(response, "drain"),
              once(response, "close").then(() => {
                throw new Error("Client disconnected");
              }),
            ]);
        };
        try {
          if (match)
            await deps.runtime.attach!(
              match[1],
              input.after,
              emit,
              controller.signal,
            );
          else
            await deps.runtime.execute(
              input as RuntimeRequest,
              emit,
              controller.signal,
            );
          response.end();
        } catch (error) {
          if (response.headersSent) response.destroy();
          else
            reply(response, error instanceof RuntimeError ? 409 : 503, {
              error:
                error instanceof RuntimeError
                  ? error.code
                  : "runtime_disconnected",
            });
        }
        return;
      }
      reply(response, 404, {
        error: "not_found",
      });
    } catch (e) {
      if (response.headersSent) response.destroy();
      else
        reply(response, e instanceof RuntimeError ? 409 : 500, {
          error: e instanceof RuntimeError ? e.code : "supervisor_failed",
        });
    }
  };
}
export function createSupervisorServer(deps: SupervisorDependencies) {
  return createServer(
    {
      requestTimeout: 30000,
      headersTimeout: 15000,
      maxHeaderSize: 32768,
    },
    supervisorHandler(deps),
  );
}
export function createTlsSupervisorServer(
  deps: SupervisorDependencies,
  options: ServerOptions,
) {
  return createHttpsServer(
    {
      ...options,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    supervisorHandler(deps),
  );
}
