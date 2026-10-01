import { createHash } from "node:crypto";
import { RuntimeError } from "./types.ts";

/** A /28 has room for the run and gateway while avoiding Docker's broad default pools. */
export const ISOLATED_NETWORK_PREFIX = 28;
export const MAX_NETWORK_ALLOCATION_ATTEMPTS = 64;

interface Pool {
  cidr: string;
  base: number;
  slots: number;
}
function parsePool(value: string): Pool {
  const invalid = () =>
    new RuntimeError(
      "invalid_network_pool",
      "An explicit canonical RFC1918 IPv4 network pool with a /16 through /24 prefix is required",
    );
  if (typeof value !== "string") throw invalid();
  const match =
    /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\/(1[6-9]|2[0-4])$/.exec(
      value,
    );
  if (!match) throw invalid();
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) throw invalid();
  const [a, b] = octets;
  if (!(
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  ))
    throw invalid();
  const base = octets.reduce((total, octet) => total * 256 + octet, 0);
  const prefix = Number(match[5]);
  const size = 2 ** (32 - prefix);
  if (base % size !== 0) throw invalid();
  return { cidr: value, base, slots: 2 ** (ISOLATED_NETWORK_PREFIX - prefix) };
}

/** Validate at trusted service startup before any filesystem or Docker mutation. */
export function validateNetworkPool(value: string): string {
  return parsePool(value).cidr;
}

export interface IsolatedNetworkOptions {
  name: string;
  pool: string;
  bridgeName: string;
  labels: Record<string, string>;
}
export type NetworkDocker = (args: string[]) => Promise<unknown>;

function overlaps(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as {
    code?: unknown;
    stderr?: unknown;
    signal?: unknown;
    killed?: unknown;
  };
  // Only a definite daemon rejection is safe to retry. A timeout, disconnect,
  // duplicate name, or ambiguous result must never create another network.
  return (
    failure.code === 1 &&
    !failure.signal &&
    !failure.killed &&
    typeof failure.stderr === "string" &&
    /(?:^|\n)Error response from daemon: (?:invalid pool request: )?Pool overlaps with other one on this address space\s*(?:\n|$)/i.test(
      failure.stderr,
    )
  );
}
function subnet(base: number): string {
  return (
    [24, 16, 8, 0].map((shift) => (base >>> shift) & 255).join(".") + "/28"
  );
}

/** Docker serializes subnet allocation; competing launches retry only confirmed overlaps. */
export async function createIsolatedNetwork(
  options: IsolatedNetworkOptions,
  docker: NetworkDocker,
): Promise<{ subnet: string }> {
  const pool = parsePool(options.pool);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(options.name) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,14}$/.test(options.bridgeName) ||
    !options.labels ||
    typeof options.labels !== "object" ||
    Array.isArray(options.labels)
  )
    throw new RuntimeError(
      "invalid_network",
      "Invalid isolated network configuration",
    );
  const labels = Object.entries(options.labels).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (
    labels.length > 16 ||
    labels.some(
      ([name, value]) =>
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) ||
        typeof value !== "string" ||
        value.length > 256 ||
        /[\x00-\x1f\x7f]/.test(value),
    )
  )
    throw new RuntimeError(
      "invalid_network",
      "Invalid isolated network labels",
    );
  const start =
    createHash("sha256").update(options.name).digest().readUInt32BE(0) %
    pool.slots;
  const attempts = Math.min(pool.slots, MAX_NETWORK_ALLOCATION_ATTEMPTS);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidate = subnet(pool.base + ((start + attempt) % pool.slots) * 16);
    const args = [
      "network",
      "create",
      "--driver",
      "bridge",
      "--internal",
      "--subnet",
      candidate,
      "--opt",
      `com.docker.network.bridge.name=${options.bridgeName}`,
      ...labels.flatMap(([name, value]) => ["--label", `${name}=${value}`]),
      options.name,
    ];
    try {
      await docker(args);
      return { subnet: candidate };
    } catch (error) {
      if (!overlaps(error)) throw error;
    }
  }
  throw new RuntimeError(
    "network_pool_exhausted",
    `Could not allocate an isolated /28 subnet in ${pool.cidr} after ${attempts} overlapping candidates`,
  );
}
