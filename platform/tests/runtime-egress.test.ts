import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRuntimeEgress } from "../apps/api/src/runtime-egress.js";
import { loadConfig } from "../apps/api/src/config.js";
import type { Runtime, RuntimeRequest } from "../packages/runtime/src/types.js";

const request: RuntimeRequest = {
  runId: "test-run",
  organizationId: "test-org",
  projectId: "test-project",
  conversationId: "test-thread",
  harness: "pi",
  model: "test-model",
  prompt: "Synthetic test",
  access: "read",
  mounts: [],
  sessionDirectory: "/synthetic/session",
  gateway: {
    baseUrl: "http://api:4100/enterprise/api/runtime/inference/test-project",
    token: `wme_run_${randomBytes(32).toString("base64url")}`,
  },
};
function proxyCall(port: number, token?: string, target = "http://127.0.0.1/") {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: target,
        headers: token
          ? {
              "proxy-authorization": `Basic ${Buffer.from(`${request.projectId}:${token}`).toString("base64")}`,
            }
          : {},
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode!));
      },
    );
    req.once("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("Fixture timeout")));
    req.end();
  });
}
test("runtime wiring scopes proxy access, excludes host destinations and closes before dispatch", async (t) => {
  let forwarded: RuntimeRequest | undefined;
  const calls: string[] = [];
  const runtime: Runtime = {
    async execute(input) {
      forwarded = input;
    },
    async cancel(id) {
      calls.push(`cancel:${id}`);
    },
    async recover() {
      calls.push("recover");
      return ["interrupted"];
    },
  };
  const network = await createRuntimeEgress({
    runtime,
    proxyOrigin: "http://api:4101",
    host: "127.0.0.1",
    port: 0,
    networkBoundary: async () => ({
      addresses: ["8.8.8.8", "127.0.0.1"],
      hostnames: ["host.example"],
    }),
    authorize: async (projectId, token) => {
      if (projectId !== request.projectId || token !== request.gateway.token)
        throw new Error("Denied");
      return {
        orgId: request.organizationId,
        projectId,
        userId: "test-user",
        runId: request.runId,
      };
    },
  });
  t.after(() => network.close());
  await assert.rejects(
    network.runtime.execute(request, () => {}),
    /unavailable/,
  );
  const address = await network.start();
  assert.equal(await proxyCall(address.port), 407);
  assert.equal(await proxyCall(address.port, request.gateway.token), 403);
  assert.equal(
    await proxyCall(address.port, request.gateway.token, "http://8.8.8.8/"),
    403,
  );
  assert.equal(
    await proxyCall(
      address.port,
      request.gateway.token,
      "http://host.example/",
    ),
    403,
  );
  await network.runtime.execute(
    { ...request, egressProxyUrl: "http://untrusted:9999" },
    () => {},
  );
  assert.equal(forwarded?.egressProxyUrl, "http://api:4101");
  assert.equal(forwarded?.gateway.token, request.gateway.token);
  assert.ok(!forwarded?.egressProxyUrl?.includes(request.gateway.token));
  await network.runtime.cancel(request.runId);
  assert.deepEqual(await network.runtime.recover(), ["interrupted"]);
  assert.deepEqual(calls, [`cancel:${request.runId}`, "recover"]);
  await network.close();
  await assert.rejects(
    network.runtime.execute(request, () => {}),
    /unavailable/,
  );
  await assert.rejects(proxyCall(address.port));
});

test("egress configuration requires explicit enablement and a distinct valid port", () => {
  assert.equal(loadConfig({}).egressEnabled, false);
  assert.equal(loadConfig({ WME_EGRESS_ENABLED: "true" }).egressEnabled, true);
  for (const value of ["yes", "1", "TRUE"])
    assert.throws(() => loadConfig({ WME_EGRESS_ENABLED: value }));
  for (const port of ["0", "65536", "4100", "4.5"])
    assert.throws(() => loadConfig({ WME_EGRESS_PORT: port }));
});

