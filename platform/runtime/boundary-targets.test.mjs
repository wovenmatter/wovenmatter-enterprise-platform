import test from "node:test";
import assert from "node:assert/strict";
import { boundaryTargets } from "./boundary-targets.mjs";

function fixture() {
  return {
    network: {
      Id: "project-network-id",
      Name: "project-network",
      Driver: "bridge",
      Internal: true,
      Options: { "com.docker.network.bridge.name": "br-project" },
      IPAM: { Config: [{ Subnet: "192.0.2.0/28", Gateway: "192.0.2.9" }] },
      Containers: { "peer-id": { IPv4Address: "192.0.2.3/28" } },
    },
    peer: {
      Id: "peer-id",
      NetworkSettings: {
        Networks: {
          bootstrap: { NetworkID: "bootstrap-id", IPAddress: "198.51.100.2" },
          "project-network": {
            NetworkID: "project-network-id",
            IPAddress: "192.0.2.3",
          },
        },
      },
    },
    interfaces: {
      "br-project": [
        {
          family: "IPv4",
          internal: false,
          address: "192.0.2.9",
          cidr: "192.0.2.9/28",
        },
      ],
      docker0: [
        {
          family: "IPv4",
          internal: false,
          address: "198.51.100.1",
          cidr: "198.51.100.1/24",
        },
      ],
    },
  };
}
const discover = ({ network, peer, interfaces }) =>
  boundaryTargets(network, peer, interfaces);

test("missing configured Gateway uses the actual project bridge, without guessing subnet + 1", () => {
  const f = fixture();
  delete f.network.IPAM.Config[0].Gateway;
  const result = discover(f);
  assert.equal(result.peer, "192.0.2.3");
  assert.deepEqual(result.hosts, ["192.0.2.9"]);
  assert.equal(result.diagnostics.network.ipam[0].Gateway, undefined);
});

test("missing container IPAddress uses the exact peer endpoint in network inspect", () => {
  const f = fixture();
  delete f.peer.NetworkSettings.Networks["project-network"].IPAddress;
  assert.equal(discover(f).peer, "192.0.2.3");
  // Also support an absent attachment record; never take the bootstrap address.
  delete f.peer.NetworkSettings.Networks["project-network"];
  assert.equal(discover(f).peer, "192.0.2.3");
});

test("network ID resolves attachment keys, and container inspect alone is sufficient", () => {
  const f = fixture();
  f.peer.NetworkSettings.Networks.renamed =
    f.peer.NetworkSettings.Networks["project-network"];
  delete f.peer.NetworkSettings.Networks["project-network"];
  delete f.network.Containers;
  assert.equal(discover(f).peer, "192.0.2.3");
});

test("IPAM ordering and stale configured addresses cannot select a nonexistent host", () => {
  const f = fixture();
  f.network.IPAM.Config = [
    { Subnet: "2001:db8::/64" },
    { Subnet: "192.0.2.0/28", Gateway: "192.0.2.1" },
  ];
  f.interfaces["br-project"].push(
    {
      family: "IPv6",
      internal: false,
      address: "2001:db8::1",
      cidr: "2001:db8::1/64",
    },
    {
      family: 4,
      internal: false,
      address: "192.0.2.10",
      cidr: "192.0.2.10/28",
    },
    {
      family: "IPv4",
      internal: false,
      address: "203.0.113.1",
      cidr: "203.0.113.1/24",
    },
  );
  assert.deepEqual(discover(f).hosts, ["192.0.2.9", "192.0.2.10"]);
});

test("contradictory peer metadata fails with both inspected endpoints in diagnostics", () => {
  const f = fixture();
  f.network.Containers["peer-id"].IPv4Address = "192.0.2.4/28";
  assert.throws(
    () => discover(f),
    (error) => {
      assert.match(error.message, /peer inspect results disagree/);
      assert.match(error.message, /192\.0\.2\.3/);
      assert.match(error.message, /192\.0\.2\.4\/28/);
      assert.match(error.message, /br-project/);
      return true;
    },
  );
  f.peer.NetworkSettings.Networks["project-network"].NetworkID =
    "wrong-network-id";
  assert.throws(() => discover(f), /different network/);
});

test("absent or invalid peer cannot fall back to the unrelated bootstrap network", () => {
  const f = fixture();
  delete f.peer.NetworkSettings.Networks["project-network"];
  delete f.network.Containers;
  assert.throws(() => discover(f), /peer IPv4 address is missing or invalid/);
  f.network.Containers = { "peer-id": { IPv4Address: "192.0.2.3/33" } };
  assert.throws(() => discover(f), /invalid peer endpoint CIDR/);
  f.network.Containers["peer-id"].IPv4Address = "0.0.0.0/28";
  assert.throws(() => discover(f), /peer IPv4 address is missing or invalid/);
});

test("missing or unaddressed bridge fails even with an advertised IPAM gateway", () => {
  const f = fixture();
  delete f.interfaces["br-project"];
  assert.throws(() => discover(f), /bridge is absent from the local host/);
  f.interfaces["br-project"] = [];
  assert.throws(() => discover(f), /no actual host bridge IPv4 address/);
  f.interfaces["br-project"] = [
    {
      family: "IPv4",
      internal: false,
      address: "203.0.113.1",
      cidr: "203.0.113.1/24",
    },
  ];
  assert.throws(() => discover(f), /no actual host bridge IPv4 address/);
});

test("non-internal or non-bridge network metadata cannot stand in for the project bridge", () => {
  const f = fixture();
  f.network.Internal = false;
  assert.throws(
    () => discover(f),
    /expected the actual internal project bridge/,
  );
  f.network.Internal = true;
  f.network.Driver = "overlay";
  assert.throws(
    () => discover(f),
    /expected the actual internal project bridge/,
  );
});
