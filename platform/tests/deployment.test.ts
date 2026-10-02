import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import {
  OrganizationProxyProvisioner,
  proxyConfiguration,
} from "../deploy/provisioning.js";
import { listenSupervisor } from "../deploy/supervisor-listener.js";
import { createSupervisorServer } from "../deploy/supervisor-server.js";
import { createSupervisorClient } from "../deploy/client.js";
import type { Runtime } from "../packages/runtime/src/types.js";
import {
  collectNetworkBoundary,
  configuredBoundary,
  createNetworkBoundaryReader,
  ingressAnswers,
  validateNetworkBoundary,
} from "../deploy/network-boundary.js";
test("inference readiness accepts a configured private subnet and never probes outside its reserved proxy range", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-deploy-subnet-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requested: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      requested.push(String(input));
      return Response.json({ data: [] });
    },
  );
  function registry(address: string, networkSubnet?: string) {
    return new OrganizationProxyProvisioner({
      root: directory,
      image: "wme-proxy:commit",
      network: "separate-inference",
      networkSubnet,
      docker: async (args) => (args[0] === "inspect" ? address : ""),
    });
  }
  // Exercise the production probe, not the injectable test-only probe callback.
  await registry("10.61.93.3", "10.61.93.0/24").ensure(randomUUID());
  await registry("10.61.93.254", "10.61.93.0/24").ensure(randomUUID());
  await registry("172.31.251.3").ensure(randomUUID());
  assert.deepEqual(requested, [
    "http://10.61.93.3:8317/v1/models",
    "http://10.61.93.254:8317/v1/models",
    "http://172.31.251.3:8317/v1/models",
  ]);
  for (const address of [
    "172.31.251.3",
    "10.61.94.3",
    "10.61.93.0",
    "10.61.93.1",
    "10.61.93.2",
    "10.61.93.255",
    "127.0.0.1",
    "1.1.1.1",
    "::1",
    "10.61.93.03",
  ])
    await assert.rejects(
      registry(address, "10.61.93.0/24").ensure(randomUUID()),
      /invalid network address/,
    );
  assert.equal(
    requested.length,
    3,
    "Rejected addresses must never receive a readiness request",
  );
});

test("invalid inference subnet configuration fails before provisioning storage or containers", () => {
  for (const networkSubnet of [
    "0.0.0.0/24",
    "127.0.0.0/24",
    "100.64.0.0/24",
    "203.0.113.0/24",
    "10.61.93.1/24",
    "10.61.0.0/16",
    "10.61.93.0/25",
    "::/24",
  ])
    assert.throws(
      () =>
        new OrganizationProxyProvisioner({
          root: "/never-created-inference-root",
          image: "wme-proxy:commit",
          network: "separate-inference",
          networkSubnet,
          docker: async () => {
            throw new Error("Must not call Docker");
          },
        }),
      /RFC1918/,
    );
});

