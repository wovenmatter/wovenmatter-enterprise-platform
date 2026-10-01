import { networkInterfaces, hostname } from "node:os";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { Resolver } from "node:dns/promises";

/** Secret-free inventory available only over the authenticated supervisor socket. */
export interface NetworkBoundary {
  addresses: string[];
  hostnames: string[];
}

export function validateNetworkBoundary(value: unknown): NetworkBoundary {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid network boundary");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["addresses", "hostnames"].includes(key))
  )
    throw new Error("Invalid network boundary fields");
  if (
    !Array.isArray(record.addresses) ||
    !record.addresses.length ||
    record.addresses.length > 256 ||
    !Array.isArray(record.hostnames) ||
    record.hostnames.length > 256
  )
    throw new Error("Invalid network boundary size");
  const addresses = record.addresses.map((address) => {
    if (
      typeof address !== "string" ||
      address.length > 64 ||
      address.includes("%") ||
      !isIP(address)
    )
      throw new Error("Invalid network boundary address");
    return isIP(address) === 6
      ? new URL(`http://[${address}]/`).hostname.slice(1, -1)
      : address;
  });
  const hostnames = record.hostnames.map((name) => {
    if (
      typeof name !== "string" ||
      name.length > 253 ||
      /[\s/:@%?#]/.test(name)
    )
      throw new Error("Invalid network boundary hostname");
    const normalized = domainToASCII(name.replace(/\.$/, "").toLowerCase());
    if (
      !normalized ||
      normalized.length > 253 ||
      isIP(normalized) ||
      !normalized
        .split(".")
        .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
    )
      throw new Error("Invalid network boundary hostname");
    return normalized;
  });
  return {
    addresses: [...new Set(addresses)].sort(),
    hostnames: [...new Set(hostnames)].sort(),
  };
}

export function collectNetworkBoundary(
  options: {
    additionalAddresses?: string[];
    additionalHostnames?: string[];
    interfaces?: typeof networkInterfaces;
    hostname?: typeof hostname;
  } = {},
): NetworkBoundary {
  const addresses = Object.values(
    (options.interfaces ?? networkInterfaces)(),
  ).flatMap((entries) =>
    (entries ?? []).map((entry) => entry.address.split("%")[0]!),
  );
  return validateNetworkBoundary({
    addresses: [
      ...new Set([...addresses, ...(options.additionalAddresses ?? [])]),
    ],
    hostnames: [
      ...new Set([
        (options.hostname ?? hostname)(),
        ...(options.additionalHostnames ?? []),
      ]),
    ],
  });
}

export function configuredBoundary(environment: NodeJS.ProcessEnv): {
  additionalAddresses: string[];
  additionalHostnames: string[];
  ingressHostnames: string[];
} {
  const split = (value: string | undefined) =>
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  const names = split(environment.WME_EGRESS_DENIED_HOSTS);
  const addresses = split(environment.WME_EGRESS_DENIED_IPS);
  const ingress = split(environment.WME_EGRESS_INGRESS_HOSTS);
  const publicName = (name: string) => {
    const literal = name.replace(/^\[|\]$/g, "");
    if (isIP(literal)) {
      addresses.push(literal);
      return;
    }
    names.push(name);
    if (
      name !== "localhost" &&
      !/\.(?:test|localhost|invalid|local)$/.test(name)
    )
      ingress.push(name);
  };
  if (environment.WME_PUBLIC_ORIGIN)
    publicName(new URL(environment.WME_PUBLIC_ORIGIN).hostname);
  if (environment.WME_CONTENT_ORIGIN_TEMPLATE) {
    const template = environment.WME_CONTENT_ORIGIN_TEMPLATE;
    const sampleId = "00000000-0000-4000-8000-000000000000";
    const url = new URL(template.replace("{assetId}", sampleId).replace("{orgSlug}", "org"));
    const [label, ...rest] = url.hostname.split(".");
    if (!template.includes("{assetId}") || !label?.includes(sampleId) || !rest.length ||
        !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash || /[{}]/.test(url.hostname))
      throw new Error("Expected per-asset content hostname template");
    const parent = rest.join(".");
    names.push(parent);
    if (parent !== "localhost" && !/\.(?:test|localhost|invalid|local)$/.test(parent))
      ingress.push(url.hostname);
  }
  const normalized = validateNetworkBoundary({
    addresses: ["127.0.0.1"],
    hostnames: [...new Set([...names, ...ingress])],
  });
  const normalizedIngress = validateNetworkBoundary({
    addresses: ["127.0.0.1"],
    hostnames: [...new Set(ingress)],
  }).hostnames;
  if (normalizedIngress.length > 32)
    throw new Error("At most 32 public ingress hostnames may be configured");
  return {
    additionalAddresses: addresses,
    additionalHostnames: normalized.hostnames,
    ingressHostnames: normalizedIngress,
  };
}

export function ingressAnswers(
  results: PromiseSettledResult<string[]>[],
): string[] {
  const addresses: string[] = [];
  let missingName = false;
  for (const result of results) {
    if (result.status === "fulfilled") addresses.push(...result.value);
    else if (result.reason?.code === "ENOTFOUND") missingName = true;
    else if (result.reason?.code !== "ENODATA")
      throw new Error("Ingress DNS boundary is unavailable");
  }
  if (!addresses.length || missingName)
    throw new Error("Ingress DNS boundary is incomplete");
  return addresses;
}

async function resolveIngress(hostname: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 1_000, tries: 1 });
  const timer = setTimeout(() => resolver.cancel(), 3_000);
  timer.unref();
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    return ingressAnswers(results);
  } finally {
    clearTimeout(timer);
  }
}

/** Interface inventory is always fresh; ingress DNS is cached briefly and fails closed. */
export function createNetworkBoundaryReader(
  configuration: ReturnType<typeof configuredBoundary>,
  options: {
    resolve?: (hostname: string) => Promise<string[]>;
    interfaces?: typeof networkInterfaces;
    hostname?: typeof hostname;
    now?: () => number;
  } = {},
) {
  let expires = 0;
  let ingressAddresses: string[] = [];
  let flight: Promise<void> | undefined;
  return async (): Promise<NetworkBoundary> => {
    const now = options.now ?? Date.now;
    if (now() >= expires) {
      flight ??= (async () => {
        const resolved = await Promise.allSettled(
          configuration.ingressHostnames.map(options.resolve ?? resolveIngress),
        );
        const failed = resolved.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        ingressAddresses = resolved.flatMap((result) =>
          result.status === "fulfilled" ? result.value : [],
        );
        // Validate DNS output before retaining it; never publish a partial exclusion list.
        validateNetworkBoundary({
          addresses: ["127.0.0.1", ...ingressAddresses],
          hostnames: [],
        });
        expires = now() + 5_000;
      })().finally(() => {
        flight = undefined;
      });
      await flight;
    }
    return collectNetworkBoundary({
      ...configuration,
      interfaces: options.interfaces,
      hostname: options.hostname,
      additionalAddresses: [
        ...configuration.additionalAddresses,
        ...ingressAddresses,
      ],
    });
  };
}
