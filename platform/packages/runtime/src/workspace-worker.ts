import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { prepareSandbox } from "./execution-sandbox.js";
import { sessionBroker } from "./session-broker.js";
import { MAX_LINE, validateEvent } from "./validation.js";
import {
  RuntimeError,
  type RuntimeRequest,
  type ContainerRequest,
  type EventSink,
} from "./types.js";
import type { WorkspaceWorker } from "./workspace-service.js";
import {
  trackSandboxProcess,
  terminateSandboxProcess,
} from "./process-control.js";

export async function launchWorkspaceWorker(
  request: RuntimeRequest,
  key: string,
): Promise<WorkspaceWorker> {
  const brokerDirectory = join("/control/brokers", key);
  await rm(brokerDirectory, { recursive: true, force: true });
  const definition = JSON.parse(
    await readFile("/control/definition.json", "utf8"),
  );
  const assetWorkspace = definition.owner?.kind === "asset";
  const broker = await sessionBroker(
    brokerDirectory,
    request.projectId,
    {
      origin: assetWorkspace
        ? request.egressProxyUrl
        : definition.egressProxyUrl,
      token: assetWorkspace ? request.gateway.token : definition.egressToken,
    },
    async () => {
      if (assetWorkspace)
        return {
          origin: request.egressProxyUrl,
          token: broker.activeGateway()?.token,
        };
      const current = JSON.parse(
        await readFile("/control/definition.json", "utf8"),
      );
      return { origin: current.egressProxyUrl, token: current.egressToken };
    },
  );
  const sandbox = await prepareSandbox(
    join(
      "sessions",
      request.conversationId,
      request.harness,
      request.access,
      "environment",
    ),
    request.access,
    request.mounts,
    brokerDirectory,
  ).catch((error) => {
    broker.close();
    throw error;
  });
  const child = spawn("bwrap", sandbox.args, {
    uid: 10001,
    gid: 10001,
    stdio: ["pipe", "pipe", "pipe", ...sandbox.fds],
    env: { PATH: "/usr/bin:/bin:/usr/local/bin" },
  });
  trackSandboxProcess(child);
  const kill = () => {
    broker.close();
    void terminateSandboxProcess(child).catch(() => {});
  };
  let current:
    | {
        id: string;
        emit: EventSink;
        resolve: () => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let ended = false,
    output = Buffer.alloc(0),
    writes = Promise.resolve(),
    pendingBytes = 0;
  const receipts = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let closedResolve!: () => void;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  const fail = (error: Error) => {
    current?.reject(error);
    current = undefined;
    for (const receipt of receipts.values()) {
      clearTimeout(receipt.timer);
      receipt.reject(error);
    }
    receipts.clear();
  };
  child.stderr?.resume();
  child.once("error", () =>
    fail(
      new RuntimeError(
        "session_launch_failed",
        "The native environment could not start.",
      ),
    ),
  );
  child.stdin!.on("error", () => {
    fail(
      new RuntimeError("session_stopped", "The native environment stopped."),
    );
    kill();
  });
  child.once("close", () => {
    ended = true;
    fail(
      new RuntimeError("session_stopped", "The native environment stopped."),
    );
    broker.close();
    void sandbox
      .close()
      .then(() => rm(brokerDirectory, { recursive: true, force: true }))
      .finally(closedResolve)
      .catch(() => {});
  });
  child.stdout!.on("data", (chunk) => {
    output = Buffer.concat([output, chunk]);
    let end: number;
    while ((end = output.indexOf(10)) >= 0) {
      const line = output.subarray(0, end);
      output = output.subarray(end + 1);
      if (line.length > MAX_LINE) {
        kill();
        return;
      }
      pendingBytes += line.length;
      if (pendingBytes > 2 * MAX_LINE) child.stdout!.pause();
      writes = writes
        .then(async () => {
          const value = JSON.parse(line.toString());
          if (!current || value.runId !== current.id) return;
          if (value.type === "turn_settled") {
            const turn = current;
            current = undefined;
            broker.setGateway();
            turn.resolve();
            return;
          }
          if (value.type === "steering_receipt") {
            const receipt = receipts.get(value.id);
            if (receipt) {
              receipts.delete(value.id);
              clearTimeout(receipt.timer);
              value.accepted
                ? receipt.resolve()
                : receipt.reject(
                    new RuntimeError(
                      value.code ?? "steering_uncertain",
                      "Native input was not acknowledged.",
                    ),
                  );
            }
            return;
          }
          const event = validateEvent(value.event),
            turn = current;
          await turn.emit(event);
          if (["completed", "cancelled", "failed"].includes(event.type))
            broker.setGateway();
        })
        .finally(() => {
          pendingBytes -= line.length;
          if (pendingBytes < MAX_LINE) child.stdout!.resume();
        });
      void writes.catch((error) => {
        fail(error);
        kill();
      });
    }
    if (output.length > MAX_LINE) kill();
  });
  return {
    processId: child.pid,
    closed,
    turn(next, emit) {
      if (ended || current)
        return Promise.reject(
          new RuntimeError(
            "session_busy",
            "The native environment is unavailable.",
          ),
        );
      broker.setGateway(next.gateway);
      const payload: ContainerRequest = {
        runId: next.runId,
        ...(next.assetId ? { assetId: next.assetId } : {}),
        projectId: next.projectId,
        harness: next.harness,
        model: next.model,
        prompt: next.prompt,
        access: next.access,
        mountEvidence: sandbox.attestations,
        gateway: {
          baseUrl: "http://127.0.0.1:4101/inference",
          token: broker.token,
        },
        ...(broker.hasEgress
          ? { egressProxyUrl: "http://127.0.0.1:4102" }
          : {}),
        ...(next.resumeId ? { resumeId: next.resumeId } : {}),
      };
      return new Promise<void>((resolve, reject) => {
        current = { id: next.runId, emit, resolve, reject };
        child.stdin!.write(
          JSON.stringify({ type: "turn", request: payload }) + "\n",
        );
      });
    },
    steer(input) {
      if (ended || !current)
        return Promise.reject(
          new RuntimeError("run_ended", "The native turn ended."),
        );
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          receipts.delete(input.id);
          reject(
            new RuntimeError(
              "steering_uncertain",
              "Native input receipt was lost.",
            ),
          );
        }, 30000);
        receipts.set(input.id, { resolve, reject, timer });
        child.stdin!.write(
          JSON.stringify({ type: "steer", runId: current!.id, input }) + "\n",
        );
      });
    },
    async stop() {
      // Withdraw capabilities immediately even if the kernel cannot confirm process cleanup.
      broker.close();
      if (!ended) await terminateSandboxProcess(child);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new RuntimeError(
                    "stop_not_confirmed",
                    "The native environment has not stopped.",
                  ),
                ),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
