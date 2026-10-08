import { isIPv4 } from "node:net";

const ipv4 = (value) =>
  typeof value === "string" &&
  isIPv4(value) &&
  value !== "0.0.0.0" &&
  !value.startsWith("127.");
function contains(cidr, address) {
  if (typeof cidr !== "string") return false;
  const [base, prefix, extra] = cidr.split("/");
  if (!isIPv4(base) || !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(prefix) || extra)
    return false;
  const number = (ip) =>
    ip.split(".").reduce((n, octet) => n * 256 + +octet, 0);
  const size = 2 ** (32 - Number(prefix));
  return Math.floor(number(base) / size) === Math.floor(number(address) / size);
}

/** Acceptance-only discovery on the local Linux Docker host. Never infer subnet + 1. */
export function boundaryTargets(network, peer, interfaces) {
  const bridge = network.Options?.["com.docker.network.bridge.name"];
  const named = peer.NetworkSettings?.Networks?.[network.Name];
  const attached =
    Object.values(peer.NetworkSettings?.Networks ?? {}).find(
      (value) => value.NetworkID === network.Id,
    ) ?? (named?.NetworkID ? undefined : named);
  const endpoint = network.Containers?.[peer.Id];
  const diagnostics = {
    network: {
      id: network.Id,
      name: network.Name,
      driver: network.Driver,
      internal: network.Internal,
      bridge,
      ipam: network.IPAM?.Config,
    },
    peer: { id: peer.Id, endpoint: attached, networkEndpoint: endpoint },
    bridgeAddresses: interfaces[bridge] ?? [],
  };
  const fail = (reason) => {
    throw new Error(
      "Boundary target discovery: " +
        reason +
        "; " +
        JSON.stringify(diagnostics),
    );
  };
  if (
    !network.Id ||
    !network.Name ||
    network.Driver !== "bridge" ||
    network.Internal !== true
  )
    fail("expected the actual internal project bridge");
  if (!bridge || !Array.isArray(interfaces[bridge]))
    fail("project bridge is absent from the local host interfaces");
  if (named?.NetworkID && named.NetworkID !== network.Id)
    fail("peer attachment references a different network");
  const addresses = [];
  if (attached?.IPAddress) addresses.push(attached.IPAddress);
  if (endpoint?.IPv4Address) {
    const [address, prefix, extra] = endpoint.IPv4Address.split("/");
    if (extra || !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(prefix))
      fail("invalid peer endpoint CIDR");
    addresses.push(address);
  }
  if (!addresses.length || addresses.some((address) => !ipv4(address)))
    fail("actual project-network peer IPv4 address is missing or invalid");
  const peers = [...new Set(addresses)];
  if (peers.length !== 1) fail("peer inspect results disagree");
  const peerAddress = peers[0];
  // IPAM Gateway is optional configuration metadata. Use addresses actually
  // assigned to this project's host bridge, in the peer's connected subnet.
  const hosts = [
    ...new Set(
      interfaces[bridge]
        .filter(
          (value) =>
            (value.family === "IPv4" || value.family === 4) &&
            !value.internal &&
            ipv4(value.address) &&
            value.address !== peerAddress &&
            contains(value.cidr, peerAddress),
        )
        .map((value) => value.address),
    ),
  ];
  if (!hosts.length)
    fail("no actual host bridge IPv4 address shares the peer subnet");
  return { peer: peerAddress, hosts, diagnostics };
}
