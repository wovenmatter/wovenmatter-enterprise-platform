import { isIP } from "node:net";
import { Resolver } from "node:dns/promises";
import { domainToASCII } from "node:url";
export interface Address {
  address: string;
  family: 4 | 6;
}
export interface Target {
  hostname: string;
  port: 80 | 443;
  path: string;
  authority: string;
}
export class EgressError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "EgressError";
  }
}
/** Canonical literal representation for trusted boundary comparisons. */
export function canonicalAddress(raw: string): string | undefined {
  if (typeof raw !== "string" || raw.includes("%")) return undefined;
  const family = isIP(raw);
  if (family === 4) return raw;
  if (family !== 6) return undefined;
  return new URL(`http://[${raw}]/`).hostname.slice(1, -1);
}
/** DNS names compare without case, IDNA, or a final root-label difference. */
export function canonicalHostname(raw: string): string {
  if (typeof raw !== "string" || !raw || raw.length > 253)
    throw new Error("Invalid network boundary hostname");
  const literal = canonicalAddress(raw.replace(/^\[|\]$/g, ""));
  if (literal) return literal;
  if (/[\s%/@?#\\:]/.test(raw))
    throw new Error("Invalid network boundary hostname");
  const hostname = domainToASCII(raw.replace(/\.$/, "")).toLowerCase();
  if (
    !hostname ||
    hostname.length > 253 ||
    hostname
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error("Invalid network boundary hostname");
  return canonicalAddress(hostname) ?? hostname;
}
/** Conservative global-unicast allowlist. Special-purpose ranges are not public egress. */
export function isPublicIP(address: string): boolean {
  if (address.includes("%")) return false;
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return (
      a > 0 &&
      a < 224 &&
      a !== 10 &&
      a !== 127 &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && b === 168) &&
      !(a === 192 && b === 0 && (c === 0 || c === 2)) &&
      !(a === 192 && b === 88 && c === 99) &&
      !(a === 198 && (b === 18 || b === 19)) &&
      !(a === 198 && b === 51 && c === 100) &&
      !(a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6 || address.includes(".")) return false;
  const halves = address.toLowerCase().split("::");
  const left = halves[0] ? halves[0].split(":") : [],
    right = halves[1] ? halves[1].split(":") : [];
  const parts =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
  if (parts.length !== 8) return false;
  const n = parts.reduce(
    (value, part) => (value << 16n) | BigInt(parseInt(part, 16)),
    0n,
  );
  const prefix = (value: bigint, bits: number) =>
    n >> BigInt(128 - bits) === value >> BigInt(128 - bits);
  if (!prefix(0x20000000000000000000000000000000n, 3)) return false;
  if (
    prefix(0x20010000000000000000000000000000n, 23) ||
    prefix(0x20010db8000000000000000000000000n, 32) ||
    prefix(0x20020000000000000000000000000000n, 16) ||
    prefix(0x3fff0000000000000000000000000000n, 20)
  )
    return false;
  return true;
}
interface HostResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  cancel(): void;
}
export async function resolveHost(
  hostname: string,
  signal?: AbortSignal,
  /** Isolated tests can supply a resolver without issuing real DNS requests. */
  createResolver: () => HostResolver = () =>
    new Resolver({ timeout: 3000, tries: 1 }),
): Promise<Address[]> {
  signal?.throwIfAborted();
  const literal = isIP(hostname);
  if (literal) return [{ address: hostname, family: literal as 4 | 6 }];
  const resolver = createResolver();
  const cancel = () => resolver.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const [v4, v6] = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    signal?.throwIfAborted();
    const results = [v4, v6];
    const hasAddresses = results.some(
      (result) => result.status === "fulfilled" && result.value.length > 0,
    );
    for (const result of results) {
      if (result.status !== "rejected") continue;
      const code = (result.reason as NodeJS.ErrnoException | undefined)?.code;
      // ENODATA means this family has no records. NXDOMAIN says the name does
      // not exist; accepting a simultaneous address would trust inconsistent DNS.
      if (code !== "ENODATA" && !(code === "ENOTFOUND" && !hasAddresses))
        throw new EgressError(502, "incomplete_dns_resolution");
    }
    return [
      ...(v4.status === "fulfilled"
        ? v4.value.map((address) => ({ address, family: 4 as const }))
        : []),
      ...(v6.status === "fulfilled"
        ? v6.value.map((address) => ({ address, family: 6 as const }))
        : []),
    ];
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
export function parseTarget(raw: string | undefined, connect: boolean): Target {
  if (!raw || raw.length > 8192 || /[\x00-\x20\x7f\\]/.test(raw))
    throw new EgressError(400, "invalid_target");
  if (connect && !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):(?:80|443)$/.test(raw))
    throw new EgressError(403, "port_not_allowed");
  let url: URL;
  try {
    url = new URL(connect ? `https://${raw}` : raw);
  } catch {
    throw new EgressError(400, "invalid_target");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname ||
    (connect
      ? url.protocol !== "https:" || (url.port !== "" && url.port !== "80")
      : url.protocol !== "http:" || (url.port !== "" && url.port !== "80"))
  )
    throw new EgressError(403, "target_not_allowed");
  let hostname: string;
  try {
    hostname = canonicalHostname(url.hostname);
  } catch {
    throw new EgressError(400, "invalid_target");
  }
  if (
    hostname.length > 253 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  )
    throw new EgressError(403, "private_target");
  return {
    hostname,
    port: connect && url.port !== "80" ? 443 : 80,
    path: url.pathname + url.search,
    authority: hostname.includes(":") ? `[${hostname}]` : hostname,
  };
}
