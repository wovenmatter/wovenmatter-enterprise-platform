import { once } from "node:events";
import { readFile } from "node:fs/promises";
import {
  prepareNativeConfiguration,
  runCodex,
  runGrok,
  applyEgressEnvironment,
} from "./native.ts";
import { runClaude, runPi } from "./sdk.ts";
import {
  RuntimeError,
  type ContainerRequest,
  type RuntimeEvent,
} from "./types.ts";
import { MAX_LINE, validateContainerRequest } from "./validation.ts";
import { verifyMountEvidence } from "./mount-evidence.ts";

process.umask(0o027);

async function assertIsolation(): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 10001)
    throw new RuntimeError(
      "isolation_missing",
      "The agent must run in its isolated Linux container",
    );
  const status = await readFile("/proc/self/status", "utf8");
  if (
    !/^NoNewPrivs:\s+1$/m.test(status) ||
    !/^Seccomp:\s+2$/m.test(status) ||
    !/^CapEff:\s+0+$/m.test(status)
  )
    throw new RuntimeError(
      "isolation_missing",
      "Required kernel isolation is missing",
    );
  const profile = await readFile("/proc/self/attr/current", "utf8");
  if (!profile.startsWith("wme-platform-agent (enforce)"))
    throw new RuntimeError(
      "isolation_missing",
      "Required AppArmor profile is missing",
    );
}
async function input(): Promise<ContainerRequest> {
  let content = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    content = Buffer.concat([content, chunk]);
    if (content.length > MAX_LINE)
      throw new RuntimeError("request_limit", "Runtime request exceeds limit");
  }
  const result = JSON.parse(content.toString("utf8"));
  validateContainerRequest(result);
  return result;
}
let terminal = false;
async function emit(event: RuntimeEvent): Promise<void> {
  if (terminal)
    throw new RuntimeError("event_after_terminal", "Run is already complete");
  if (["completed", "cancelled", "failed"].includes(event.type))
    terminal = true;
  if (!process.stdout.write(JSON.stringify(event) + "\n"))
    await once(process.stdout, "drain");
}
const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());
process.once("SIGINT", () => abort.abort());
let restoreEgress = () => {};
try {
  await assertIsolation();
  const request = await input();
  await verifyMountEvidence(request.mountEvidence!);
  if (
    !request.mountEvidence?.some((entry) => entry.target === "/workspace") ||
    !request.mountEvidence.some((entry) => entry.target === "/session")
  )
    throw new RuntimeError(
      "mount_attestation_missing",
      "Workspace and session admission evidence is required",
    );
  restoreEgress = applyEgressEnvironment(request);
  await prepareNativeConfiguration(request);
  await emit({ type: "started" });
  const execute = {
    codex: runCodex,
    claude: runClaude,
    grok: runGrok,
    pi: runPi,
  }[request.harness];
  await execute(request, emit, abort.signal);
  await emit(
    abort.signal.aborted ? { type: "cancelled" } : { type: "completed" },
  );
} catch (error) {
  if (!terminal)
    await emit(
      abort.signal.aborted
        ? { type: "cancelled" }
        : {
            type: "failed",
            code: error instanceof RuntimeError ? error.code : "agent_failed",
            message:
              "Agent execution failed; the request was not automatically replayed.",
          },
    );
  process.exitCode = 1;
} finally {
  restoreEgress();
}
