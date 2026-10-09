import { resolve } from "node:path";
export interface AppConfig {
  stateDir: string;
  publicOrigin: string;
  host: string;
  port: number;
  secureCookies: boolean;
  sessionCookieName?: string;
  [key: string]: unknown;
}
export function loadConfig(env = process.env): AppConfig {
  const originUrl = new URL(env.WME_PUBLIC_ORIGIN ?? "http://localhost:4100");
  if (
    !["http:", "https:"].includes(originUrl.protocol) ||
    originUrl.username ||
    originUrl.password ||
    originUrl.pathname !== "/" ||
    originUrl.search ||
    originUrl.hash
  )
    throw new Error(
      "Public origin must be an HTTP(S) origin without credentials or a path",
    );
  const publicOrigin = originUrl.origin;
  const port = Number(env.PORT ?? env.WME_PORT ?? 4100);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid port");
  const egressEnabled = env.WME_EGRESS_ENABLED ?? "false";
  if (!["true", "false"].includes(egressEnabled))
    throw new Error("WME_EGRESS_ENABLED must be true or false");
  const egressPort = Number(env.WME_EGRESS_PORT ?? 4101);
  if (
    !Number.isInteger(egressPort) ||
    egressPort < 1 ||
    egressPort > 65535 ||
    egressPort === port
  )
    throw new Error("Invalid or conflicting egress port");
  const secureCookies = publicOrigin.startsWith("https://");
  const sessionCookieName = env.WME_SESSION_COOKIE_NAME ?? "wme_session";
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(sessionCookieName))
    throw new Error(
      "WME_SESSION_COOKIE_NAME must be a lowercase cookie name without a prefix",
    );
  if (env.NODE_ENV === "production" && !secureCookies)
    throw new Error("Production public origin must use HTTPS");
  function concurrency(name: string, fallback: number) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 64)
      throw new Error(`${name} must be an integer from 1 to 64`);
    return value;
  }
  const assetIdleSeconds = Number(env.WME_ASSET_IDLE_SECONDS ?? 300);
  if (
    !Number.isInteger(assetIdleSeconds) ||
    assetIdleSeconds < 30 ||
    assetIdleSeconds > 86400
  )
    throw new Error("WME_ASSET_IDLE_SECONDS must be 30–86400");
  return {
    assetIdleMs: assetIdleSeconds * 1000,
    egressEnabled: egressEnabled === "true",
    egressHost: env.WME_EGRESS_HOST ?? env.WME_HOST ?? "127.0.0.1",
    egressPort,
    maxConcurrentRuns: concurrency("WME_MAX_CONCURRENT_RUNS", 8),
    maxConcurrentRunsPerOrganization: concurrency(
      "WME_MAX_CONCURRENT_RUNS_PER_ORGANIZATION",
      4,
    ),
    stateDir: resolve(env.WME_STATE_DIR ?? "./platform/.state"),
    publicOrigin,
    host: env.WME_HOST ?? "127.0.0.1",
    port,
    secureCookies,
    sessionCookieName,
  };
}
