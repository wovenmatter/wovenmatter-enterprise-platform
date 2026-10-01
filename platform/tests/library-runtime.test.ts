import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DockerLibraryRuntime } from "../apps/api/src/library/runtime.js";
import { storageVolumeName } from "../packages/runtime/src/volumes.js";

function fixture(networkPool?: string) {
  const id = randomUUID(),
    assetId = randomUUID(),
    attemptId = randomUUID(),
    stateDir = "/srv/wme-candidate/state",
    name = `wme-asset-${id}`,
    networkName = `${name}-net`,
    commands: string[][] = [];
  const item: any = {
    Id: "a".repeat(64),
    Config: {
      User: "65532:65532",
      Labels: {
        "wme.kind": "library",
        "wme.version": id,
        "wme.asset": assetId,
        "wme.attempt": attemptId,
      },
    },
    State: { Running: true, ExitCode: 0 },
    HostConfig: {
      ReadonlyRootfs: true,
      RestartPolicy: { Name: "no" },
      Mounts: [
        {
          Type: "volume",
          Source: storageVolumeName(`${stateDir}/library`),
          Target: "/app",
          ReadOnly: true,
          VolumeOptions: { Subpath: `${assetId}/${id}` },
        },
        {
          Type: "volume",
          Source: storageVolumeName(`${stateDir}/library-data`),
          Target: "/data",
          ReadOnly: false,
          VolumeOptions: { Subpath: assetId },
        },
      ],
    },
    NetworkSettings: {
      Ports: { "8789/tcp": null },
      Networks: {
        [networkName]: {
          IPAddress: "192.168.160.2",
          NetworkID: "b".repeat(64),
        },
      },
    },
  };
  const network: any = {
    Id: "b".repeat(64),
    Internal: true,
    Labels: {
      "wme.kind": "library",
      "wme.asset": assetId,
      "wme.version": id,
      "wme.attempt": attemptId,
    },
  };
  const state = { containerExists: true, inspectFails: false };
  const runtime = new DockerLibraryRuntime({
    stateDir,
    dataRoots: [`${stateDir}/workspaces`],
    image: "wme-library:test",
    networkPool,
    execute: async (_file, args) => {
      commands.push(args);
      if (args[0] === "inspect") {
        if (!state.containerExists) throw new Error("No such container");
        return { stdout: JSON.stringify([item]), stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        if (state.inspectFails) throw new Error("Docker connection lost");
        return { stdout: JSON.stringify([network]), stderr: "" };
      }
      if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm"))
        return { stdout: "", stderr: "" };
      throw new Error("Unexpected Docker mutation in read-only test");
    },
  });
  return { id, assetId, attemptId, item, network, runtime, commands, state };
}
test("internal app endpoint uses its dedicated private address without a published host port", async () => {
  const f = fixture(),
    state = await f.runtime.status(f.id);
  assert.equal(state.origin, "http://192.168.160.2:8789/");
  assert.equal(state.status, "running");
});
test("runtime endpoint fails closed for additional networks or a non-internal bridge", async () => {
  const f = fixture();
  f.item.NetworkSettings.Networks.external = { IPAddress: "10.0.0.5" };
  await assert.rejects(f.runtime.status(f.id), /unexpected network/);
  delete f.item.NetworkSettings.Networks.external;
  f.network.Internal = false;
  await assert.rejects(f.runtime.status(f.id), /not isolated/);
});
test("trusted resume rejects containers tied to another restored state root before starting them", async () => {
  const f = fixture();
  f.item.State.Running = false;
  f.item.HostConfig.Mounts[1].Source = storageVolumeName(
    "/srv/another-candidate/state/library-data",
  );
  await assert.rejects(f.runtime.resume(f.id), /different storage root/);
  assert.equal(
    f.commands.some((c) => c[0] === "start"),
    false,
  );
});
test("trusted resume rejects old automatic restart policy until the asset is republished", async () => {
  const f = fixture();
  f.item.HostConfig.RestartPolicy.Name = "unless-stopped";
  await assert.rejects(f.runtime.resume(f.id), /current isolation settings/);
  assert.equal(
    f.commands.some((c) => c[0] === "start"),
    false,
  );
});
test("new library launches require an explicit address pool before filesystem or Docker work", async () => {
  const f = fixture();
  await assert.rejects(
    f.runtime.start({
      assetId: f.assetId,
      versionId: f.id,
      orgId: randomUUID(),
      projectId: null,
      sourceDir: "/must-not-be-read",
      entrypoint: "server.mjs",
      publicOrigin: "https://example.test",
      dataMounts: [],
    }),
    /explicit library network pool/,
  );
  assert.deepEqual(f.commands, []);
});
test("noncanonical or public pools fail closed before runtime side effects", async () => {
  for (const pool of ["192.168.1.1/16", "8.8.0.0/16"]) {
    const f = fixture(pool);
    await assert.rejects(
      f.runtime.start({
        assetId: f.assetId,
        versionId: f.id,
        orgId: randomUUID(),
        projectId: null,
        sourceDir: "/must-not-be-read",
        entrypoint: "server.mjs",
        publicOrigin: "https://example.test",
        dataMounts: [],
      }),
      { code: "invalid_network_pool" },
    );
    assert.deepEqual(f.commands, []);
  }
});

test("cleanup removes only inspected immutable resource IDs", async () => {
  const f = fixture();
  await f.runtime.stop(f.id);
  assert.deepEqual(
    f.commands.filter((c) => c.includes("rm")),
    [
      ["rm", "--force", f.item.Id],
      ["network", "rm", f.network.Id],
    ],
  );
});
test("cleanup refuses foreign same-name containers and networks", async () => {
  const f = fixture();
  f.item.Config.Labels["wme.version"] = randomUUID();
  await assert.rejects(f.runtime.stop(f.id), /unowned library container/);
  assert.equal(
    f.commands.some((c) => c.includes("rm")),
    false,
  );
  const g = fixture();
  g.network.Labels["wme.version"] = randomUUID();
  await assert.rejects(g.runtime.stop(g.id), /unowned library network/);
  assert.equal(
    g.commands.some((c) => c[0] === "network" && c[1] === "rm"),
    false,
  );
});
test("legacy network cleanup requires the container's exact network receipt", async () => {
  const f = fixture();
  delete f.network.Labels["wme.version"];
  delete f.network.Labels["wme.attempt"];
  delete f.item.Config.Labels["wme.attempt"];
  assert.equal((await f.runtime.status(f.id)).status, "running");
  await f.runtime.stop(f.id);
  assert.ok(
    f.commands.some(
      (c) => c[0] === "network" && c[1] === "rm" && c[2] === f.network.Id,
    ),
  );
  const g = fixture();
  delete g.network.Labels["wme.version"];
  g.network.Id = "c".repeat(64);
  await assert.rejects(g.runtime.stop(g.id), /unowned library network/);
  assert.equal(
    g.commands.some((c) => c[0] === "network" && c[1] === "rm"),
    false,
  );
});
test("cleanup recovers an acknowledged version network after a lost create response", async () => {
  const f = fixture();
  f.state.containerExists = false;
  await f.runtime.stop(f.id);
  assert.deepEqual(
    f.commands.filter((c) => c.includes("rm")),
    [["network", "rm", f.network.Id]],
  );
});
test("uncertain network inspection fails cleanup so durable launch intent can retry", async () => {
  const f = fixture();
  f.state.containerExists = false;
  f.state.inspectFails = true;
  await assert.rejects(f.runtime.stop(f.id), /Docker connection lost/);
  assert.equal(
    f.commands.some((c) => c.includes("rm")),
    false,
  );
});
test("status and resume reject replacement networks even with matching labels", async () => {
  const f = fixture();
  f.network.Id = "c".repeat(64);
  await assert.rejects(f.runtime.status(f.id), /not isolated/);
  await assert.rejects(f.runtime.resume(f.id), /not isolated/);
  assert.equal(
    f.commands.some((c) => c[0] === "start"),
    false,
  );
});
