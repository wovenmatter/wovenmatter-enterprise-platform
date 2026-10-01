import { chmod, chown, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { listenSupervisor } from "./supervisor-listener.js";
import { DockerRuntime } from "../packages/runtime/src/index.js";
import { DockerLibraryRuntime } from "../apps/api/src/library/runtime.js";
import { OrganizationProxyProvisioner } from "./provisioning.js";
import { createSupervisorServer } from "./supervisor-server.js";
import {
  collectNetworkBoundary,
  createNetworkBoundaryReader,
  configuredBoundary,
} from "./network-boundary.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const stateDir = resolve(required("WME_STATE_DIR"));
const socketPath = resolve(required("WME_SUPERVISOR_SOCKET"));
const token = (
  await readFile(required("WME_SUPERVISOR_TOKEN_FILE"), "utf8")
).trim();
const firewallAttestation = required("WME_INFERENCE_FIREWALL_ATTESTATION");
if (
  (await readFile(firewallAttestation, "utf8")).trim() !==
  (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
)
  throw new Error(
    "Install candidate network isolation rules for this host boot before starting the supervisor",
  );
const sessionRoot = resolve(
  process.env.WME_SESSION_ROOT ?? `${stateDir}/agent-sessions`,
);
const storageRoots = [resolve(`${stateDir}/workspaces`)];
const networkPool = required("WME_ISOLATED_NETWORK_POOL");
const boundaryConfiguration = configuredBoundary(process.env);
collectNetworkBoundary(boundaryConfiguration); // Reject malformed trusted configuration locally.
const networkBoundary = createNetworkBoundaryReader(boundaryConfiguration);
const egressProxyOrigins: string[] = [];
if (process.env.WME_EGRESS_ENABLED === "true") {
  const port = Number(process.env.WME_EGRESS_PORT ?? 4101);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid internal egress proxy port");
  const origin = new URL(required("WME_INTERNAL_API_ORIGIN"));
  if (origin.protocol !== "http:" || origin.username || origin.password)
    throw new Error("The internal proxy requires a private HTTP API origin");
  origin.port = String(port);
  egressProxyOrigins.push(origin.origin);
}
const runtime = new DockerRuntime({
  image: required("WME_RUNNER_IMAGE"),
  network: required("WME_RUNNER_NETWORK"),
  networkPool,
  storageRoots,
  sessionRoot,
  journalRoot: resolve(required("WME_RUNTIME_JOURNAL_ROOT")),
  gatewayOrigins: required("WME_INTERNAL_API_ORIGIN")
    .split(",")
    .map((origin) => new URL(origin).origin),
  appArmorProfile: required("WME_RUNNER_APPARMOR_PROFILE"),
  gatewayContainer: required("WME_GATEWAY_CONTAINER"),
  egressProxyOrigins,
});
const registry = new OrganizationProxyProvisioner({
  root: resolve(required("WME_INFERENCE_ROOT")),
  image: required("WME_INFERENCE_IMAGE"),
  network: required("WME_INFERENCE_NETWORK"),
  credentialUid: 10002,
  firewallAttestation,
});
const library = new DockerLibraryRuntime({
  stateDir,
  dataRoots: storageRoots,
  image: required("WME_LIBRARY_IMAGE"),
  networkPool,
});
const recoveredRunIds: string[] = [];
let ready = false;
const server = createSupervisorServer({
  token,
  runtime,
  registry,
  library,
  recoveredRunIds,
  ready: () => ready,
  networkBoundary,
});
await listenSupervisor(server, socketPath, async () => {
  await chmod(socketPath, 0o660);
  if (process.getuid?.() === 0) {
    await chown(dirname(socketPath), 0, 10001);
    await chown(socketPath, 0, 10001);
  }
  // Only the process that owns the listening socket may recover old runs.
  recoveredRunIds.push(...(await runtime.recover()));
  ready = true;
});
console.info("WovenMatter Enterprise Platform supervisor ready.");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    ready = false;
    // Node owns unlinking this listener. A second unlink could remove the
    // successor's socket after exclusive ownership has been released.
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