test("unavailable host metadata prevents production startup before opening SQLite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wme-egress-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "s.sock"),
    tokenFile = join(root, "token");
  await writeFile(tokenFile, "a".repeat(64), { mode: 0o600 });
  const supervisor = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${"a".repeat(64)}`);
    res.writeHead(req.url === "/healthz" ? 200 : 503, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify(
        req.url === "/healthz" ? { ready: true } : { error: "unavailable" },
      ),
    );
  });
  await new Promise<void>((resolve, reject) => {
    supervisor.once("error", reject);
    supervisor.listen(socketPath, resolve);
  });
  t.after(
    () => new Promise<void>((resolve) => supervisor.close(() => resolve())),
  );
  const stateDir = join(root, "untouched-state");
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("../apps/api/src/main.js", import.meta.url))],
      {
        timeout: 10000,
        env: {
          NODE_ENV: "production",
          WME_PUBLIC_ORIGIN: "https://portal.test",
          WME_STATE_DIR: stateDir,
          WME_SUPERVISOR_SOCKET: socketPath,
          WME_SUPERVISOR_TOKEN_FILE: tokenFile,
          WME_INTERNAL_API_ORIGIN: "http://api:4100",
          WME_EGRESS_ENABLED: "true",
        },
      },
    ),
    (error: unknown) => {
      assert.equal((error as { code: number }).code, 1);
      return true;
    },
  );
  await assert.rejects(stat(stateDir), { code: "ENOENT" });
});

test("egress wrapper preserves durable attachment and asset release without lending project schedule authority", async (t) => {
  const calls: string[] = [],
    spec = {
      projectId: "asset-fixture",
      organizationId: "org",
      hostId: "local",
      owner: { kind: "asset" as const, assetId: "fixture" },
      workspaceLease: 1,
      scheduleEnabled: false,
    };
  const catalog = {
    bundledGeneration: "fixture-sdk",
    defaultGeneration: "fixture-sdk",
    items: [],
  };
  const runtime: Runtime = {
    async sdkCatalog(id) {
      assert.equal(this, runtime, "wrapper must retain the catalog receiver");
      assert.equal(id, spec.projectId);
      return catalog;
    },
    async execute() {},
    async cancel() {},
    async recover() {
      return [];
    },
    async ensureProject(value) {
      assert.equal(value.egressToken, undefined);
      calls.push("ensure");
    },
    async attach(id, cursor) {
      calls.push("attach:" + id + ":" + cursor);
    },
    async acknowledge(id, cursor) {
      calls.push("ack:" + id + ":" + cursor);
    },
    async stopSession(id, thread, generation) {
      calls.push("stop:" + id + ":" + thread + ":" + generation);
    },
    async releaseAsset(value) {
      assert.deepEqual(value, spec);
      calls.push("release");
    },
  };
  const wrapped = await createRuntimeEgress({
    runtime,
    proxyOrigin: "http://api:4101",
    host: "127.0.0.1",
    port: 0,
    networkBoundary: async () => ({
      addresses: ["127.0.0.1"],
      hostnames: ["host.example"],
    }),
    issueProjectCapability: async () => {
      throw Error("Asset must not receive project scheduling authority");
    },
    authorize: async () => {
      throw Error("unused");
    },
  });
  t.after(() => wrapped.close());
  assert.deepEqual(await wrapped.runtime.sdkCatalog!(spec.projectId), catalog);
  await wrapped.runtime.ensureProject!(spec);
  await wrapped.runtime.attach!("run", 7, () => {});
  await wrapped.runtime.acknowledge!("run", 8);
  await wrapped.runtime.stopSession!(spec.projectId, "thread", 2);
  await wrapped.runtime.releaseAsset!(spec);
  assert.deepEqual(calls, [
    "ensure",
    "attach:run:7",
    "ack:run:8",
    "stop:asset-fixture:thread:2",
    "release",
  ]);
});
