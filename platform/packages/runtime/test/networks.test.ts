import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createIsolatedNetwork,
  validateNetworkPool,
  MAX_NETWORK_ALLOCATION_ATTEMPTS,
} from "../src/networks.ts";

const options = {
  name: "wme-fixture-run",
  pool: "10.252.0.0/24",
  bridgeName: "br-wmeruntest",
  labels: {
    "com.wovenmatter.enterprise.runtime": "true",
    "com.wovenmatter.enterprise.run": "fixture",
  },
};
const overlap = () =>
  Object.assign(new Error("overlap"), {
    code: 1,
    stderr:
      "Error response from daemon: invalid pool request: Pool overlaps with other one on this address space\n",
  });

test("network pool validation accepts only explicit canonical bounded RFC1918 CIDRs", () => {
  for (const pool of [
    "10.253.0.0/16",
    "10.252.0.0/24",
    "172.16.0.0/16",
    "172.31.255.0/24",
    "192.168.0.0/16",
  ])
    assert.equal(validateNetworkPool(pool), pool);
  for (const pool of [
    undefined,
    null,
    "",
    "10.0.0.0",
    "10.0.0.0/8",
    "10.0.0.0/15",
    "10.0.0.0/25",
    "10.0.0.1/24",
    "10.1.1.0/16",
    "010.0.0.0/16",
    "10.0.0.0/016",
    " 10.0.0.0/16",
    "10.0.0.0/16\n",
    "192.169.0.0/16",
    "172.32.0.0/16",
    "172.15.0.0/16",
    "8.8.0.0/16",
    "127.0.0.0/16",
    "169.254.0.0/16",
    "100.64.0.0/16",
    "10.256.0.0/16",
    "fd00::/16",
  ])
    assert.throws(() => validateNetworkPool(pool as string), /network pool/);
});

test("network creation uses deterministic explicit /28 with internal bridge and preserved labels", async () => {
  const calls: string[][] = [];
  const result = await createIsolatedNetwork(options, async (args) => {
    calls.push(args);
  });
  const slot =
    createHash("sha256").update(options.name).digest().readUInt32BE(0) % 16;
  assert.equal(result.subnet, `10.252.0.${slot * 16}/28`);
  assert.deepEqual(calls[0].slice(0, 7), [
    "network",
    "create",
    "--driver",
    "bridge",
    "--internal",
    "--subnet",
    result.subnet,
  ]);
  assert.ok(calls[0].includes("com.docker.network.bridge.name=br-wmeruntest"));
  assert.ok(calls[0].includes("com.wovenmatter.enterprise.runtime=true"));
  assert.equal(calls[0].at(-1), options.name);
  assert.equal(
    (await createIsolatedNetwork(options, async () => {})).subnet,
    result.subnet,
  );
});

test("only confirmed overlap errors advance to the next bounded slot without deleting networks", async () => {
  const calls: string[][] = [];
  const result = await createIsolatedNetwork(options, async (args) => {
    calls.push(args);
    if (calls.length < 3) throw overlap();
  });
  assert.equal(calls.length, 3);
  const subnets = calls.map((args) => args[args.indexOf("--subnet") + 1]);
  assert.equal(new Set(subnets).size, 3);
  assert.equal(result.subnet, subnets[2]);
  assert.ok(
    calls.every(
      (args) =>
        args[0] === "network" &&
        args[1] === "create" &&
        args.includes("--subnet") &&
        args.includes("--internal"),
    ),
  );
});

test("pool exhaustion is explicit, bounded, and never falls back to Docker defaults", async () => {
  for (const [pool, count] of [
    ["10.252.0.0/24", 16],
    ["10.253.0.0/16", MAX_NETWORK_ALLOCATION_ATTEMPTS],
  ] as const) {
    const calls: string[][] = [];
    await assert.rejects(
      createIsolatedNetwork({ ...options, pool }, async (args) => {
        calls.push(args);
        throw overlap();
      }),
      (error) => {
        assert.equal(
          (error as { code: string }).code,
          "network_pool_exhausted",
        );
        return true;
      },
    );
    assert.equal(calls.length, count);
    assert.equal(
      new Set(calls.map((args) => args[args.indexOf("--subnet") + 1])).size,
      count,
    );
    assert.ok(
      calls.every((args) => args.includes("--subnet") && args[1] === "create"),
    );
  }
});

test("fatal, name-conflict, unavailable-daemon and uncertain errors are never retried", async () => {
  for (const error of [
    new Error("offline"),
    { code: 1, stderr: "network with name fixture already exists" },
    {
      code: 1,
      stderr: "all predefined address pools have been fully subnetted",
    },
    { code: 1, stderr: "Pool overlaps with other one on this address space" },
    { code: 2, stderr: overlap().stderr },
    { code: 1, killed: true, stderr: overlap().stderr },
    { code: 1, signal: "SIGTERM", stderr: overlap().stderr },
  ]) {
    let calls = 0;
    await assert.rejects(
      createIsolatedNetwork(options, async () => {
        calls++;
        throw error;
      }),
      (value) => value === error,
    );
    assert.equal(calls, 1);
  }
});

test("invalid pool/name/bridge/labels never call Docker", async () => {
  let calls = 0;
  for (const input of [
    { ...options, pool: "10.0.0.1/16" },
    { ...options, name: "--evil" },
    { ...options, bridgeName: "interface-name-too-long" },
    { ...options, labels: { bad: "line\nbreak" } },
  ])
    await assert.rejects(
      createIsolatedNetwork(input, async () => {
        calls++;
      }),
    );
  assert.equal(calls, 0);
});

test("concurrent subnet collisions retry atomically through Docker without shared mutable allocation state", async () => {
  const occupied = new Set<string>();
  const docker = async (args: string[]) => {
    const subnet = args[args.indexOf("--subnet") + 1];
    if (occupied.has(subnet)) throw overlap();
    occupied.add(subnet);
  };
  const names: string[] = [];
  for (let index = 0; names.length < 5; index++) {
    const name = `wme-concurrent-${index}`;
    if (createHash("sha256").update(name).digest().readUInt32BE(0) % 16 === 0)
      names.push(name);
  }
  const results = await Promise.all(
    names.map((name) => createIsolatedNetwork({ ...options, name }, docker)),
  );
  assert.equal(new Set(results.map((result) => result.subnet)).size, 5);
});
