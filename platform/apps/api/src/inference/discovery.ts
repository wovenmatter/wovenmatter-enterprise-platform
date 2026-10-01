import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { InferenceError, object } from "./proxy-client.js";

/** Pin DNS resolution to the actual connection; a redirect cannot send an API key elsewhere. */
export async function discoverProviderModels(
  baseUrl: string,
  apiKey: string,
  approvedOrigins: string[] = [],
  provider = "custom",
): Promise<string[]> {
  let url: URL;
  try {
    url = new URL(
      baseUrl.replace(/\/$/, "") +
        (provider === "anthropic" ? "/v1/models" : "/models"),
    );
  } catch {
    throw new InferenceError(
      400,
      "invalid_base_url",
      "Enter a valid server URL.",
    );
  }
  const approved = approvedOrigins.includes(url.origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!approved &&
      (url.protocol !== "https:" || (url.port && url.port !== "443"))) ||
    !["https:", "http:"].includes(url.protocol)
  )
    throw new InferenceError(
      400,
      "invalid_base_url",
      "Use an HTTPS server URL without credentials or query parameters.",
    );
  let addresses: Awaited<ReturnType<typeof lookup>>[];
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new InferenceError(
      400,
      "provider_resolution_failed",
      "The provider server could not be resolved.",
    );
  }
  if (
    !addresses.length ||
    (!approved && addresses.some((item) => !isPublicAddress(item.address)))
  )
    throw new InferenceError(
      400,
      "provider_origin_not_approved",
      "Private network provider servers must be approved in the deployment configuration.",
    );
  const selected = addresses[0]!;
  const body = await new Promise<string>((resolve, reject) => {
    const rejectSafe = () =>
      reject(
        new InferenceError(
          502,
          "provider_discovery_failed",
          "Could not discover models. Check the server URL and API key.",
        ),
      );
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        hostname: selected.address,
        servername: url.hostname,
        port: url.port || undefined,
        path: url.pathname,
        method: "GET",
        headers: {
          host: url.host,
          ...(provider === "anthropic"
            ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
            : { authorization: `Bearer ${apiKey}` }),
          accept: "application/json",
        },
        timeout: 15_000,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          rejectSafe();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            req.destroy();
            rejectSafe();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", rejectSafe);
        response.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", rejectSafe);
    req.end();
  });
  try {
    const data = object(JSON.parse(body));
    const items = Array.isArray(data.data) ? data.data : [];
    const names = [
      ...new Set(
        items
          .map((item) => object(item).id)
          .filter(
            (id): id is string =>
              typeof id === "string" &&
              id.length > 0 &&
              id.length <= 200 &&
              !/[\u0000-\u001f]/.test(id),
          ),
      ),
    ].slice(0, 500);
    if (!names.length) throw new Error("empty");
    return names;
  } catch {
    throw new InferenceError(
      502,
      "provider_discovery_failed",
      "The provider did not return a supported model catalog.",
    );
  }
}
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a !== undefined &&
      b !== undefined &&
      a !== 0 &&
      a !== 10 &&
      a !== 127 &&
      a < 224 &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0)) &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19))
    );
  }
  // Require a global-unicast IPv6 address. IPv4-mapped, loopback, link-local,
  // unique-local and multicast ranges are excluded by this positive check.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:db8:/i.test(address)
  );
}
