// Explicit disposable browser/native acceptance. Never imported by the product.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  readdir,
  chmod,
  open,
  chown,
  lstat,
  realpath,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectDockerRuntime } from "../dist/packages/runtime/src/project-runtime.js";
import { createIsolatedNetwork } from "../dist/packages/runtime/src/networks.js";
import { storageVolumeName } from "../dist/packages/runtime/src/volumes.js";
const exec = promisify(execFile);
const docker = async (args) =>
  (
    await exec("docker", args, { timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
  ).stdout.trim();
export async function nativeFixture({ stateDir, origin, image, output }) {
  if (process.env.WME_E2E_FIXTURE !== "1" || !image)
    throw Error("Explicit native fixture opt-in required");
  const allocation = randomUUID(),
    gateway = "wme-pr2-asset-gateway-" + allocation,
    bootstrap = "wme-pr2-asset-bootstrap-" + allocation;
  const files = join(stateDir, "workspaces"),
    sessions = join(stateDir, "agent-sessions"),
    journal = join(stateDir, "runtime-journal"),
    bridge = join(stateDir, "bridge");
  for (const root of [files, sessions, journal, bridge])
    await mkdir(root, { recursive: true, mode: 0o700 });
  const ledger = {
    stateDir,
    allocation,
    gateway,
    bootstrap,
    image,
    resources: [],
  };
  let recording = Promise.resolve();
  const record = () => {
    const snapshot = JSON.stringify(ledger, null, 2);
    recording = recording.then(async () => {
      const temporary = join(output, "native-allocation.json.tmp");
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, join(output, "native-allocation.json"));
    });
    return recording;
  };
  await record();
  const providerPath = join(stateDir, "provider.cjs");
  await writeFile(
    providerPath,
    await readFile(new URL("../runtime/protocol-fixture.mjs", import.meta.url)),
  );
  const providerModule = createRequire(import.meta.url)(providerPath);
  providerModule.onAssetShape = (shape) =>
    void appendFile(
      join(output, "provider-shapes.jsonl"),
      JSON.stringify(shape) + "\n",
    );
  const provider = createServer(providerModule.handler);
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const providerOrigin = "http://127.0.0.1:" + provider.address().port;
  // Only the fixture's isolated gateway can reach this private Unix socket. The
  // application itself keeps its ordinary loopback-only browser listener.
  const relay = createServer((incoming, outgoing) => {
    const target = new URL(incoming.url, origin);
    const request = httpRequest(
      target,
      {
        method: incoming.method,
        headers: { ...incoming.headers, host: new URL(origin).host },
      },
      (response) => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      },
    );
    request.on("error", () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(request);
  });
  const socket = join(bridge, "api.sock"),
    bridgeFd = await open(bridge, "r");
  // Linux sockaddr_un is bounded; bind through the held directory descriptor
  // while retaining the actual socket inside the private fixture directory.
  await new Promise((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(`/proc/self/fd/${bridgeFd.fd}/api.sock`, resolve);
  });
  await chmod(socket, 0o600);
  const gatewayProgram = `const http=require('node:http');http.createServer((q,s)=>{const r=http.request({socketPath:'/bridge/api.sock',method:q.method,path:q.url,headers:q.headers},p=>{s.writeHead(p.statusCode,p.headers);p.pipe(s)});r.on('error',()=>{s.writeHead(502);s.end()});q.pipe(r)}).listen(4100,'0.0.0.0');`;
  const pool = process.env.WME_E2E_NETWORK_POOL ?? "10.253.241.0/24";
  await createIsolatedNetwork(
    {
      name: bootstrap,
      pool,
      bridgeName: "wab" + allocation.replaceAll("-", "").slice(0, 10),
      labels: { "com.wovenmatter.enterprise.acceptance": allocation },
    },
    async (args) => ({ stdout: await docker(args), stderr: "" }),
  );
  await docker([
    "run",
    "-d",
    "--name",
    gateway,
    "--label",
    "com.wovenmatter.enterprise.acceptance=" + allocation,
    "--network",
    bootstrap,
    "--network-alias",
    "api",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=bind,src=${bridge},dst=/bridge,readonly`,
    "--entrypoint",
    "node",
    image,
    "-e",
    gatewayProgram,
  ]);
  const runtime = new ProjectDockerRuntime({
    image,
    network: "wme-pr2-asset-native",
    networkPool: pool,
    gatewayContainer: gateway,
    storageRoots: [files],
    sessionRoot: sessions,
    journalRoot: journal,
    gatewayOrigins: ["http://api:4100"],
    appArmorProfile: "wme-platform-agent",
  });
  const provision = runtime.ensureProject.bind(runtime);
  runtime.ensureProject = async (spec) => {
    // The production API writes as UID10001. This root-run synthetic browser API
    // explicitly gives only its fresh workspace leaf that same ownership.
    const leaf = spec.owner
      ? join(files, "assets", spec.owner.assetId, "files")
      : join(files, "projects", spec.projectId, "files");
    await mkdir(leaf, { recursive: true, mode: 0o750 });
    await chown(leaf, 10001, 10001);
    await chmod(leaf, 0o750);
    try {
      await provision(spec);
    } finally {
      const definition = await readFile(
        join(journal, "projects", spec.projectId, "definition.json"),
        "utf8",
      ).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (definition) {
        const p = JSON.parse(definition);
        if (!ledger.resources.some((x) => x.projectId === p.projectId))
          ledger.resources.push({
            projectId: p.projectId,
            allocationId: p.allocationId,
            owner: p.owner,
            organizationId: p.organizationId,
          });
        await record();
      }
    }
  };
  const executeTurn = runtime.execute.bind(runtime);
  async function fixtureOwnership(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return;
    assert.ok(
      (await realpath(path)).startsWith(files + "/"),
      "Fixture ownership must stay inside its fresh workspace tree",
    );
    await chown(path, 10001, 10001);
    if (stat.isDirectory())
      for (const name of await readdir(path))
        await fixtureOwnership(join(path, name));
  }
  runtime.execute = async (request, emit, signal) => {
    for (const mount of request.mounts) await fixtureOwnership(mount.source);
    return executeTurn(request, emit, signal);
  };
  return {
    runtime,
    providerOrigin,
    internalApiOrigin: "http://api:4100",
    async close() {
      await writeFile(
        join(output, "provider-shapes.json"),
        JSON.stringify(providerModule.assetProtocolShapes, null, 2),
      );
      await Promise.all([
        new Promise((r) => provider.close(r)),
        new Promise((r) => relay.close(r)),
      ]);
      await bridgeFd.close();
    },
  };
}

export async function cleanupNativeResources(ledger, output) {
  const { stateDir, allocation, gateway, bootstrap, image } = ledger;
  assert.ok(/^wme-pr2-asset-gateway-[a-f0-9-]{36}$/.test(gateway));
  assert.ok(/^wme-browser-[a-zA-Z0-9]{6}$/.test(stateDir.split("/").at(-1)));
  const files = join(stateDir, "workspaces"),
    sessions = join(stateDir, "agent-sessions"),
    journal = join(stateDir, "runtime-journal"),
    bridge = join(stateDir, "bridge");
  const runtime = new ProjectDockerRuntime({
    image,
    network: "wme-pr2-asset-native",
    networkPool: "10.253.241.0/24",
    gatewayContainer: gateway,
    storageRoots: [files],
    sessionRoot: sessions,
    journalRoot: journal,
    gatewayOrigins: ["http://api:4100"],
    appArmorProfile: "wme-platform-agent",
  });
  const dirs = await readdir(join(journal, "projects")).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  for (const id of dirs) {
    const p = JSON.parse(
      await readFile(join(journal, "projects", id, "definition.json"), "utf8"),
    );
    assert.ok(
      ledger.resources.some(
        (r) => r.projectId === id && r.allocationId === p.allocationId,
      ),
      "Only recorded allocations may be cleaned",
    );
    const name = p.owner ? "wme-asset-" + p.owner.assetId : "wme-project-" + id;
    let c;
    try {
      c = JSON.parse(await docker(["inspect", name]))[0];
    } catch (e) {
      if (
        e.code !== 1 ||
        !(
          e.stderr?.includes("No such") ||
          e.stderr?.trim() === `error: no such object: ${name}`
        )
      )
        throw e;
    }
    if (c) {
      assert.equal(
        c.Config.Labels["com.wovenmatter.enterprise.allocation"],
        p.allocationId,
      );
      assert.ok(c.Mounts.some((m) => m.Name === storageVolumeName(files)));
      assert.ok(c.Mounts.some((m) => m.Name === storageVolumeName(sessions)));
    }
    await runtime.stopProject(p);
    await runtime.purgeProject(p);
  }
  const g = JSON.parse(await docker(["inspect", gateway]))[0];
  assert.equal(
    g.Config.Labels["com.wovenmatter.enterprise.acceptance"],
    allocation,
  );
  assert.ok(g.Mounts.some((m) => m.Source === bridge));
  await docker(["rm", "--force", g.Id]);
  const n = JSON.parse(await docker(["network", "inspect", bootstrap]))[0];
  assert.equal(n.Labels["com.wovenmatter.enterprise.acceptance"], allocation);
  await docker(["network", "rm", n.Id]);
  for (const root of [files, sessions, journal]) {
    let v;
    try {
      v = JSON.parse(
        await docker(["volume", "inspect", storageVolumeName(root)]),
      )[0];
    } catch (e) {
      if (!e.stderr?.includes("no such volume")) throw e;
      continue;
    }
    assert.equal(v.Options.device, root);
    assert.equal(v.Labels["com.wovenmatter.enterprise.storage"], "true");
    await docker(["volume", "rm", v.Name]);
  }
  ledger.cleaned = true;
  await writeFile(
    join(output, "native-allocation.json"),
    JSON.stringify(ledger, null, 2),
    { mode: 0o600 },
  );
}
