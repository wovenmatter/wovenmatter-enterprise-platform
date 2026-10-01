import { chmod, chown, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { listenSupervisor } from "./supervisor-listener.js";
import { DockerRuntime } from "../packages/runtime/src/index.js";
import { OrganizationProxyProvisioner } from "./provisioning.js";
import {
  createSupervisorServer,
  createTlsSupervisorServer,
} from "./supervisor-server.js";
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
const socketPath = process.env.WME_SUPERVISOR_SOCKET
  ? resolve(process.env.WME_SUPERVISOR_SOCKET)
  : undefined;
const tlsHost = process.env.WME_SUPERVISOR_TLS_HOST;
if (Boolean(socketPath) === Boolean(tlsHost))
  throw new Error("Choose exactly one Unix or mutual TLS listener");
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
  hostId: process.env.WME_HOST_ID ?? "local",
  supervisorAppArmorProfile:
    process.env.WME_PROJECT_APPARMOR_PROFILE ?? "wme-project-supervisor",
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
  networkSubnet: process.env.WME_INFERENCE_SUBNET,
  credentialUid: 10002,
  firewallAttestation,
});
const recoveredRunIds: string[] = [];
let ready = false;
const dependencies = {
  token,
  storageRoot: stateDir,
  hostId: process.env.WME_HOST_ID ?? "local",
  runtime,
  registry,
  recoveredRunIds,
  ready: () => ready,
  networkBoundary,
};
const server = socketPath
  ? createSupervisorServer(dependencies)
  : createTlsSupervisorServer(dependencies, {
      key: await readFile(required("WME_SUPERVISOR_TLS_KEY_FILE")),
      cert: await readFile(required("WME_SUPERVISOR_TLS_CERT_FILE")),
      ca: await readFile(required("WME_SUPERVISOR_TLS_CA_FILE")),
    });
async function recover() {
  recoveredRunIds.push(...(await runtime.recover()));
  ready = true;
}
if (socketPath)
  await listenSupervisor(server, socketPath, async () => {
    await chmod(socketPath, 0o660);
    if (process.getuid?.() === 0) {
      await chown(dirname(socketPath), 0, 10001);
      await chown(socketPath, 0, 10001);
    }
    // Only the process that owns the listening socket may recover old runs.
    await recover();
  });
else {
  const port = Number(required("WME_SUPERVISOR_TLS_PORT"));
  if (
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    tlsHost === "0.0.0.0" ||
    tlsHost === "::"
  )
    throw new Error("Use an explicit private TLS listener address and port");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, tlsHost, resolve);
  });
  await recover();
}
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
