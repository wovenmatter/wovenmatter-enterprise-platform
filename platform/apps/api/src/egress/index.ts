import {
  createServer,
  request as httpRequest,
  Agent,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createConnection, isIP, type Socket } from "node:net";
import { Transform, type Duplex } from "node:stream";
import {
  Address,
  EgressError,
  isPublicIP,
  parseTarget,
  resolveHost,
  type Target,
} from "./address.js";
import { ExcludedDestinations, type NetworkBoundary } from "./boundary.js";
export { isPublicIP, parseTarget } from "./address.js";
export type { NetworkBoundary } from "./boundary.js";
export interface EgressScope {
  orgId: string;
  projectId: string;
  userId: string;
  runId: string;
}
export interface EgressLimits {
  maxConnections: number;
  maxPerRun: number;
  maxTrackedRuns: number;
  maxRunBytes: number;
  maxConnectionBytes: number;
  dnsTimeoutMs: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  recheckMs: number;
  budgetRetentionMs: number;
}
const defaults: EgressLimits = {
  maxConnections: 128,
  maxPerRun: 8,
  maxTrackedRuns: 4096,
  maxRunBytes: 1024 ** 3,
  maxConnectionBytes: 256 * 1024 ** 2,
  dnsTimeoutMs: 5000,
  connectTimeoutMs: 10000,
  idleTimeoutMs: 60000,
  connectionTimeoutMs: 15 * 60_000,
  recheckMs: 1000,
  budgetRetentionMs: 24 * 3600_000,
};
export interface EgressOptions {
  authorize(projectId: string, token: string): Promise<EgressScope>;
  /** Required trusted host inventory. Never accept these values from an agent. */
  excludedAddresses: readonly string[];
  excludedHostnames: readonly string[];
  /** Required by production wiring; omitted only for static isolated fixtures. */
  getNetworkBoundary?: () => Promise<NetworkBoundary>;
  limits?: Partial<EgressLimits>;
  /** Test seams only. Production resolves and dials the validated address itself. */
  resolve?: (hostname: string, signal: AbortSignal) => Promise<Address[]>;
  dial?: (
    address: Address,
    port: 80 | 443,
    signal: AbortSignal,
  ) => Promise<Socket>;
}
interface Budget {
  key: string;
  scope: EgressScope;
  projectId: string;
  token: string;
  bytes: number;
  expires: number;
  blocked: boolean;
  checking: boolean;
  connections: Set<Connection>;
}
interface Connection {
  controller: AbortController;
  bytes: number;
  budget?: Budget;
  closed: boolean;
  close: () => void;
  timer?: NodeJS.Timeout;
  target?: Target;
  destinationAddresses?: Address[];
}
const dropHeaders = new Set([
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);
function filteredHeaders(
  message: IncomingMessage,
): Record<string, string | string[]> {
  const denied = new Set(dropHeaders);
  for (const item of String(message.headers.connection ?? "").split(","))
    denied.add(item.trim().toLowerCase());
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(message.headers))
    if (value !== undefined && !denied.has(name)) result[name] = value;
  return result;
}
function credentials(request: IncomingMessage): {
  projectId: string;
  token: string;
} {
  if (
    request.rawHeaders.filter(
      (_, i) =>
        i % 2 === 0 &&
        request.rawHeaders[i]?.toLowerCase() === "proxy-authorization",
    ).length !== 1
  )
    throw new EgressError(407, "proxy_authentication_required");
  const header = request.headers["proxy-authorization"];
  if (
    typeof header !== "string" ||
    header.length > 512 ||
    !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(header)
  )
    throw new EgressError(407, "proxy_authentication_required");
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8"),
    colon = decoded.indexOf(":");
  const projectId = decoded.slice(0, colon),
    token = decoded.slice(colon + 1);
  if (
    colon < 0 ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId) ||
    !/^wme_run_[a-zA-Z0-9_-]{43}$/.test(token)
  )
    throw new EgressError(407, "proxy_authentication_required");
  return { projectId, token };
}
async function nativeDial(
  address: Address,
  port: 80 | 443,
  signal: AbortSignal,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({
      host: address.address,
      port,
      family: address.family,
      signal,
    });
    const failed = () =>
      reject(new EgressError(502, "destination_unavailable"));
    socket.once("error", failed);
    socket.once("connect", () => {
      socket.off("error", failed);
      socket.on("error", () => {});
      resolve(socket);
    });
  });
}
async function timed<T>(
  promise: Promise<T>,
  milliseconds: number,
  code: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new EgressError(504, code)),
          milliseconds,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** Internal-only authenticated forward proxy. It never exposes upstream inference credentials. */
