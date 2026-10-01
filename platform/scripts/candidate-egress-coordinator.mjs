// Explicit, isolated acceptance helper. Its stdout is a private parent IPC channel:
// the single ready response contains a synthetic, short-lived run capability.
// Never print it to logs or run this against the customer control database.
import { createInterface } from "node:readline";
import { createEgressControlFixture } from "../dist/tests/fixtures/egress-control.js";
import { createSupervisorClient } from "../dist/deploy/client.js";

if (
  process.platform !== "linux" ||
  process.env.WME_RUN_CANDIDATE_EGRESS_COORDINATOR !== "1" ||
  !process.env.WME_STATE_DIR?.includes("candidate")
)
  throw new Error("Explicit isolated Linux candidate acceptance is required");
const client = createSupervisorClient({
  socketPath: process.env.WME_SUPERVISOR_SOCKET,
  tokenFile: process.env.WME_SUPERVISOR_TOKEN_FILE,
});
let control;
const commands = createInterface({ input: process.stdin, crlfDelay: Infinity });
let stopping;
function stop() {
  return (stopping ??= (async () => {
    await control?.close();
    commands.close();
  })());
}
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
const deadline = setTimeout(() => {
  void stop();
}, 180_000);
deadline.unref();
try {
  control = await createEgressControlFixture({
    host: "0.0.0.0",
    port: 0,
    networkBoundary: () => client.networkBoundary(),
  });
  if (stopping) {
    await control.close();
    throw new Error("Acceptance stopped during startup");
  }
  process.stdout.write(JSON.stringify(control.ready) + "\n");
  for await (const line of commands) {
    if (line === "revoke") {
      await control.revoke();
      process.stdout.write(JSON.stringify({ revoked: true }) + "\n");
    } else if (line === "stop") {
      await stop();
      process.stdout.write(JSON.stringify({ stopped: true }) + "\n");
      break;
    } else throw new Error("Invalid acceptance command");
  }
} catch {
  process.stdout.write(JSON.stringify({ error: "setup" }) + "\n");
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await stop();
}
