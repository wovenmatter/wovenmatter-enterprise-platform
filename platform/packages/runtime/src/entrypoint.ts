import { writeFile, unlink } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { assertIsolation, proxy } from "./process-boundary.js";
import {
  prepareNativeConfiguration,
  runCodex,
  runGrok,
  applyEgressEnvironment,
  type NativeSessionState,
} from "./native.js";
import { runClaude, runPi } from "./sdk.js";
import { SteeringChannel } from "./steering.js";
import {
  RuntimeError,
  type ContainerRequest,
  type RuntimeEvent,
} from "./types.js";
import { verifyMountEvidence } from "./mount-evidence.js";
import { MAX_LINE, validateContainerRequest } from "./validation.js";
import { backgroundService } from "./background.js";
import { runtimeEnvironment, egressEnvironment } from "./native.js";
process.umask(0o027);
await assertIsolation();
const retained: NativeSessionState = {};
let active:
  | { id: string; channel: SteeringChannel; controller: AbortController }
  | undefined;
let identity: string | undefined;
let prepared = false;
async function output(value: unknown) {
  if (!process.stdout.write(JSON.stringify(value) + "\n"))
    await once(process.stdout, "drain");
}
async function turn(request: ContainerRequest) {
  validateContainerRequest(request);
  if (active) throw new Error("Concurrent turn");
  const signature = JSON.stringify([
    request.harness,
    request.model,
    request.access,
    request.gateway,
  ]);
  if (identity && identity !== signature)
    throw new Error("Environment identity changed");
  identity = signature;
  const current = {
    id: request.runId,
    channel: new SteeringChannel(),
    controller: new AbortController(),
  };
  active = current;
  let terminal = false;
  const emit = async (event: RuntimeEvent) => {
    if (terminal || active !== current) return;
    if (["completed", "cancelled", "failed"].includes(event.type))
      terminal = true;
    await output({ runId: current.id, event });
  };
  try {
    await verifyMountEvidence(request.mountEvidence!);
    if (request.assetId)
      await writeFile(
        "/session/.wme-asset.json",
        JSON.stringify(request.gateway),
        { mode: 0o600 },
      );
    else
      await unlink("/session/.wme-asset.json").catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    if (!prepared) {
      await proxy(4101, "/broker/gateway.sock");
      if (request.egressProxyUrl) await proxy(4102, "/broker/egress.sock");
      applyEgressEnvironment(request);
      await prepareNativeConfiguration(request);
      await backgroundService(
        "/session/background",
        "/tmp/wme-background.sock",
        { ...runtimeEnvironment(), ...egressEnvironment(request) },
      );
      prepared = true;
    }
    await emit({ type: "started" });
    if (request.harness === "codex")
      await runCodex(
        request,
        emit,
        current.controller.signal,
        undefined,
        current.channel,
        retained,
      );
    else if (request.harness === "grok")
      await runGrok(
        request,
        emit,
        current.controller.signal,
        undefined,
        current.channel,
        retained,
      );
    else if (request.harness === "claude")
      await runClaude(
        request,
        emit,
        current.controller.signal,
        current.channel,
        undefined,
        retained,
      );
    else
      await runPi(
        request,
        emit,
        current.controller.signal,
        current.channel,
        retained,
      );
    await current.channel.settle();
    await emit({
      type: current.controller.signal.aborted ? "cancelled" : "completed",
    });
  } catch (error) {
    await current.channel.settle();
    await emit({
      type: "failed",
      code: error instanceof RuntimeError ? error.code : "agent_failed",
      message: "The native turn failed; it was not replayed.",
    });
  } finally {
    if (active === current) active = undefined;
    // Retain the namespace, native adapter, environment and deliberately detached tools.
    await output({ type: "turn_settled", runId: current.id });
  }
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (Buffer.byteLength(line) > MAX_LINE) process.exit(1);
  try {
    const data = JSON.parse(line);
    if (data.type === "turn") {
      void turn(data.request).catch(() => process.exit(1));
      return;
    }
    const current = active;
    if (
      data.type !== "steer" ||
      !current ||
      current.id !== data.runId ||
      typeof data.input?.content !== "string" ||
      data.input.content.length > 100000 ||
      !Number.isSafeInteger(data.input.sequence)
    )
      throw new Error("Invalid input");
    void current.channel
      .submit(data.input)
      .then(
        () =>
          output({
            type: "steering_receipt",
            runId: current.id,
            id: data.input.id,
            accepted: true,
          }),
        (error) =>
          output({
            type: "steering_receipt",
            runId: current.id,
            id: data.input.id,
            accepted: false,
            code:
              error instanceof RuntimeError ? error.code : "steering_uncertain",
          }),
      )
      .catch(() => process.exit(1));
  } catch {
    process.exit(1);
  }
});
// This pipe belongs to the workspace service, never to a client attachment.
lines.on("close", () => process.exit(0));
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => process.exit(0));
