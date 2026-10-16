import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime, type DockerRuntimeOptions } from "../src/docker.ts";
import { createSupervisorClient } from "../../../deploy/client.ts";
import { placedRuntime } from "../../../deploy/placement.ts";
import { createSupervisorServer } from "../../../deploy/supervisor-server.ts";
import type { Runtime, RuntimeSDKCatalogDTO } from "../src/types.ts";

test("runtime sdkCatalog reads trusted catalog without starting a project container", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wme-runtime-sdk-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = join(root, "files");
  const sessions = join(root, "sessions");
  const journal = join(root, "journal");
  const sdkCatalog = join(root, "approved-sdk");
  await mkdir(join(journal, "projects", "project1"), { recursive: true });
  await mkdir(sdkCatalog, { recursive: true });
  await writeFile(
    join(journal, "projects", "project1", "definition.json"),
    JSON.stringify({
      projectId: "project1",
      organizationId: "org1",
      hostId: "local",
      allocationId: "allocation",
      network: "network",
      status: "ready",
    }),
  );
  const runtime = new DockerRuntime({
    image: "fixture:runtime",
    network: "wme-runtime",
    networkPool: "10.252.0.0/24",
    gatewayContainer: "synthetic-gateway",
    storageRoots: [files],
    sessionRoot: sessions,
    journalRoot: journal,
    sdkCatalogRoot: sdkCatalog,
    gatewayOrigins: ["http://api:4100"],
    dockerBinary: join(root, "must-not-run-docker"),
    appArmorProfile: "wme-platform-agent",
  } satisfies DockerRuntimeOptions);
  const catalog = await runtime.sdkCatalog!("project1");
  assert.ok(catalog.bundledGeneration.startsWith("bundled-pi-1.1.0-"));
  assert.equal(catalog.defaultGeneration, catalog.bundledGeneration);
  assert.ok(catalog.items.some((item) => item.bundled === true));
});

test("sdk catalog inventory uses supervisor client and placement transport", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wme-runtime-sdk-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = "a".repeat(64);
  const tokenFile = join(root, "token");
  const socketPath = join(root, "supervisor.sock");
  await writeFile(tokenFile, token);
  const dto: RuntimeSDKCatalogDTO = {
    bundledGeneration: "bundled-pi-1.1.0-fixture",
    defaultGeneration: "pi-approved",
    items: [
      {
        id: "pi-approved",
        label: "Approved fixture",
        piVersion: "1.1.0",
        status: "approved",
        integrity: { algorithm: "sha256", manifest: "0".repeat(64) },
      },
    ],
  };
  const runtime: Runtime = {
    sdkCatalog: async (projectId) => {
      assert.equal(projectId, "project1");
      return dto;
    },
    async execute() {},
    async cancel() {},
    async recover() {
      return [];
    },
  };
  const server = createSupervisorServer({
    token,
    hostId: "host1",
    runtime,
    registry: {
      resolve: async () => undefined,
      ensure: async () => {
        throw new Error("not used");
      },
    },
  });
  t.after(() => server.close());
  server.listen(socketPath);
  await once(server, "listening");
  const client = createSupervisorClient({
    socketPath,
    tokenFile,
    hostId: "host1",
  });
  assert.deepEqual(await client.runtime.sdkCatalog!("project1"), dto);
  const placed = placedRuntime(
    [
      {
        id: "host1",
        hostId: "host1",
        name: "Host 1",
        apiStateRoot: root,
        supervisorStateRoot: root,
        socketPath,
        tokenFile,
      },
    ],
    async (projectId) => ({
      projectId,
      organizationId: "org1",
      hostId: "host1",
    }),
    async () => undefined,
  );
  assert.deepEqual(await placed.runtime.sdkCatalog!("project1"), dto);
});
