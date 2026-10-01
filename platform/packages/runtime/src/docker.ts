import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rename, readFile, readdir, open } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  RuntimeError,
  type Runtime,
  type RuntimeRequest,
  type EventSink,
  type RuntimeEvent,
  type ContainerRequest,
} from "./types.ts";
import {
  identity,
  MAX_LINE,
  MAX_OUTPUT,
  validateEvent,
  validateHostRequest,
} from "./validation.ts";
import { ensureStorageVolumes, volumeMount } from "./volumes.ts";
import { createIsolatedNetwork, validateNetworkPool } from "./networks.ts";
import { pinMountSources, type PinnedMounts } from "./mount-evidence.ts";

const exec = promisify(execFile);
export interface DockerRuntimeOptions {
  image: string;
  network: string;
  /** Explicit operator-selected private pool; never falls back to Docker default IPAM. */
  networkPool: string;
  /** The API/gateway is the only other container attached to each private run network. */
  gatewayContainer: string;
  storageRoots: string[];
  sessionRoot: string;
  journalRoot: string;
  gatewayOrigins: string[];
  /** Trusted internal HTTP proxy origins. Empty/omitted rejects all egress capabilities. */
  egressProxyOrigins?: string[];
  dockerBinary?: string;
  timeoutMs?: number;
  /** Absolute host-installed AppArmor profile name; fail closed if absent on host. */
  appArmorProfile: string;
  /** Test-only injection for platforms without Linux /proc; never enabled by deployment. */
  pinMounts?: typeof pinMountSources;
}
export function containerArguments(
  request: RuntimeRequest,
  options: DockerRuntimeOptions,
  allocationId?: string,
): string[] {
  identity(request.runId);
  identity(options.network);
  identity(options.appArmorProfile);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]+$/.test(options.image))
    throw new RuntimeError("invalid_image", "Invalid runtime image");
  const args = [
    "create",
    "--interactive",
    "--name",
    "wme-run-" + request.runId,
    "--label",
    "com.wovenmatter.enterprise.runtime=true",
    "--label",
    "com.wovenmatter.enterprise.run=" + request.runId,
    "--label",
    "com.wovenmatter.enterprise.project=" + identity(request.projectId),
    "--read-only",
    "--user",
    "10001:10001",
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--security-opt",
    "apparmor=" + options.appArmorProfile,
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--ulimit",
    "nofile=4096:4096",
    "--network",
    runNetwork(request.runId, options.network),
    "--ipc",
    "private",
    "--log-driver",
    "none",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    "--tmpfs",
    "/home/agent:rw,nosuid,nodev,size=128m,uid=10001,gid=10001,mode=0700",
    "--mount",
    volumeMount(
      request.sessionDirectory,
      "/session",
      [options.sessionRoot],
      false,
    ),
    "--workdir",
    "/workspace",
  ];
  for (const mount of [...request.mounts].sort(
    (a, b) => a.target.length - b.target.length,
  )) {
    const readOnly = request.access === "read" || mount.access === "read";
    args.push(
      "--mount",
      volumeMount(mount.source, mount.target, options.storageRoots, readOnly),
    );
  }
  if (allocationId)
    args.push(
      "--label",
      "com.wovenmatter.enterprise.allocation=" + identity(allocationId),
    );
  args.push(options.image);
  return args;
}
export function runNetwork(runId: string, prefix: string): string {
  identity(runId);
  identity(prefix);
  return (
    prefix.slice(0, 24) +
    "-" +
    createHash("sha256").update(runId).digest("hex").slice(0, 24)
  );
}
interface Journal {
  runId: string;
  allocationId?: string;
  conversationId: string;
  status: "dispatching" | "completed" | "cancelled" | "failed" | "interrupted";
  updatedAt: string;
}
/** Host-only service. Never make its filesystem/Docker authority reachable from agent tools. */
export class DockerRuntime implements Runtime {
  private readonly options: DockerRuntimeOptions;
  private readonly active = new Map<string, AbortController>();
  private readonly allocations = new Map<string, string>();
  private readonly conversations = new Set<string>();
  constructor(options: DockerRuntimeOptions) {
    validateNetworkPool(options.networkPool);
    this.options = options;
  }
  private async journal(record: Journal): Promise<void> {
    await mkdir(this.options.journalRoot, { recursive: true, mode: 0o700 });
    const target = join(
      this.options.journalRoot,
      identity(record.runId) + ".json",
    );
    const temporary = target + ".tmp";
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    const directory = await open(this.options.journalRoot, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async execute(
    request: RuntimeRequest,
    emit: EventSink,
    signal?: AbortSignal,
  ): Promise<void> {
    await validateHostRequest(
      request,
      this.options.storageRoots,
      this.options.sessionRoot,
    );
    if (
      !this.options.gatewayOrigins.includes(
        new URL(request.gateway.baseUrl).origin,
      )
    )
      throw new RuntimeError(
        "invalid_gateway",
        "Inference gateway is not allowed",
      );
    if (
      request.egressProxyUrl !== undefined &&
      !this.options.egressProxyOrigins?.includes(
        new URL(request.egressProxyUrl).origin,
      )
    )
      throw new RuntimeError(
        "invalid_egress",
        "Runtime egress proxy is not allowed",
      );
    const key = `${request.organizationId}/${request.projectId}/${request.conversationId}`;
    if (this.active.has(request.runId) || this.conversations.has(key))
      throw new RuntimeError(
        "run_active",
        "This conversation already has an active run",
      );
    signal?.throwIfAborted();
    const controller = new AbortController();
    this.active.set(request.runId, controller);
    this.conversations.add(key);
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const journal: Journal = {
      runId: request.runId,
      allocationId: randomUUID(),
      conversationId: request.conversationId,
      status: "dispatching",
      updatedAt: new Date().toISOString(),
    };
    this.allocations.set(request.runId, journal.allocationId!);
    let terminal: RuntimeEvent | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let admitted = false;
    let networkCreationAttempted = false;
    let pinned: PinnedMounts | undefined;
    try {
      // Reserve in memory before any await; the API's durable lease serializes hosts.
      try {
        await readFile(join(this.options.journalRoot, request.runId + ".json"));
        throw new RuntimeError(
          "duplicate_run",
          "This run has already been dispatched",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.journal(journal); // Persist before spawn, including uncertain spawn outcomes.
      admitted = true;
      if (controller.signal.aborted)
        throw new RuntimeError("cancelled", "Run cancelled before dispatch");
      pinned = await (this.options.pinMounts ?? pinMountSources)(
        [
          ...request.mounts,
          { source: request.sessionDirectory, target: "/session" },
        ],
        [...this.options.storageRoots, this.options.sessionRoot],
      );
      await ensureStorageVolumes(
        [...this.options.storageRoots, this.options.sessionRoot],
        (args) =>
          exec(this.options.dockerBinary ?? "docker", args, {
            timeout: 15000,
            maxBuffer: MAX_LINE,
          }),
      );
      const network = runNetwork(request.runId, this.options.network);
      const gatewayHostname = new URL(request.gateway.baseUrl).hostname;
      identity(gatewayHostname);
      identity(this.options.gatewayContainer);
      networkCreationAttempted = true;
      await createIsolatedNetwork(
        {
          name: network,
          pool: this.options.networkPool,
          bridgeName: `br-wmerun${createHash("sha256").update(request.runId).digest("hex").slice(0, 6)}`,
          labels: {
            "com.wovenmatter.enterprise.runtime": "true",
            "com.wovenmatter.enterprise.run": request.runId,
            "com.wovenmatter.enterprise.allocation": journal.allocationId!,
          },
        },
        (args) => {
          controller.signal.throwIfAborted();
          return exec(this.options.dockerBinary ?? "docker", args, {
            timeout: 15000,
            maxBuffer: MAX_LINE,
          });
        },
      );
      await exec(
        this.options.dockerBinary ?? "docker",
        [
          "network",
          "connect",
          "--alias",
          gatewayHostname,
          network,
          this.options.gatewayContainer,
        ],
        { timeout: 15000 },
      );
      await exec(
        this.options.dockerBinary ?? "docker",
        containerArguments(request, this.options, journal.allocationId),
        { timeout: 30000, maxBuffer: MAX_LINE },
      );
      // Cancellation during container creation cannot race a later launch.
      if (controller.signal.aborted)
        throw new RuntimeError("cancelled", "Run cancelled before launch");
      const child = spawn(
        this.options.dockerBinary ?? "docker",
        ["start", "--attach", "--interactive", "wme-run-" + request.runId],
        { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } },
      );
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      // Attach immediately: an early spawn failure must not become an unhandled rejection.
      void exited.catch(() => {});
      const stop = () => {
        void this.stopContainer(request.runId, journal.allocationId).catch(() =>
          child.kill("SIGKILL"),
        );
      };
      controller.signal.addEventListener("abort", stop, { once: true });
      timeout = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? 30 * 60 * 1000,
      );
      let stderrBytes = 0;
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_OUTPUT) controller.abort();
      });
      child.stdin.on("error", () => controller.abort());
      const payload: ContainerRequest = {
        runId: request.runId,
        projectId: request.projectId,
        harness: request.harness,
        model: request.model,
        prompt: request.prompt,
        access: request.access,
        gateway: request.gateway,
        ...(request.egressProxyUrl
          ? { egressProxyUrl: request.egressProxyUrl }
          : {}),
        mountEvidence: pinned.evidence,
        ...(request.resumeId ? { resumeId: request.resumeId } : {}),
      };
      child.stdin.end(JSON.stringify(payload) + "\n");
      let pending = Buffer.alloc(0),
        size = 0;
      for await (const chunk of child.stdout) {
        size += chunk.length;
        if (size > MAX_OUTPUT)
          throw new RuntimeError(
            "output_limit",
            "Runtime output exceeded its limit",
          );
        pending = Buffer.concat([pending, chunk]);
        let end: number;
        while ((end = pending.indexOf(10)) >= 0) {
          if (end > MAX_LINE)
            throw new RuntimeError(
              "output_limit",
              "Runtime event exceeded its limit",
            );
          const line = pending.subarray(0, end).toString("utf8");
          pending = pending.subarray(end + 1);
          if (!line) continue;
          const event = validateEvent(JSON.parse(line));
          if (terminal)
            throw new RuntimeError(
              "invalid_event",
              "Runtime emitted data after completion",
            );
          if (["completed", "cancelled", "failed"].includes(event.type))
            terminal = event;
          else await emit(event);
        }
        if (pending.length > MAX_LINE)
          throw new RuntimeError(
            "output_limit",
            "Runtime event exceeded its limit",
          );
      }
      const code = await exited;
      if (controller.signal.aborted) terminal = { type: "cancelled" };
      else if (pending.length || code !== 0 || !terminal)
        throw new RuntimeError(
          "runtime_disconnected",
          "Agent disconnected; the request was not automatically replayed",
        );
      journal.status =
        terminal!.type === "completed"
          ? "completed"
          : terminal!.type === "cancelled"
            ? "cancelled"
            : "failed";
    } catch (error) {
      if (!admitted) throw error;
      terminal = controller.signal.aborted
        ? { type: "cancelled" }
        : {
            type: "failed",
            code: error instanceof RuntimeError ? error.code : "runtime_failed",
            message:
              "Agent execution stopped. The request was not automatically replayed.",
          };
      journal.status = terminal.type === "cancelled" ? "cancelled" : "failed";
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      // Retain the receipt even when cleanup fails so the same request cannot run twice.
      try {
        if (admitted) {
          // A timed-out create may have succeeded. Inspect the persisted allocation
          // labels before cleanup; any uncertainty retains the dispatching receipt.
          if (networkCreationAttempted) {
            await this.stopContainer(request.runId, journal.allocationId);
            await this.removeNetwork(request.runId, journal.allocationId);
          }
          await this.journal({
            ...journal,
            updatedAt: new Date().toISOString(),
          });
          if (terminal) await emit(terminal);
        }
      } finally {
        await pinned?.close();
        this.active.delete(request.runId);
        this.allocations.delete(request.runId);
        this.conversations.delete(key);
      }
    }
  }
  private async ownedResource(
    kind: "container" | "network",
    runId: string,
    allocationId?: string,
  ): Promise<string | undefined> {
    const name =
      kind === "container"
        ? "wme-run-" + identity(runId)
        : runNetwork(runId, this.options.network);
    let result: { stdout: string };
    try {
      result = await exec(
        this.options.dockerBinary ?? "docker",
        kind === "container"
          ? ["container", "inspect", name]
          : ["network", "inspect", name],
        { timeout: 15000, maxBuffer: MAX_LINE, encoding: "utf8" },
      );
    } catch (error) {
      const failure = error as {
        code?: number;
        stderr?: string;
        killed?: boolean;
        signal?: string;
      };
      if (
        failure.code === 1 &&
        !failure.killed &&
        !failure.signal &&
        typeof failure.stderr === "string" &&
        (failure.stderr.includes("No such container: " + name) ||
          failure.stderr.includes("No such object: " + name) ||
          failure.stderr.includes("No such network: " + name) ||
          failure.stderr.includes("network " + name + " not found"))
      )
        return undefined;
      throw error;
    }
    const records = JSON.parse(result.stdout) as Array<{
      Id?: string;
      Name?: string;
      Internal?: boolean;
      Labels?: Record<string, string>;
      Config?: { Labels?: Record<string, string> };
    }>;
    const item = records?.length === 1 ? records[0] : undefined;
    const labels = kind === "container" ? item?.Config?.Labels : item?.Labels;
    if (
      !allocationId ||
      !item ||
      !/^[a-f0-9]{64}$/.test(item.Id ?? "") ||
      item.Name !== (kind === "container" ? "/" + name : name) ||
      (kind === "network" && item.Internal !== true) ||
      labels?.["com.wovenmatter.enterprise.runtime"] !== "true" ||
      labels?.["com.wovenmatter.enterprise.run"] !== runId ||
      labels?.["com.wovenmatter.enterprise.allocation"] !== allocationId
    )
      throw new RuntimeError(
        "resource_ownership",
        "Runtime cleanup cannot verify resource allocation ownership",
      );
    return item.Id;
  }
  private async stopContainer(
    runId: string,
    allocationId?: string,
  ): Promise<void> {
    const id = await this.ownedResource("container", runId, allocationId);
    if (!id) return;
    try {
      await exec(this.options.dockerBinary ?? "docker", ["rm", "--force", id], {
        timeout: 15000,
        maxBuffer: MAX_LINE,
      });
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      if (
        failure.code === 1 &&
        failure.stderr?.includes("No such container: " + id)
      )
        return;
      throw error;
    }
  }
  async cancel(runId: string): Promise<void> {
    identity(runId);
    this.active.get(runId)?.abort();
    let allocationId = this.allocations.get(runId);
    if (!allocationId) {
      let receipt: Journal;
      try {
        receipt = JSON.parse(
          await readFile(
            join(this.options.journalRoot, runId + ".json"),
            "utf8",
          ),
        ) as Journal;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // No in-memory entry or receipt is not proof that a container stopped.
        // Without ownership, only a definite Docker not-found can acknowledge it.
        await this.stopContainer(runId);
        return;
      }
      if (
        !receipt ||
        receipt.runId !== runId ||
        ![
          "dispatching",
          "completed",
          "cancelled",
          "failed",
          "interrupted",
        ].includes(receipt.status)
      )
        throw new RuntimeError(
          "resource_ownership",
          "Runtime cancellation cannot verify its durable receipt",
        );
      if (receipt.status !== "dispatching") {
        // Finalized receipts should have no resources left. Do not use one to
        // authorize deletion of a later same-name container.
        await this.stopContainer(runId);
        return;
      }
      if (
        typeof receipt.allocationId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          receipt.allocationId,
        )
      )
        throw new RuntimeError(
          "resource_ownership",
          "Runtime cancellation cannot verify its allocation ownership",
        );
      allocationId = receipt.allocationId;
    }
    await this.stopContainer(runId, allocationId);
  }
  private async removeNetwork(
    runId: string,
    allocationId?: string,
  ): Promise<void> {
    const id = await this.ownedResource("network", runId, allocationId);
    if (!id) return;
    try {
      await exec(
        this.options.dockerBinary ?? "docker",
        ["network", "disconnect", "--force", id, this.options.gatewayContainer],
        { timeout: 15000, maxBuffer: MAX_LINE },
      );
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      if (
        failure.code !== 1 ||
        (!failure.stderr?.includes("not found") &&
          !failure.stderr?.includes("is not connected"))
      )
        throw error;
    }
    try {
      await exec(this.options.dockerBinary ?? "docker", ["network", "rm", id], {
        timeout: 15000,
        maxBuffer: MAX_LINE,
      });
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      if (failure.code !== 1 || !failure.stderr?.includes("not found"))
        throw error;
    }
  }
  async recover(): Promise<string[]> {
    if (this.active.size)
      throw new RuntimeError(
        "runtime_active",
        "Recovery must run before accepting work",
      );
    await mkdir(this.options.journalRoot, { recursive: true, mode: 0o700 });
    const recovered: string[] = [];
    for (const name of await readdir(this.options.journalRoot)) {
      if (!name.endsWith(".json")) continue;
      const receipt = JSON.parse(
        await readFile(join(this.options.journalRoot, name), "utf8"),
      ) as Journal;
      identity(receipt.runId);
      if (receipt.status !== "dispatching") continue;
      // Stop an uncertain execution before releasing its durable conversation lease.
      await this.stopContainer(receipt.runId, receipt.allocationId);
      await this.removeNetwork(receipt.runId, receipt.allocationId);
      await this.journal({
        ...receipt,
        status: "interrupted",
        updatedAt: new Date().toISOString(),
      });
      recovered.push(receipt.runId);
    }
    return recovered;
  }
}
