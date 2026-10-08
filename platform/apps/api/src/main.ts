import { readHosts, placedRuntime } from "../../../deploy/placement.js";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { mailConfigFromEnvironment } from "./mail/index.js";
import { createRuntimeEgress } from "./runtime-egress.js";
import { createSupervisorClient } from "../../../deploy/client.js";
const config = loadConfig();
config.internalApiOrigin =
  process.env.WME_INTERNAL_API_ORIGIN ?? config.publicOrigin;
config.customProviderOrigins = (process.env.WME_CUSTOM_PROVIDER_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const socketPath = process.env.WME_SUPERVISOR_SOCKET;
const tokenFile = process.env.WME_SUPERVISOR_TOKEN_FILE;
if (Boolean(socketPath) !== Boolean(tokenFile))
  throw new Error("Both supervisor socket and token file are required");
if (process.env.NODE_ENV === "production" && !socketPath)
  throw new Error("Production requires the runtime supervisor");
const supervisor =
  socketPath && tokenFile
    ? createSupervisorClient({
        socketPath,
        tokenFile,
      })
    : undefined;
// Docker may restart the API before the current-boot firewall and supervisor.
// Check readiness before opening SQLite or attempting durable library recovery.
// A normal process restart can retry this check without changing dashboard state.
await supervisor?.health();
let system: Awaited<ReturnType<typeof buildApp>> | undefined;
const hosts = process.env.WME_HOSTS_FILE
  ? await readHosts(process.env.WME_HOSTS_FILE, config.stateDir)
  : undefined;
if (hosts)
  config.hosts = hosts.map((h) => ({
    id: h.id,
    name: h.name,
  }));
const placed = hosts
  ? placedRuntime(
      hosts,
      async (id) => {
        if (id.startsWith("asset-"))
          return system!.assetAgents.spec(id.slice(6));
        const row = await system?.ctx.db.get<any>(
          "SELECT id,org_id,host_id FROM projects WHERE id=?",
          [id],
        );
        if (!row) throw new Error("Project placement unavailable");
        return {
          projectId: row.id,
          organizationId: row.org_id,
          hostId: row.host_id,
        };
      },
      async (id) =>
        (
          await system?.ctx.db.get<{
            project_id: string;
          }>(
            "SELECT COALESCE(project_id,'asset-'||asset_id) AS project_id FROM conversation_runs WHERE id=?",
            [id],
          )
        )?.project_id,
    )
  : undefined;
await placed?.health();
const selectedRuntime = placed?.runtime ?? supervisor?.runtime;
if (config.egressEnabled && !supervisor)
  throw new Error(
    "Public agent access requires the trusted runtime supervisor",
  );
const proxyOrigin = new URL(String(config.internalApiOrigin));
proxyOrigin.port = String(config.egressPort);
proxyOrigin.pathname = "/";
const egress = config.egressEnabled
  ? await createRuntimeEgress({
      runtime: selectedRuntime!,
      proxyOrigin: proxyOrigin.origin,
      host: String(config.egressHost),
      port: Number(config.egressPort),
      networkBoundary: () => supervisor!.networkBoundary(),
      issueProjectCapability: (spec) =>
        system!.inference.issueProjectEgress(spec),
      authorize: (projectId, token) => {
        if (!system)
          return Promise.reject(new Error("Agent authorization is not ready"));
        return system.inference.authorizeEgress(projectId, token);
      },
    })
  : undefined;
let stopPromise: Promise<void> | undefined;
function stop(): Promise<void> {
  return (stopPromise ??= (async () => {
    await egress?.close();
    await system?.app.close();
  })());
}
try {
  system = await buildApp(config, {
    runtime: egress?.runtime ?? selectedRuntime,
    registry: supervisor?.registry,
    mail: mailConfigFromEnvironment(process.env),
    logger: true,
    jobs: false,
    startConversations: false,
  });
  process.on("SIGTERM", () => {
    void stop();
  });
  process.on("SIGINT", () => {
    void stop();
  });
  await egress?.start();
  if (stopPromise) throw new Error("Startup interrupted");
  await system.conversations.start();
  await system.ctx.onAccessChanged!();
  if (stopPromise) throw new Error("Startup interrupted");
  system.jobs.start();
  await system.app.listen({
    host: config.host,
    port: config.port,
  });
} catch (error) {
  await stop();
  throw error;
}
