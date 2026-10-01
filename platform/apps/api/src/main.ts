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
    ? createSupervisorClient({ socketPath, tokenFile })
    : undefined;
// Docker may restart the API before the current-boot firewall and supervisor.
// Check readiness before opening SQLite or attempting durable library recovery.
// A normal process restart can retry this check without changing dashboard state.
await supervisor?.health();
let system: Awaited<ReturnType<typeof buildApp>> | undefined;
if (config.egressEnabled && !supervisor)
  throw new Error(
    "Public agent access requires the trusted runtime supervisor",
  );
const proxyOrigin = new URL(String(config.internalApiOrigin));
proxyOrigin.port = String(config.egressPort);
proxyOrigin.pathname = "/";
const egress = config.egressEnabled
  ? await createRuntimeEgress({
      runtime: supervisor!.runtime,
      proxyOrigin: proxyOrigin.origin,
      host: String(config.egressHost),
      port: Number(config.egressPort),
      networkBoundary: () => supervisor!.networkBoundary(),
      authorize: (projectId, token) => {
        if (!system)
          return Promise.reject(new Error("Agent authorization is not ready"));
        return system.inference.authorizeGateway(projectId, token);
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
    runtime: egress?.runtime ?? supervisor?.runtime,
    registry: supervisor?.registry,
    libraryHost: supervisor?.libraryHost,
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
  if (stopPromise) throw new Error("Startup interrupted");
  system.jobs.start();
  await system.app.listen({ host: config.host, port: config.port });
} catch (error) {
  await stop();
  throw error;
}