export function createEgressProxy(options: EgressOptions) {
  const excluded = new ExcludedDestinations({
    addresses: options.excludedAddresses,
    hostnames: options.excludedHostnames,
  });
  const limits = { ...defaults, ...options.limits };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Invalid egress limit: ${name}`);
  const active = new Set<Connection>(),
    budgets = new Map<string, Budget>(),
    sockets = new Set<Socket>();
  let closing = false,
    pendingResolutions = 0;
  let boundaryRefresh: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  async function refreshBoundary(): Promise<void> {
    if (!options.getNetworkBoundary) return;
    // Retain the in-flight operation even after timeout so stalled metadata work
    // cannot accumulate. Callers fail closed until that same operation settles.
    if (!boundaryRefresh) {
      boundaryRefresh = Promise.resolve()
        .then(options.getNetworkBoundary)
        .then((boundary) => {
          if (closing) return;
          excluded.add(boundary);
          for (const connection of active) {
            try {
              if (connection.target)
                excluded.assertHostname(connection.target.hostname);
              for (const address of connection.destinationAddresses ?? [])
                excluded.assertAddress(address.address);
            } catch {
              connection.close();
            }
          }
        })
        .finally(() => {
          boundaryRefresh = undefined;
        });
    }
    try {
      await timed(
        boundaryRefresh,
        limits.dnsTimeoutMs,
        "network_boundary_unavailable",
      );
    } catch {
      for (const connection of [...active]) connection.close();
      throw new EgressError(503, "network_boundary_unavailable");
    }
  }
  const server = createServer(
    {
      headersTimeout: Math.min(15000, limits.connectionTimeoutMs),
      requestTimeout: limits.connectionTimeoutMs,
      keepAliveTimeout: 1000,
      maxHeaderSize: 32 * 1024,
    },
    (request, response) => void handleHttp(request, response),
  );
  server.maxConnections = limits.maxConnections * 2;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.setTimeout(limits.idleTimeoutMs, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable)
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    else socket.destroy();
  });
  server.on("upgrade", (_request, socket) =>
    socket.end(
      "HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    ),
  );
  server.on(
    "connect",
    (request, socket, head) => void handleConnect(request, socket, head),
  );

  function reserve(destroy: () => void): Connection {
    if (closing || active.size >= limits.maxConnections)
      throw new EgressError(503, "proxy_busy");
    const connection: Connection = {
      controller: new AbortController(),
      bytes: 0,
      closed: false,
      close() {
        if (connection.closed) return;
        connection.closed = true;
        connection.controller.abort();
        if (connection.timer) clearTimeout(connection.timer);
        active.delete(connection);
        connection.budget?.connections.delete(connection);
        destroy();
      },
    };
    connection.timer = setTimeout(connection.close, limits.connectionTimeoutMs);
    connection.timer.unref();
    active.add(connection);
    return connection;
  }
  async function authorize(
    request: IncomingMessage,
    connection: Connection,
  ): Promise<Budget> {
    const auth = credentials(request);
    let scope: EgressScope;
    try {
      scope = await timed(
        options.authorize(auth.projectId, auth.token),
        limits.dnsTimeoutMs,
        "authorization_timeout",
      );
    } catch {
      throw new EgressError(407, "proxy_authentication_required");
    }
    if (connection.closed) throw new EgressError(499, "connection_closed");
    if (scope.projectId !== auth.projectId)
      throw new EgressError(407, "proxy_authentication_required");
    const key = `${scope.orgId}/${scope.projectId}/${scope.userId}/${scope.runId}`;
    let budget = budgets.get(key);
    if (!budget) {
      for (const [id, old] of budgets)
        if (old.expires < Date.now() && !old.connections.size)
          budgets.delete(id);
      if (budgets.size >= limits.maxTrackedRuns)
        throw new EgressError(503, "proxy_busy");
      budget = {
        key,
        scope,
        ...auth,
        bytes: 0,
        expires: Date.now() + limits.budgetRetentionMs,
        blocked: false,
        checking: false,
        connections: new Set(),
      };
      budgets.set(key, budget);
    }
    if (
      budget.blocked ||
      budget.expires < Date.now() ||
      budget.bytes >= limits.maxRunBytes
    )
      throw new EgressError(429, "run_egress_limit");
    if (budget.connections.size >= limits.maxPerRun)
      throw new EgressError(429, "run_connection_limit");
    budget.connections.add(connection);
    connection.budget = budget;
    return budget;
  }
  function consume(connection: Connection, bytes: number): boolean {
    const budget = connection.budget;
    if (connection.closed || !budget || budget.blocked) return false;
    connection.bytes += bytes;
    budget.bytes += bytes;
    if (budget.bytes > limits.maxRunBytes) {
      budget.blocked = true;
      for (const active of [...budget.connections]) active.close();
      return false;
    }
    if (connection.bytes > limits.maxConnectionBytes) {
      connection.close();
      return false;
    }
    return true;
  }
  function meter(connection: Connection): Transform {
    const stream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (consume(connection, chunk.length)) callback(null, chunk);
        else callback(new Error("Egress byte limit reached"));
      },
    });
    stream.on("error", () => connection.close());
    return stream;
  }
  async function destination(
    target: Target,
    connection: Connection,
  ): Promise<Socket> {
    let addresses: Address[];
    excluded.assertHostname(target.hostname);
    await refreshBoundary();
    excluded.assertHostname(target.hostname);
    if (connection.closed) throw new EgressError(499, "connection_closed");
    connection.target = target;
    if (pendingResolutions >= limits.maxConnections)
      throw new EgressError(503, "dns_busy");
    pendingResolutions++;
    const resolution = Promise.resolve()
      .then(() =>
        (options.resolve ?? resolveHost)(
          target.hostname,
          connection.controller.signal,
        ),
      )
      .finally(() => {
        pendingResolutions--;
      });
    try {
      addresses = await timed(resolution, limits.dnsTimeoutMs, "dns_timeout");
    } catch (error) {
      connection.controller.abort();
      if (error instanceof EgressError) throw error;
      throw new EgressError(502, "destination_unavailable");
    }
    if (
      !addresses.length ||
      addresses.length > 64 ||
      addresses.some(
        (address) =>
          isIP(address.address) !== address.family ||
          !isPublicIP(address.address),
      )
    )
      throw new EgressError(403, "private_target");
    await refreshBoundary();
    excluded.assertHostname(target.hostname);
    for (const address of addresses) excluded.assertAddress(address.address);
    connection.destinationAddresses = addresses;
    if (connection.closed) throw new EgressError(499, "connection_closed");
    const promise = (options.dial ?? nativeDial)(
      addresses[0]!,
      target.port,
      connection.controller.signal,
    );
    // Even a test/custom dial that ignores abort may settle after its deadline.
    promise.then(
      (socket) => {
        if (connection.closed || connection.controller.signal.aborted)
          socket.destroy();
      },
      () => {},
    );
    let socket: Socket;
    try {
      socket = await timed(promise, limits.connectTimeoutMs, "connect_timeout");
    } catch (error) {
      connection.controller.abort();
      if (error instanceof EgressError) throw error;
      throw new EgressError(502, "destination_unavailable");
    }
    if (connection.closed || connection.controller.signal.aborted) {
      socket.destroy();
      throw new EgressError(499, "connection_closed");
    }
    socket.setTimeout(limits.idleTimeoutMs, () => connection.close());
    socket.on("error", () => connection.close());
    return socket;
  }
  function errorHttp(response: ServerResponse, error: unknown) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error instanceof EgressError ? error.status : 502;
    response.writeHead(status === 499 ? 502 : status, {
      "content-type": "text/plain",
      "cache-control": "no-store",
      connection: "close",
      ...(status === 407
        ? { "proxy-authenticate": 'Basic realm="WovenMatter Enterprise Platform run"' }
        : {}),
    });
    response.end("Public network request denied or unavailable.");
  }
  async function handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    let connection: Connection | undefined,
      upstream: Socket | undefined,
      agent: Agent | undefined,
      forward: ReturnType<typeof httpRequest> | undefined;
    try {
      request.pause();
      if (
        !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
          request.method ?? "",
        )
      )
        throw new EgressError(405, "method_not_allowed");
      const target = parseTarget(request.url, false);
      connection = reserve(() => {
        upstream?.destroy();
        forward?.destroy();
        agent?.destroy();
        if (!response.writableFinished) response.destroy();
        if (!request.complete) request.destroy();
      });
      response.once("close", connection.close);
      request.once("aborted", connection.close);
      await authorize(request, connection);
      if (
        !consume(connection, Buffer.byteLength(request.rawHeaders.join("\r\n")))
      )
        return;
      upstream = await destination(target, connection);
      agent = new Agent({ keepAlive: false, maxSockets: 1 });
      agent.createConnection = () => upstream!;
      const headers = filteredHeaders(request);
      headers.host = target.authority;
      headers.connection = "close";
      forward = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.path,
          method: request.method,
          headers,
          agent,
        },
        (incoming) => {
          if (connection!.closed) {
            incoming.destroy();
            return;
          }
          if (
            !consume(
              connection!,
              Buffer.byteLength(incoming.rawHeaders.join("\r\n")),
            )
          ) {
            incoming.destroy();
            return;
          }
          // Redirects are returned unchanged. A client must request the new target
          // through this proxy, where it is authenticated and resolved again.
          response.writeHead(incoming.statusCode ?? 502, {
            ...filteredHeaders(incoming),
            connection: "close",
            "proxy-agent": "WovenMatter Enterprise Platform",
          });
          const download = meter(connection!);
          incoming.on("error", () => connection!.close());
          incoming.pipe(download).pipe(response);
          response.once("finish", connection!.close);
        },
      );
      forward.on("error", (error) => {
        if (!connection!.closed) errorHttp(response, error);
        connection!.close();
      });
      request.pipe(meter(connection)).pipe(forward);
      request.resume();
    } catch (error) {
      errorHttp(response, error);
      if (connection) {
        response.once("finish", connection.close);
        if (response.destroyed) connection.close();
      }
    }
  }
  async function handleConnect(
    request: IncomingMessage,
    downstream: Duplex,
    head: Buffer,
  ) {
    let connection: Connection | undefined,
      upstream: Socket | undefined,
      established = false;
    try {
      downstream.pause();
      const target = parseTarget(request.url, true);
      connection = reserve(() => {
        upstream?.destroy();
        downstream.destroy();
      });
      downstream.once("close", connection.close);
      downstream.on("error", connection.close);
      await authorize(request, connection);
      if (
        !consume(
          connection,
          Buffer.byteLength(request.rawHeaders.join("\r\n")) + head.length,
        )
      )
        return;
      upstream = await destination(target, connection);
      if (connection.closed) return;
      downstream.write(
        "HTTP/1.1 200 Connection Established\r\nProxy-Agent: WovenMatter Enterprise Platform\r\n\r\n",
      );
      established = true;
      if (head.length) upstream.write(head);
      upstream.once("close", connection.close);
      downstream.pipe(meter(connection)).pipe(upstream);
      upstream.pipe(meter(connection)).pipe(downstream);
      downstream.resume();
    } catch (error) {
      if (!established && downstream.writable) {
        const status =
          error instanceof EgressError && error.status !== 499
            ? error.status
            : 502;
        downstream.end(
          `HTTP/1.1 ${status} Proxy Request Denied\r\nConnection: close\r\nContent-Length: 0\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="WovenMatter Enterprise Platform run"\r\n' : ""}\r\n`,
          () => connection?.close(),
        );
      } else connection?.close();
    }
  }
  const recheck = setInterval(() => {
    if (active.size) void refreshBoundary().catch(() => {});
    for (const budget of budgets.values()) {
      if (!budget.connections.size || budget.checking) continue;
      if (budget.expires < Date.now()) {
        budget.blocked = true;
        for (const connection of [...budget.connections]) connection.close();
        continue;
      }
      budget.checking = true;
      void timed(
        options.authorize(budget.projectId, budget.token),
        limits.dnsTimeoutMs,
        "authorization_timeout",
      )
        .then((scope) => {
          if (
            scope.orgId !== budget.scope.orgId ||
            scope.projectId !== budget.scope.projectId ||
            scope.userId !== budget.scope.userId ||
            scope.runId !== budget.scope.runId
          )
            throw new Error("Run scope changed");
        })
        .catch(() => {
          budget.blocked = true;
          for (const connection of [...budget.connections]) connection.close();
        })
        .finally(() => {
          budget.checking = false;
        });
    }
  }, limits.recheckMs);
  recheck.unref();
  return {
    async listen(
      host = "0.0.0.0",
      port = 4101,
    ): Promise<{ host: string; port: number }> {
      if (closing) throw new Error("Egress proxy is closed");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          server.off("error", failed);
          server.off("close", interrupted);
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const interrupted = () => failed(new Error("Egress proxy is closed"));
        server.once("error", failed);
        server.once("close", interrupted);
        try {
          server.listen(port, host, () => {
            cleanup();
            if (closing) reject(new Error("Egress proxy is closed"));
            else resolve();
          });
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Egress proxy did not start");
      return { host: address.address, port: address.port };
    },
    close(): Promise<void> {
      if (shutdown) return shutdown;
      closing = true;
      clearInterval(recheck);
      for (const connection of [...active]) connection.close();
      for (const socket of sockets) socket.destroy();
      shutdown = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      ).then(() => {
        budgets.clear();
      });
      return shutdown;
    },
    stats() {
      return {
        connections: active.size,
        pendingResolutions,
        trackedRuns: budgets.size,
        bytes: [...budgets.values()].reduce(
          (sum, budget) => sum + budget.bytes,
          0,
        ),
      };
    },
  };
}
