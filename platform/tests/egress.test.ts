import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer as httpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import {
  createServer as tcpServer,
  createConnection,
  Socket as SocketClass,
  type Socket,
} from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createEgressProxy,
  isPublicIP,
  parseTarget,
  type EgressOptions,
  type EgressLimits,
} from "../apps/api/src/egress/index.js";
import { resolveHost, type Address } from "../apps/api/src/egress/address.js";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Timed out");
}
function listen(
  server: ReturnType<typeof httpServer> | ReturnType<typeof tcpServer>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });
}
const basic = (project: string, token: string) =>
  `Basic ${Buffer.from(`${project}:${token}`).toString("base64")}`;
async function fixture(
  limits: Partial<EgressLimits> = {},
  overrides: Partial<EgressOptions> = {},
) {
  const seen: { path: string; headers: IncomingHttpHeaders; body: string }[] =
      [],
    dials: { address: Address; port: number }[] = [];
  const sockets = new Set<Socket>();
  const origin = httpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({
      path: req.url!,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    if (req.url === "/redirect") {
      res.writeHead(302, {
        location: "http://169.254.169.254/latest/meta-data/",
      });
      res.end();
    } else if (req.url === "/large") {
      res.end(Buffer.alloc(4096, 65));
    } else if (req.url === "/hold") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("pending");
    } else {
      res.writeHead(200, {
        "content-type": "text/plain",
        "x-origin": "synthetic",
      });
      res.end("public-response");
    }
  });
  const echo = tcpServer((socket) => {
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  for (const server of [origin, echo])
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
  const originPort = await listen(origin),
    echoPort = await listen(echo);
  const scope = {
    orgId: randomUUID(),
    projectId: randomUUID(),
    userId: randomUUID(),
    runId: randomUUID(),
  };
  const token = `wme_run_${randomBytes(32).toString("base64url")}`;
  let active = true;
  let resolves = 0;
  const dial: EgressOptions["dial"] = async (address, port, signal) => {
    dials.push({ address, port });
    return new Promise((resolve, reject) => {
      const socket = createConnection({
        host: "127.0.0.1",
        port: port === 80 ? originPort : echoPort,
        signal,
      });
      socket.on("error", reject);
      socket.once("connect", () => resolve(socket));
    });
  };
  const proxy = createEgressProxy({
    excludedAddresses: ["8.8.4.4", "2606:4700:4700::1001"],
    excludedHostnames: ["host.example", "platform.example"],
    authorize: async (projectId, value) => {
      if (!active || projectId !== scope.projectId || value !== token)
        throw new Error("not authorized");
      return scope;
    },
    resolve: async () => {
      resolves++;
      return [{ address: "1.1.1.1", family: 4 }];
    },
    dial,
    limits: {
      recheckMs: 20,
      idleTimeoutMs: 2000,
      connectionTimeoutMs: 3000,
      ...limits,
    },
    ...overrides,
  });
  const address = await proxy.listen("127.0.0.1", 0);
  const auth = basic(scope.projectId, token);
  return {
    proxy,
    port: address.port,
    auth,
    token,
    scope,
    seen,
    dials,
    resolves: () => resolves,
    revoke: () => {
      active = false;
    },
    async close() {
      await proxy.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => origin.close(() => resolve())),
        new Promise<void>((resolve) => echo.close(() => resolve())),
      ]);
    },
  };
}
function send(
  port: number,
  auth?: string,
  target = "http://public.example/",
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: target,
        method: body ? "POST" : "GET",
        headers: {
          ...(auth ? { "proxy-authorization": auth } : {}),
          ...headers,
        },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            body: data,
            headers: response.headers,
          }),
        );
      },
    );
    request.on("error", reject);
    request.setTimeout(2500, () => request.destroy(new Error("Test timeout")));
    request.end(body);
  });
}
async function tunnel(
  port: number,
  auth?: string,
  target = "public.example:443",
  head = "",
): Promise<{ socket: Socket; status: number; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Tunnel timeout"));
    }, 2500);
    socket.on("error", reject);
    socket.once("connect", () =>
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n${head}`,
      ),
    );
    const read = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      const end = bytes.indexOf("\r\n\r\n");
      if (end < 0) return;
      clearTimeout(timer);
      socket.pause();
      socket.off("data", read);
      resolve({
        socket,
        status: Number(bytes.toString().split(" ")[1]),
        head: bytes.subarray(end + 4),
      });
    };
    socket.on("data", read);
  });
}
async function receive(
  socket: Socket,
  expected: string,
  initial: Buffer = Buffer.alloc(0),
): Promise<string> {
  if (initial.toString().includes(expected)) return initial.toString();
  return new Promise((resolve, reject) => {
    let text = initial.toString();
    const timer = setTimeout(() => {
      socket.off("data", read);
      reject(new Error("Read timeout"));
    }, 2000);
    const read = (chunk: Buffer) => {
      text += chunk;
      if (text.includes(expected)) {
        clearTimeout(timer);
        socket.off("data", read);
        socket.pause();
        resolve(text);
      }
    };
    socket.on("data", read);
    socket.resume();
  });
}

test("public IP classification blocks private, metadata, documentation and transition ranges", () => {
  for (const ip of [
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.19.1.1",
    "198.51.100.8",
    "203.0.113.2",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001::1",
    "2001:2::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "3fff::1",
    "2606:4700::1%lo",
  ])
    assert.equal(isPublicIP(ip), false, ip);
  for (const ip of [
    "1.1.1.1",
    "8.8.8.8",
    "100.128.0.1",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])
    assert.equal(isPublicIP(ip), true, ip);
});
test("target parser permits only public HTTP80 and CONNECT80/443 forms", () => {
  assert.equal(
    parseTarget("http://EXAMPLE.com/path?q=one", false).hostname,
    "example.com",
  );
  assert.equal(parseTarget("example.com:443", true).port, 443);
  assert.equal(parseTarget("example.com:80", true).port, 80);
  assert.equal(
    parseTarget("http://BÜCHER.example/", false).hostname,
    "xn--bcher-kva.example",
  );
  for (const target of [
    "http://example.com:8080/",
    "https://example.com/",
    "http://user:pass@example.com/",
    "http://example.com/#fragment",
    "http://localhost/",
    "http://localhost./",
    "http://foo.internal./",
    "http://foo.internal/",
    "/relative",
    "http://example.com\\@127.0.0.1/",
  ])
    assert.throws(() => parseTarget(target, false), target);
  for (const target of [
    "example.com:8080",
    "example.com:22",
    "example.com:443/path",
    "user@example.com:443",
    "example.com:443?x",
    "example.com:443\r\nInjected: value",
  ])
    assert.throws(() => parseTarget(target, true), target);
});
test("plain HTTP pins a validated destination and strips proxy and nominated hop headers", async () => {
  const f = await fixture();
  try {
    const result = await send(
      f.port,
      f.auth,
      "http://public.example/package?version=1",
      {
        connection: "x-private-hop",
        "x-private-hop": "must-drop",
        "proxy-connection": "keep-alive",
        authorization: "Bearer destination-key",
      },
      "upload-data",
    );
    assert.equal(result.status, 200);
    assert.equal(result.body, "public-response");
    assert.equal(f.dials[0]?.address.address, "1.1.1.1");
    assert.equal(f.dials[0]?.port, 80);
    assert.equal(f.resolves(), 1);
    assert.equal(f.seen[0]?.path, "/package?version=1");
    assert.equal(f.seen[0]?.headers.host, "public.example");
    assert.equal(f.seen[0]?.headers.authorization, "Bearer destination-key");
    assert.equal(f.seen[0]?.headers["proxy-authorization"], undefined);
    assert.equal(f.seen[0]?.headers["x-private-hop"], undefined);
    assert.equal(f.seen[0]?.headers["proxy-connection"], undefined);
    assert.ok(!JSON.stringify(f.seen).includes(f.token));
    assert.equal(f.seen[0]?.body, "upload-data");
    await until(() => f.proxy.stats().connections === 0);
  } finally {
    await f.close();
  }
});
test("anonymous or cross-project proxy credentials do not resolve or dial any destination", async () => {
  const f = await fixture();
  try {
    assert.equal((await send(f.port)).status, 407);
    assert.equal(
      (await send(f.port, basic(randomUUID(), f.token))).status,
      407,
    );
    const raw = await tunnel(f.port);
    assert.equal(raw.status, 407);
    raw.socket.destroy();
    assert.equal(f.dials.length, 0);
    assert.equal(f.resolves(), 0);
  } finally {
    await f.close();
  }
});
test("any private address in mixed DNS answers denies the entire request before dial", async () => {
  const f = await fixture(
    {},
    {
      resolve: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    },
  );
  try {
    assert.equal((await send(f.port, f.auth)).status, 403);
    assert.equal(f.dials.length, 0);
    const raw = await tunnel(f.port, f.auth);
    assert.equal(raw.status, 403);
    raw.socket.destroy();
    assert.equal(f.dials.length, 0);
  } finally {
    await f.close();
  }
});
test("redirects are not followed and the redirected private address is independently rejected", async () => {
  const f = await fixture(
    {},
    {
      resolve: async (host) => [
        { address: host === "169.254.169.254" ? host : "1.1.1.1", family: 4 },
      ],
    },
  );
  try {
    const redirect = await send(
      f.port,
      f.auth,
      "http://public.example/redirect",
    );
    assert.equal(redirect.status, 302);
    assert.equal(f.dials.length, 1);
    assert.equal(
      (await send(f.port, f.auth, String(redirect.headers.location))).status,
      403,
    );
    assert.equal(f.dials.length, 1);
  } finally {
    await f.close();
  }
});
test("DNS rebinding cannot alter a pinned connection and subsequent private resolution fails closed", async () => {
  let calls = 0;
  const f = await fixture(
    {},
    {
      resolve: async () => [
        { address: ++calls === 1 ? "1.1.1.1" : "127.0.0.1", family: 4 },
      ],
    },
  );
  try {
    assert.equal((await send(f.port, f.auth)).status, 200);
    assert.equal(calls, 1);
    assert.equal(f.dials[0]?.address.address, "1.1.1.1");
    assert.equal((await send(f.port, f.auth)).status, 403);
    assert.equal(f.dials.length, 1);
  } finally {
    await f.close();
  }
});
test("CONNECT tunnels port443 with buffered head counted and revocation closes the tunnel", async () => {
  const f = await fixture();
  try {
    const t = await tunnel(
      f.port,
      f.auth,
      "public.example:443",
      "initial-bytes",
    );
    assert.equal(t.status, 200);
    assert.ok(
      (await receive(t.socket, "initial-bytes", t.head)).includes(
        "initial-bytes",
      ),
    );
    assert.equal(f.dials[0]?.port, 443);
    assert.ok(f.proxy.stats().bytes >= 26);
    f.revoke();
    t.socket.resume();
    await until(() => t.socket.destroyed);
    await until(() => f.proxy.stats().connections === 0);
    assert.equal((await send(f.port, f.auth)).status, 407);
  } finally {
    await f.close();
  }
});
test("per-run and global connection limits bound simultaneous tunnels and clean up after close", async () => {
  const f = await fixture({ maxConnections: 2, maxPerRun: 1 });
  try {
    const first = await tunnel(f.port, f.auth);
    assert.equal(first.status, 200);
    const second = await tunnel(f.port, f.auth);
    assert.equal(second.status, 429);
    second.socket.destroy();
    assert.equal(f.dials.length, 1);
    first.socket.destroy();
    await until(() => f.proxy.stats().connections === 0);
    assert.equal((await send(f.port, f.auth)).status, 200);
  } finally {
    await f.close();
  }
});
test("connection byte limit cuts an established tunnel before forwarding excess data", async () => {
  const f = await fixture({ maxConnectionBytes: 512 });
  try {
    const t = await tunnel(f.port, f.auth);
    assert.equal(t.status, 200);
    t.socket.resume();
    t.socket.write(Buffer.alloc(1024, 65));
    await until(() => t.socket.destroyed);
    await until(() => f.proxy.stats().connections === 0);
  } finally {
    await f.close();
  }
});
test("run byte budget persists after connections close and cannot reset by reconnecting", async () => {
  const f = await fixture({ maxRunBytes: 700, maxConnectionBytes: 10000 });
  try {
    assert.equal((await send(f.port, f.auth)).status, 200);
    await send(f.port, f.auth).catch(() => undefined);
    await send(f.port, f.auth).catch(() => undefined);
    const denied = await send(f.port, f.auth);
    assert.equal(denied.status, 429);
    assert.equal(f.proxy.stats().trackedRuns, 1);
  } finally {
    await f.close();
  }
});
test("unresolved DNS remains counted after timeout instead of allowing unbounded outstanding resolutions", async () => {
  let resolvePending: ((addresses: Address[]) => void) | undefined;
  const f = await fixture(
    { maxConnections: 1, dnsTimeoutMs: 25 },
    {
      resolve: () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
    },
  );
  try {
    assert.equal((await send(f.port, f.auth)).status, 504);
    assert.equal(f.proxy.stats().pendingResolutions, 1);
    assert.equal((await send(f.port, f.auth)).status, 503);
    resolvePending!([{ address: "1.1.1.1", family: 4 }]);
    await until(() => f.proxy.stats().pendingResolutions === 0);
    assert.equal(f.dials.length, 0);
  } finally {
    await f.close();
  }
});
test("proxy close tears down established tunnels and removes tracked budgets", async () => {
  const f = await fixture();
  try {
    const t = await tunnel(f.port, f.auth);
    assert.equal(t.status, 200);
    t.socket.resume();
    await f.proxy.close();
    await until(() => t.socket.destroyed);
    assert.deepEqual(f.proxy.stats(), {
      connections: 0,
      pendingResolutions: 0,
      trackedRuns: 0,
      bytes: 0,
    });
  } finally {
    await f.close();
  }
});

test("a dial settling from its abort event is destroyed and cannot leak a socket", async () => {
  let late: Socket | undefined;
  const f = await fixture(
    { connectTimeoutMs: 20 },
    {
      dial: async (_address, _port, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              late = new SocketClass();
              resolve(late);
            },
            { once: true },
          );
        }),
    },
  );
  try {
    assert.equal((await send(f.port, f.auth)).status, 504);
    await until(() => Boolean(late?.destroyed));
    await until(() => f.proxy.stats().connections === 0);
  } finally {
    await f.close();
  }
});

test("global admission limit rejects new work independently of per-run allowance", async () => {
  const f = await fixture({ maxConnections: 1, maxPerRun: 4 });
  try {
    const t = await tunnel(f.port, f.auth);
    assert.equal(t.status, 200);
    assert.equal((await send(f.port, f.auth)).status, 503);
    assert.equal(f.dials.length, 1);
    t.socket.destroy();
    await until(() => f.proxy.stats().connections === 0);
  } finally {
    await f.close();
  }
});
test("tracked budget count is bounded without evicting a live run usage record", async () => {
  const f = await fixture(
    { maxTrackedRuns: 1 },
    {
      authorize: async (projectId) => ({
        orgId: "org",
        projectId,
        userId: "user",
        runId: projectId,
      }),
    },
  );
  try {
    assert.equal((await send(f.port, f.auth)).status, 200);
    assert.equal(
      (await send(f.port, basic(randomUUID(), f.token))).status,
      503,
    );
    assert.equal(f.proxy.stats().trackedRuns, 1);
    assert.equal(f.dials.length, 1);
  } finally {
    await f.close();
  }
});
test("idle and absolute connection deadlines close tunnels even while authorization remains valid", async () => {
  for (const limits of [
    { idleTimeoutMs: 35, connectionTimeoutMs: 1000 },
    { idleTimeoutMs: 1000, connectionTimeoutMs: 35 },
  ]) {
    const f = await fixture(limits);
    try {
      const t = await tunnel(f.port, f.auth);
      assert.equal(t.status, 200);
      t.socket.resume();
      await until(() => t.socket.destroyed);
      await until(() => f.proxy.stats().connections === 0);
    } finally {
      await f.close();
    }
  }
});
test("ordinary HTTP Upgrade is rejected instead of opening an untracked connection", async () => {
  const f = await fixture();
  try {
    const result = await send(f.port, f.auth, "http://public.example/", {
      connection: "upgrade",
      upgrade: "websocket",
    });
    assert.equal(result.status, 405);
    assert.equal(f.dials.length, 0);
    assert.equal(f.proxy.stats().connections, 0);
  } finally {
    await f.close();
  }
});

test("trusted exclusions are mandatory, bounded and validated before a proxy can start", () => {
  const valid = {
    authorize: async () => ({
      orgId: "org",
      projectId: "project",
      userId: "user",
      runId: "run",
    }),
    excludedAddresses: ["8.8.4.4"],
    excludedHostnames: ["platform.example"],
  };
  for (const invalid of [
    { excludedAddresses: undefined },
    { excludedHostnames: undefined },
    { excludedAddresses: [] },
    { excludedAddresses: ["8.8.4.4/32"] },
    { excludedAddresses: ["2606:4700::1%eth0"] },
    { excludedAddresses: ["8.8.4.999"] },
    { excludedAddresses: Array(257).fill("8.8.4.4") },
    { excludedHostnames: ["https://platform.example"] },
    { excludedHostnames: ["*.platform.example"] },
    { excludedHostnames: ["platform.example:443"] },
    { excludedHostnames: ["platform.example.."] },
    { excludedHostnames: Array(257).fill("platform.example") },
  ])
    assert.throws(() =>
      createEgressProxy({ ...valid, ...invalid } as EgressOptions),
    );
});

test("hostnames are excluded before DNS across case, root dots, subdomains and IDNA", async () => {
  const f = await fixture(
    {},
    { excludedHostnames: ["PLATFORM.Example.", "BÜCHER.example"] },
  );
  try {
    for (const host of [
      "platform.example",
      "PLATFORM.EXAMPLE.",
      "assets.platform.example",
      "xn--bcher-kva.example",
      "B%C3%9CCHER.example",
    ]) {
      assert.equal(
        (await send(f.port, f.auth, `http://${host}/`)).status,
        403,
        host,
      );
    }
    const t = await tunnel(f.port, f.auth, "ASSETS.PLATFORM.EXAMPLE.:443");
    assert.equal(t.status, 403);
    t.socket.destroy();
    assert.equal(f.resolves(), 0);
    assert.equal(f.dials.length, 0);
    assert.equal(
      (await send(f.port, f.auth, "http://not-platform.example/")).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("excluded public literal addresses cannot bypass with URL IPv4 spellings or IPv6 compression", async () => {
  const f = await fixture();
  try {
    for (const target of [
      "http://8.8.4.4/",
      "http://010.010.04.04/",
      "http://0x08080404/",
      "http://134743044/",
      "http://[2606:4700:4700::1001]/",
      "http://[2606:4700:4700:0:0:0:0:1001]/",
    ])
      assert.equal((await send(f.port, f.auth, target)).status, 403, target);
    for (const target of ["8.8.4.4:443", "[2606:4700:4700:0:0:0:0:1001]:443"]) {
      const t = await tunnel(f.port, f.auth, target);
      assert.equal(t.status, 403, target);
      t.socket.destroy();
    }
    assert.equal(f.resolves(), 0);
    assert.equal(f.dials.length, 0);
  } finally {
    await f.close();
  }
});

test("any excluded host address behind a DNS alias denies all answers on HTTP and CONNECT", async () => {
  for (const address of [
    { address: "8.8.4.4", family: 4 as const },
    { address: "2606:4700:4700:0000:0000:0000:0000:1001", family: 6 as const },
  ]) {
    const f = await fixture(
      {},
      { resolve: async () => [{ address: "1.1.1.1", family: 4 }, address] },
    );
    try {
      assert.equal(
        (await send(f.port, f.auth, "http://attacker-alias.example/")).status,
        403,
      );
      const t = await tunnel(f.port, f.auth, "attacker-alias.example:443");
      assert.equal(t.status, 403);
      t.socket.destroy();
      assert.equal(f.dials.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("IPv4 mapped host metadata also excludes its native IPv4 address", async () => {
  const f = await fixture(
    {},
    {
      excludedAddresses: ["::ffff:8.8.4.4"],
      resolve: async () => [{ address: "8.8.4.4", family: 4 }],
    },
  );
  try {
    assert.equal((await send(f.port, f.auth)).status, 403);
    assert.equal(f.dials.length, 0);
  } finally {
    await f.close();
  }
});

test("mapped IPv6 destinations and inconsistent resolver families are rejected before dial", async () => {
  for (const address of [
    { address: "::ffff:8.8.8.8", family: 6 as const },
    { address: "::ffff:808:808", family: 6 as const },
    { address: "1.1.1.1", family: 6 as const },
    { address: "2606:4700::1111", family: 4 as const },
  ]) {
    const f = await fixture({}, { resolve: async () => [address] });
    try {
      assert.equal((await send(f.port, f.auth)).status, 403);
      assert.equal(f.dials.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("excluded configuration is copied and cannot be weakened through later caller mutation", async () => {
  const addresses = ["8.8.4.4"],
    hostnames = ["platform.example"];
  const f = await fixture(
    {},
    { excludedAddresses: addresses, excludedHostnames: hostnames },
  );
  try {
    addresses.length = 0;
    hostnames.length = 0;
    assert.equal((await send(f.port, f.auth, "http://8.8.4.4/")).status, 403);
    assert.equal(
      (await send(f.port, f.auth, "http://platform.example/")).status,
      403,
    );
    assert.equal(f.dials.length, 0);
  } finally {
    await f.close();
  }
});

test("new host interfaces or public hostnames close established tunnels and remain excluded", async () => {
  for (const byHostname of [false, true]) {
    let boundary = { addresses: ["8.8.4.4"], hostnames: [] as string[] };
    const f = await fixture({}, { getNetworkBoundary: async () => boundary });
    try {
      const t = await tunnel(f.port, f.auth);
      assert.equal(t.status, 200);
      t.socket.resume();
      boundary = byHostname
        ? { addresses: ["8.8.4.4"], hostnames: ["PUBLIC.EXAMPLE."] }
        : { addresses: ["1.1.1.1"], hostnames: [] };
      await until(() => t.socket.destroyed);
      await until(() => f.proxy.stats().connections === 0);
      boundary = { addresses: ["9.9.9.9"], hostnames: [] };
      assert.equal((await send(f.port, f.auth)).status, 403);
      assert.equal((await send(f.port, f.auth, "http://8.8.4.4/")).status, 403);
      assert.equal(f.dials.length, 1);
    } finally {
      await f.close();
    }
  }
});

test("boundary refresh applies before DNS and denies a newly excluded hostname", async () => {
  const f = await fixture(
    {},
    {
      getNetworkBoundary: async () => ({
        addresses: ["8.8.4.4"],
        hostnames: ["public.example"],
      }),
    },
  );
  try {
    assert.equal((await send(f.port, f.auth)).status, 403);
    assert.equal(f.resolves(), 0);
    assert.equal(f.dials.length, 0);
  } finally {
    await f.close();
  }
});

test("unavailable or malformed live boundary metadata closes active tunnels and prevents new dials", async () => {
  for (const malformed of [false, true]) {
    let available = true;
    const f = await fixture(
      {},
      {
        getNetworkBoundary: async () => {
          if (available) return { addresses: ["8.8.4.4"], hostnames: [] };
          if (malformed) return { addresses: [], hostnames: [] };
          throw new Error("Supervisor unavailable");
        },
      },
    );
    try {
      const t = await tunnel(f.port, f.auth);
      assert.equal(t.status, 200);
      t.socket.resume();
      available = false;
      await until(() => t.socket.destroyed);
      await until(() => f.proxy.stats().connections === 0);
      await send(f.port, f.auth).catch(() => undefined);
      assert.equal(f.dials.length, 1);
      assert.equal(f.resolves(), 1);
    } finally {
      await f.close();
    }
  }
});

test("a stalled metadata refresh is deduplicated across timeout retries and fails closed", async () => {
  let calls = 0;
  let finish:
    ((value: { addresses: string[]; hostnames: string[] }) => void) | undefined;
  const f = await fixture(
    { dnsTimeoutMs: 25 },
    {
      getNetworkBoundary: () => {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  );
  try {
    await send(f.port, f.auth).catch(() => undefined);
    await send(f.port, f.auth).catch(() => undefined);
    assert.equal(calls, 1);
    assert.equal(f.resolves(), 0);
    assert.equal(f.dials.length, 0);
    finish!({ addresses: ["8.8.4.4"], hostnames: [] });
    await until(() => f.proxy.stats().connections === 0);
  } finally {
    await f.close();
  }
});

test("rebinding from a public destination to a newly owned host address denies a second connection", async () => {
  let calls = 0;
  const f = await fixture(
    {},
    {
      resolve: async () => [
        { address: ++calls === 1 ? "1.1.1.1" : "8.8.4.4", family: 4 },
      ],
    },
  );
  try {
    assert.equal((await send(f.port, f.auth)).status, 200);
    assert.equal((await send(f.port, f.auth)).status, 403);
    assert.equal(f.dials.length, 1);
    assert.equal(f.dials[0]?.address.address, "1.1.1.1");
  } finally {
    await f.close();
  }
});

test("CONNECT80 carries a plain HTTP request without forwarding proxy credentials", async () => {
  const f = await fixture();
  try {
    const t = await tunnel(
      f.port,
      f.auth,
      "public.example:80",
      "GET /node-fetch HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n",
    );
    assert.equal(t.status, 200);
    const response = await receive(t.socket, "public-response", t.head);
    assert.ok(response.includes("200 OK"));
    assert.equal(f.dials[0]?.port, 80);
    assert.equal(f.dials[0]?.address.address, "1.1.1.1");
    assert.equal(f.seen[0]?.path, "/node-fetch");
    assert.equal(f.seen[0]?.headers["proxy-authorization"], undefined);
    assert.ok(!JSON.stringify(f.seen).includes(f.token));
    t.socket.destroy();
    await until(() => f.proxy.stats().connections === 0);
  } finally {
    await f.close();
  }
});

test("CONNECT80 authenticates and rejects host and private destinations before dialing", async () => {
  const f = await fixture(
    {},
    { resolve: async () => [{ address: "169.254.169.254", family: 4 }] },
  );
  try {
    for (const [auth, target, expected] of [
      [undefined, "public.example:80", 407],
      [basic(randomUUID(), f.token), "public.example:80", 407],
      [f.auth, "platform.example:80", 403],
      [f.auth, "8.8.4.4:80", 403],
      [f.auth, "public.example:80", 403],
    ] as const) {
      const t = await tunnel(f.port, auth, target);
      assert.equal(t.status, expected, target);
      t.socket.destroy();
    }
    assert.equal(f.dials.length, 0);
  } finally {
    await f.close();
  }
});

test("CONNECT80 closes on run revocation or a newly excluded public host address", async () => {
  for (const revoke of [false, true]) {
    let addresses = ["8.8.4.4"];
    const f = await fixture(
      {},
      { getNetworkBoundary: async () => ({ addresses, hostnames: [] }) },
    );
    try {
      const t = await tunnel(
        f.port,
        f.auth,
        "public.example:80",
        "GET /hold HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n",
      );
      assert.equal(t.status, 200);
      assert.ok(
        (await receive(t.socket, "pending", t.head)).includes("pending"),
      );
      t.socket.resume();
      if (revoke) f.revoke();
      else addresses = ["1.1.1.1"];
      await until(() => t.socket.destroyed);
      await until(() => f.proxy.stats().connections === 0);
    } finally {
      await f.close();
    }
  }
});

test("partial DNS timeouts, failures and contradictory NXDOMAIN never accept the other family's public address", async () => {
  for (const code of [
    "ETIMEOUT",
    "ESERVFAIL",
    "EREFUSED",
    "ECANCELLED",
    "ENOTFOUND",
    undefined,
  ]) {
    for (const failedFamily of [4, 6]) {
      await assert.rejects(
        resolveHost("synthetic.example", undefined, () => ({
          resolve4: async () => {
            if (failedFamily === 4)
              throw Object.assign(new Error("DNS fixture failure"), { code });
            return ["1.1.1.1"];
          },
          resolve6: async () => {
            if (failedFamily === 6)
              throw Object.assign(new Error("DNS fixture failure"), { code });
            return ["2606:4700::1111"];
          },
          cancel() {},
        })),
        { code: "incomplete_dns_resolution" },
        `${String(code)} family ${failedFamily}`,
      );
    }
  }
});

test("conclusive absent DNS families and fully resolved mixed families preserve all answers", async () => {
  const absent = (code: string) => async (): Promise<string[]> => {
    throw Object.assign(new Error("Absent family"), { code });
  };
  assert.deepEqual(
    await resolveHost("synthetic.example", undefined, () => ({
      resolve4: async () => ["1.1.1.1"],
      resolve6: absent("ENODATA"),
      cancel() {},
    })),
    [{ address: "1.1.1.1", family: 4 }],
  );
  assert.deepEqual(
    await resolveHost("synthetic.example", undefined, () => ({
      resolve4: absent("ENODATA"),
      resolve6: async () => ["2606:4700::1111"],
      cancel() {},
    })),
    [{ address: "2606:4700::1111", family: 6 }],
  );
  assert.deepEqual(
    await resolveHost("synthetic.example", undefined, () => ({
      resolve4: absent("ENOTFOUND"),
      resolve6: absent("ENOTFOUND"),
      cancel() {},
    })),
    [],
  );
  assert.deepEqual(
    await resolveHost("synthetic.example", undefined, () => ({
      resolve4: async () => ["1.1.1.1"],
      resolve6: async () => ["fd00::1"],
      cancel() {},
    })),
    [
      { address: "1.1.1.1", family: 4 },
      { address: "fd00::1", family: 6 },
    ],
  );
});

test("native resolver cancellation aborts both outstanding families and removes its abort listener", async () => {
  const controller = new AbortController();
  let reject4: ((reason: Error) => void) | undefined,
    reject6: ((reason: Error) => void) | undefined,
    cancelled = 0;
  const result = resolveHost("synthetic.example", controller.signal, () => ({
    resolve4: () =>
      new Promise((_, reject) => {
        reject4 = reject;
      }),
    resolve6: () =>
      new Promise((_, reject) => {
        reject6 = reject;
      }),
    cancel() {
      cancelled++;
      reject4!(Object.assign(new Error("Cancelled"), { code: "ECANCELLED" }));
      reject6!(Object.assign(new Error("Cancelled"), { code: "ECANCELLED" }));
    },
  }));
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(cancelled, 1);
});

test("shutdown settles a pending listen and concurrent closes await the same cleanup", async () => {
  const proxy = createEgressProxy({
    excludedAddresses: ["8.8.4.4"],
    excludedHostnames: [],
    authorize: async () => {
      throw new Error("Not used by fixture");
    },
  });
  const starting = proxy.listen("127.0.0.1", 0);
  const rejected = assert.rejects(starting, /closed/);
  const first = proxy.close(),
    second = proxy.close();
  assert.equal(first, second);
  await Promise.all([first, second, rejected]);
  await assert.rejects(proxy.listen("127.0.0.1", 0), /closed/);
  assert.deepEqual(proxy.stats(), {
    connections: 0,
    pendingResolutions: 0,
    trackedRuns: 0,
    bytes: 0,
  });
});
