import { canonicalAddress, canonicalHostname, EgressError } from "./address.js";

export interface NetworkBoundary {
  addresses: readonly string[];
  hostnames: readonly string[];
}

/** Trusted host metadata is additive for the lifetime of a proxy instance. */
export class ExcludedDestinations {
  private readonly addresses = new Set<string>();
  private readonly hostnames = new Set<string>();

  constructor(boundary: NetworkBoundary) {
    this.add(boundary);
  }

  add(boundary: NetworkBoundary): void {
    if (
      !boundary ||
      !Array.isArray(boundary.addresses) ||
      !boundary.addresses.length ||
      boundary.addresses.length > 256 ||
      !Array.isArray(boundary.hostnames) ||
      boundary.hostnames.length > 256
    )
      throw new Error("Invalid network boundary metadata");
    const addresses = new Set<string>(),
      hostnames = new Set<string>();
    const addAddress = (raw: string) => {
      const address = canonicalAddress(raw);
      if (!address) throw new Error("Invalid network boundary address");
      addresses.add(address);
      // A mapped host-interface address must also exclude its native IPv4 address.
      const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(address);
      if (mapped) {
        const high = parseInt(mapped[1]!, 16),
          low = parseInt(mapped[2]!, 16);
        addresses.add(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
      }
    };
    for (const address of boundary.addresses) addAddress(address);
    for (const raw of boundary.hostnames) {
      const hostname = canonicalHostname(raw);
      if (canonicalAddress(hostname)) addAddress(hostname);
      else hostnames.add(hostname);
    }
    // Never silently evict an exclusion after interface churn. Restart with fresh metadata.
    if (
      new Set([...this.addresses, ...addresses]).size > 4096 ||
      new Set([...this.hostnames, ...hostnames]).size > 4096
    )
      throw new Error("Network boundary capacity exceeded");
    for (const address of addresses) this.addresses.add(address);
    for (const hostname of hostnames) this.hostnames.add(hostname);
  }

  assertHostname(hostname: string): void {
    const canonical = canonicalHostname(hostname);
    if (canonicalAddress(canonical)) {
      this.assertAddress(canonical);
      return;
    }
    for (const excluded of this.hostnames)
      if (canonical === excluded || canonical.endsWith(`.${excluded}`))
        throw new EgressError(403, "excluded_target");
  }

  assertAddress(address: string): void {
    const canonical = canonicalAddress(address);
    if (!canonical || this.addresses.has(canonical))
      throw new EgressError(403, "excluded_target");
  }
}