test("organization provisioning deduplicates racing calls and keeps separate private credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wme-deploy-"));
  try {
    const commands: string[][] = [];
    const id = randomUUID();
    const registry = new OrganizationProxyProvisioner({
      root: directory,
      image: "wme-proxy:commit",
      network: "wme-inference",
      probe: async () => {},
      docker: async (args) => {
        commands.push(args);
        return "";
      },
    });
    const [first, second] = await Promise.all([
      registry.ensure(id),
      registry.ensure(id),
    ]);
    assert.deepEqual(first, second);
    assert.notEqual(first.clientKey, first.managementKey);
    assert.equal(commands.filter((args) => args[0] === "run").length, 1);
    const another = await registry.ensure(randomUUID());
    assert.notEqual(another.clientKey, first.clientKey);
    const run = commands.find((args) => args[0] === "run")!;
    assert.ok(run.includes("--read-only"));
    assert.ok(run.includes("10002:10002"));
    assert.ok(!run.includes("--publish"));
    assert.ok(!run.some((arg) => arg.includes("docker.sock")));
    await assert.rejects(registry.ensure("../../escape"));
    await chmod(join(directory, id, "endpoint.json"), 0o644);
    await assert.rejects(registry.resolve(id), /permissions/);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
test("existing provider configuration survives restarts and foreign containers are rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wme-deploy-"));
  try {
    const id = randomUUID();
    const first = new OrganizationProxyProvisioner({
      root: directory,
      image: "wme-proxy:commit",
      network: "wme-inference",
      probe: async () => {},
      docker: async () => "",
    });
    await first.ensure(id);
    const configPath = join(directory, id, "config", "config.yaml");
    await writeFile(configPath, "administrator-settings-retained", {
      mode: 0o600,
    });
    const restarted = new OrganizationProxyProvisioner({
      root: directory,
      image: "wme-proxy:commit",
      network: "wme-inference",
      probe: async () => {},
      docker: async (args) =>
        args[0] === "ps"
          ? "container-id"
          : args[2] === "{{json .Mounts}}"
            ? JSON.stringify([
                {
                  Source: join(directory, id, "config"),
                  Destination: "/config",
                },
                {
                  Source: join(directory, id, "credentials"),
                  Destination: "/credentials",
                },
              ])
            : args[0] === "inspect"
              ? id
              : "",
    });
    await restarted.ensure(id);
    assert.equal(
      await readFile(configPath, "utf8"),
      "administrator-settings-retained",
    );
    const conflict = new OrganizationProxyProvisioner({
      root: directory,
      image: "wme-proxy:commit",
      network: "wme-inference",
      probe: async () => {},
      docker: async (args) =>
        args[0] === "ps" ? "container-id" : "someone-else",
    });
    await assert.rejects(conflict.ensure(id), /identity conflict/);
    const config = JSON.parse(
      proxyConfiguration({
        baseUrl: "http://proxy:8317",
        clientKey: "client",
        managementKey: "management",
      }),
    );
    assert.equal(config.routing.retry["request-retry"], 0);
    assert.equal(config.management["disable-control-panel"], true);
    assert.equal(config.oauth["auth-dir"], "/credentials");
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
test("authenticated Unix supervisor transports execution and rejects retired executable publishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wme-deploy-"));
  const socketPath = join(directory, "s.sock");
  const token = "b".repeat(64),
    tokenFile = join(directory, "token");
  await writeFile(tokenFile, token, {
    mode: 0o600,
  });
  const canceled: string[] = [];
  const runtime: Runtime = {
    async execute(_input, emit) {
      await emit({
        type: "started",
      });
      await emit({
        type: "assistant_delta",
        delta: "Unicode: 日本語",
      });
      await emit({
        type: "completed",
      });
    },
    async cancel(id) {
      canceled.push(id);
    },
    async recover() {
      return [];
    },
  };
  const endpoint = {
    baseUrl: "http://proxy:8317",
    clientKey: "client",
    managementKey: "manage",
  };
  const server = createSupervisorServer({
    token,
    runtime,
    registry: {
      async resolve() {
        return endpoint;
      },
      async ensure() {
        return endpoint;
      },
    },
    recoveredRunIds: ["interrupted"],
    networkBoundary: () => ({
      addresses: ["203.0.113.10", "127.0.0.1"],
      hostnames: ["host.example"],
    }),
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    const unauthorized = await new Promise<number>((resolve) => {
      const req = request(
        {
          socketPath,
          path: "/v1/network-boundary",
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      req.end();
    });
    assert.equal(unauthorized, 401);
    const client = createSupervisorClient({
      socketPath,
      tokenFile,
    });
    await client.health();
    assert.deepEqual(await client.networkBoundary(), {
      addresses: ["127.0.0.1", "203.0.113.10"],
      hostnames: ["host.example"],
    });
    const events: unknown[] = [];
    await client.runtime.execute({} as any, (event) => {
      events.push(event);
    });
    assert.equal(events.length, 3);
    assert.deepEqual(await client.runtime.recover(), ["interrupted"]);
    await client.runtime.cancel("run-id");
    assert.deepEqual(canceled, ["run-id"]);
    assert.deepEqual(await client.registry.ensure(randomUUID()), endpoint);
    const retired = await new Promise<number>((resolve) => {
      const req = request(
        {
          socketPath,
          path: "/v1/library/start",
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.end("{}");
    });
    assert.equal(retired, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
test("host network boundary returns only bounded normalized address metadata", () => {
  const interfaces = () => ({
    eth0: [
      {
        address: "203.0.113.10",
        netmask: "255.255.255.0",
        family: "IPv4" as const,
        mac: "sensitive-interface-detail",
        internal: false,
        cidr: "203.0.113.10/24",
      },
    ],
  });
  const boundary = collectNetworkBoundary({
    interfaces,
    hostname: () => "Host.EXAMPLE",
    additionalAddresses: ["2001:db8::1", "203.0.113.10"],
    additionalHostnames: ["HOST.example."],
  });
  assert.deepEqual(boundary, {
    addresses: ["2001:db8::1", "203.0.113.10"],
    hostnames: ["host.example"],
  });
  assert.ok(!JSON.stringify(boundary).includes("sensitive-interface-detail"));
  for (const invalid of [
    {
      addresses: [],
      hostnames: [],
    },
    {
      addresses: ["https://public.example"],
      hostnames: [],
    },
    {
      addresses: ["fe80::1%eth0"],
      hostnames: [],
    },
    {
      addresses: ["127.0.0.1"],
      hostnames: ["secret@host"],
    },
    {
      addresses: ["127.0.0.1"],
      hostnames: [],
      token: "must-not-leak",
    },
    {
      addresses: Array(257).fill("127.0.0.1"),
      hostnames: [],
    },
  ])
    assert.throws(() => validateNetworkBoundary(invalid));
  const configured = configuredBoundary({
    WME_PUBLIC_ORIGIN: "https://candidate.test",
    WME_CONTENT_ORIGIN_TEMPLATE: "https://{assetId}.assets.candidate.test",
    WME_EGRESS_INGRESS_HOSTS: "ingress.example",
    WME_EGRESS_DENIED_IPS: "203.0.113.9",
  });
  assert.deepEqual(configured.ingressHostnames, ["ingress.example"]);
  assert.ok(configured.additionalHostnames.includes("assets.candidate.test"));
  assert.deepEqual(configured.additionalAddresses, ["203.0.113.9"]);
  assert.deepEqual(
    configuredBoundary({
      WME_PUBLIC_ORIGIN: "https://[2001:db8::1]",
    }),
    {
      additionalAddresses: ["2001:db8::1"],
      additionalHostnames: [],
      ingressHostnames: [],
    },
  );
  const real = configuredBoundary({
    WME_PUBLIC_ORIGIN: "https://portal.example.com",
    WME_CONTENT_ORIGIN_TEMPLATE: "https://{assetId}.assets.example.com",
  });
  assert.deepEqual(real.ingressHostnames, [
    "00000000-0000-4000-8000-000000000000.assets.example.com",
    "portal.example.com",
  ]);
});
test("ingress DNS boundary caches briefly, refreshes interfaces and fails closed without stale addresses", async () => {
  let clock = 0,
    calls = 0,
    failing = false,
    localAddress = "203.0.113.10";
  const interfaces = () => ({
    eth0: [
      {
        address: localAddress,
        netmask: "255.255.255.0",
        family: "IPv4" as const,
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: localAddress + "/24",
      },
    ],
  });
  const reader = createNetworkBoundaryReader(
    {
      additionalAddresses: [],
      additionalHostnames: ["ingress.example"],
      ingressHostnames: ["ingress.example"],
    },
    {
      interfaces,
      hostname: () => "host.example",
      now: () => clock,
      resolve: async () => {
        calls++;
        if (failing) throw new Error("DNS unavailable");
        return ["198.51.100.20"];
      },
    },
  );
  const [first, second] = await Promise.all([reader(), reader()]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.ok(first.addresses.includes("198.51.100.20"));
  localAddress = "203.0.113.11";
  const fresh = await reader();
  assert.equal(calls, 1);
  assert.ok(fresh.addresses.includes(localAddress));
  assert.ok(!fresh.addresses.includes("203.0.113.10"));
  clock = 5001;
  failing = true;
  await assert.rejects(reader(), /DNS unavailable/);
  failing = false;
  assert.ok((await reader()).addresses.includes("198.51.100.20"));
  assert.equal(calls, 3);
});
test("ingress exclusion DNS requires complete address families and keeps failed batches in flight", async () => {
  const answer: PromiseSettledResult<string[]> = {
    status: "fulfilled",
    value: ["203.0.113.5"],
  };
  const missing = (code: string): PromiseSettledResult<string[]> => ({
    status: "rejected",
    reason: {
      code,
    },
  });
  assert.deepEqual(ingressAnswers([answer, missing("ENODATA")]), [
    "203.0.113.5",
  ]);
  for (const code of [
    "ENOTFOUND",
    "SERVFAIL",
    "ETIMEOUT",
    "EREFUSED",
    "ECANCELLED",
  ])
    assert.throws(() => ingressAnswers([answer, missing(code)]));
  let complete!: (value: string[]) => void;
  const delayed = new Promise<string[]>((resolve) => {
    complete = resolve;
  });
  let calls = 0;
  const reader = createNetworkBoundaryReader(
    {
      additionalAddresses: [],
      additionalHostnames: [],
      ingressHostnames: ["failed.example", "slow.example"],
    },
    {
      resolve: (hostname) => {
        calls++;
        return hostname.startsWith("failed")
          ? Promise.reject(new Error("DNS failed"))
          : delayed;
      },
    },
  );
  const first = reader();
  const firstCheck = assert.rejects(first, /DNS failed/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = reader();
  const secondCheck = assert.rejects(second, /DNS failed/);
  assert.equal(
    calls,
    2,
    "A rejected sibling must not clear a still-running batch",
  );
  complete(["198.51.100.5"]);
  await Promise.all([firstCheck, secondCheck]);
});
test("online SQLite backup captures committed WAL records and validates integrity", async () => {
  // Dynamic absolute import works from both source and compiled test locations.
  const { backupDatabase, checkDatabase } = await import(
    new URL("../../scripts/sqlite-backup.mjs", import.meta.url).href.replace(
      "/dist/scripts/",
      "/scripts/",
    )
  );
  const directory = await mkdtemp(join(tmpdir(), "wme-deploy-"));
  const source = join(directory, "live.sqlite"),
    target = join(directory, "backup.sqlite");
  const db = new DatabaseSync(source);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records (value TEXT)",
  );
  db.prepare("INSERT INTO records VALUES (?)").run("committed-in-WAL");
  try {
    await backupDatabase(source, target);
    const restored = new DatabaseSync(target, {
      readOnly: true,
    });
    assert.equal(
      restored.prepare("SELECT value FROM records").get()!.value,
      "committed-in-WAL",
    );
    restored.close();
    assert.equal(checkDatabase(target).integrity, "ok");
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    const racingTarget = join(directory, "racing.sqlite");
    const races = await Promise.allSettled([
      backupDatabase(source, racingTarget),
      backupDatabase(source, racingTarget),
    ]);
    assert.equal(
      races.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(checkDatabase(racingTarget).integrity, "ok");
    await assert.rejects(backupDatabase(source, target), /existing backup/);
    await assert.rejects(backupDatabase(source, source), /differ/);
    await writeFile(join(directory, "corrupt.sqlite"), "not-a-database");
    assert.throws(() => checkDatabase(join(directory, "corrupt.sqlite")));
  } finally {
    db.close();
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
test("an uncertain runtime cleanup closes transport without fabricating completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wme-deploy-")),
    socketPath = join(directory, "s.sock"),
    tokenFile = join(directory, "token"),
    token = "c".repeat(64);
  await writeFile(tokenFile, token, {
    mode: 0o600,
  });
  const server = createSupervisorServer({
    token,
    runtime: {
      async execute(_input, emit) {
        await emit({
          type: "started",
        });
        throw new Error("Container cleanup not acknowledged");
      },
      async cancel() {
        throw new Error("Uncertain container");
      },
      async recover() {
        return [];
      },
    },
    registry: {
      async resolve() {
        return undefined;
      },
      async ensure() {
        throw new Error("Unused");
      },
    },
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    const events: unknown[] = [];
    await assert.rejects(
      createSupervisorClient({
        socketPath,
        tokenFile,
      }).runtime.execute({} as any, (event) => {
        events.push(event);
      }),
    );
    assert.ok(
      !events.some((event) =>
        ["completed", "failed", "cancelled"].includes((event as any).type),
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
test("authenticated transport detaches without cancelling and reattaches by durable cursor with explicit acknowledgment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-attach-wire-")),
    socketPath = join(directory, "s.sock"),
    tokenFile = join(directory, "token");
  await writeFile(tokenFile, "d".repeat(64), { mode: 0o600 });
  let admitted = 0,
    cancelled = 0,
    detached!: () => void;
  const lost = new Promise<void>((resolve) => {
      detached = resolve;
    }),
    acknowledgments: number[] = [],
    stops: unknown[] = [];
  const server = createSupervisorServer({
    token: "d".repeat(64),
    runtime: {
      async execute(_request, emit, signal) {
        admitted++;
        await emit({ type: "started", sequence: 1 });
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else
            signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        detached();
      },
      async attach(_id, after, emit) {
        assert.equal(after, 1);
        await emit({
          type: "assistant_delta",
          delta: "continued independently",
          sequence: 2,
        });
        await emit({ type: "completed", sequence: 3 });
      },
      async acknowledge(_id, cursor) {
        acknowledgments.push(cursor);
      },
      async stopSession(project, thread, generation) {
        stops.push([project, thread, generation]);
      },
      async cancel() {
        cancelled++;
      },
      async recover() {
        return [];
      },
    },
    registry: {
      async resolve() {
        return undefined;
      },
      async ensure() {
        throw new Error("Unused");
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const client = createSupervisorClient({ socketPath, tokenFile }).runtime,
    controller = new AbortController();
  await assert.rejects(
    client.execute(
      {} as any,
      () => {
        controller.abort();
      },
      controller.signal,
    ),
  );
  await lost;
  assert.equal(cancelled, 0);
  assert.equal(admitted, 1);
  const events: any[] = [];
  await client.attach!("accepted-run", 1, (event) => {
    events.push(event);
  });
  assert.deepEqual(
    events.map((event) => event.sequence),
    [2, 3],
  );
  assert.deepEqual(
    acknowledgments,
    [],
    "a successful socket write is not a transcript acknowledgment",
  );
  await client.acknowledge!("accepted-run", 3);
  assert.deepEqual(acknowledgments, [3]);
  await client.stopSession!("project", "thread", 2);
  assert.deepEqual(stops, [["project", "thread", 2]]);
});
function socketStatus(socketPath: string, route = "/healthz"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: route,
        headers: {
          authorization: `Bearer ${"b".repeat(64)}`,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.once("error", reject);
    req.end();
  });
}
test("a duplicate supervisor cannot recover or cancel the active supervisor's runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wme-owner-"));
  const socketPath = join(directory, "s.sock");
  const first = createServer((_req, res) => res.end("active"));
  const duplicate = createServer();
  let recovered = 0;
  try {
    await listenSupervisor(first, socketPath, async () => {
      recovered++;
    });
    await assert.rejects(
      listenSupervisor(duplicate, socketPath, async () => {
        recovered++;
      }),
      /already running/,
    );
    assert.equal(recovered, 1);
    assert.equal(await socketStatus(socketPath), 200);
  } finally {
    first.closeAllConnections();
    await new Promise<void>((resolve) => first.close(() => resolve()));
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
test("supervisor denies health and work until recovery completes and releases failed startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wme-ready-"));
  const socketPath = join(directory, "s.sock");
  let ready = false;
  const recoveredRunIds: string[] = [];
  const server = createSupervisorServer({
    token: "b".repeat(64),
    ready: () => ready,
    recoveredRunIds,
    runtime: {} as Runtime,
    registry: {} as any,
  });
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return {
      promise,
      resolve,
    };
  };
  const entered = gate();
  const resume = gate();
  const starting = listenSupervisor(server, socketPath, async () => {
    entered.resolve();
    await resume.promise;
    recoveredRunIds.push("recovered-run");
    ready = true;
  });
  try {
    await entered.promise;
    assert.equal(await socketStatus(socketPath), 503);
    assert.equal(await socketStatus(socketPath, "/v1/recovery"), 503);
    assert.equal(
      await socketStatus(socketPath, "/v1/organizations/example"),
      503,
    );
    resume.resolve();
    await starting;
    assert.equal(await socketStatus(socketPath), 200);
  } finally {
    resume.resolve();
    await starting;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const failed = createServer();
  await assert.rejects(
    listenSupervisor(failed, socketPath, async () => {
      throw new Error("recovery failed");
    }),
    /recovery failed/,
  );
  assert.equal(failed.listening, false);
  const retry = createServer((_req, res) => res.end("ready"));
  try {
    await listenSupervisor(retry, socketPath, async () => {});
    assert.equal(await socketStatus(socketPath), 200);
  } finally {
    retry.closeAllConnections();
    await new Promise<void>((resolve) => retry.close(() => resolve()));
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
test(
  "concurrent Linux supervisor restarts recover only once from a stale socket",
  {
    skip: process.platform !== "linux",
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "wme-stale-"));
    const socketPath = join(directory, "s.sock");
    await promisify(execFile)(process.execPath, [
      "-e",
      "require('net').createServer().listen(process.argv[1],()=>process.exit(0))",
      socketPath,
    ]);
    const servers = [createServer(), createServer()];
    let recoveries = 0;
    try {
      const results = await Promise.allSettled(
        servers.map((server) =>
          listenSupervisor(server, socketPath, async () => {
            recoveries++;
          }),
        ),
      );
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(recoveries, 1);
    } finally {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
);
test("ingress boundary supports prefixed and organization asset hostnames", () => {
  for (const prefix of ["preview", "{orgSlug}"]) {
    const value = configuredBoundary({
      WME_PUBLIC_ORIGIN: "https://www.example.com",
      WME_CONTENT_ORIGIN_TEMPLATE: `https://${prefix}-{assetId}.example.com`,
    });
    assert.ok(value.additionalHostnames.includes("example.com"));
    assert.ok(
      value.ingressHostnames.includes(
        `${prefix === "{orgSlug}" ? "org" : prefix}-00000000-0000-4000-8000-000000000000.example.com`,
      ),
    );
  }
  for (const template of [
    "https://example.com/{assetId}",
    "https://example.com",
    "https://user:password@{assetId}.example.com",
    "https://{assetId}.example.com/path",
    "https://{unknown}-{assetId}.example.com",
  ])
    assert.throws(() =>
      configuredBoundary({
        WME_CONTENT_ORIGIN_TEMPLATE: template,
      }),
    );
});
