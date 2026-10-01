import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  readdir,
  open,
  rename,
  realpath,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  RuntimeError,
  type Runtime,
  type RuntimeRequest,
  type EventSink,
  type SteeringInput,
  type ProjectRuntimeSpec,
} from "./types.js";
import {
  identity,
  validateHostRequest,
  validateEvent,
  MAX_LINE,
  isWithin,
} from "./validation.js";
import { ensureStorageVolumes, volumeMount } from "./volumes.js";
import { createIsolatedNetwork, validateNetworkPool } from "./networks.js";
import type { DockerRuntimeOptions } from "./docker.js";
const exec = promisify(execFile);
type Placement = ProjectRuntimeSpec & {
  allocationId: string;
  network: string;
  status: "ready" | "deleted" | "purged";
};
type Receipt = {
  runId: string;
  projectId: string;
  organizationId: string;
  status: "active" | "finished";
  conversationId?: string;
  fingerprint?: string;
};
/** Persistent project container. Dispatch only starts a namespaced process inside it. */
export class ProjectDockerRuntime implements Runtime {
  private attachments = new Map<string, string>();
  private projectLanes = new Map<string, Promise<unknown>>();
  constructor(private options: DockerRuntimeOptions) {
    validateNetworkPool(options.networkPool);
  }
  private command(args: string[], timeout = 30000) {
    return exec(this.options.dockerBinary ?? "docker", args, {
      timeout,
      maxBuffer: MAX_LINE,
      encoding: "utf8",
    });
  }
  private async save(path: string, value: unknown) {
    await mkdir(join(path, ".."), {
      recursive: true,
      mode: 0o700,
    });
    const temp = path + "." + randomUUID() + ".tmp";
    const f = await open(temp, "wx", 0o600);
    try {
      await f.writeFile(JSON.stringify(value));
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(temp, path);
    const d = await open(join(path, ".."), "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  }
  private placementFile(id: string) {
    return join(
      this.options.journalRoot,
      "projects",
      identity(id),
      "definition.json",
    );
  }
  private async placement(id: string) {
    return JSON.parse(
      await readFile(this.placementFile(id), "utf8"),
    ) as Placement;
  }
  private async inspect(p: Placement) {
    const name = "wme-project-" + identity(p.projectId);
    try {
      const data = JSON.parse(
        (await this.command(["container", "inspect", name])).stdout,
      )[0];
      if (
        data?.Config?.Labels?.["com.wovenmatter.enterprise.allocation"] !==
          p.allocationId ||
        data?.Config?.Labels?.["com.wovenmatter.enterprise.project"] !==
          p.projectId ||
        data?.Config?.Labels?.["com.wovenmatter.enterprise.organization"] !==
          p.organizationId
      )
        throw new RuntimeError(
          "resource_ownership",
          "Project container ownership cannot be verified.",
        );
      return data;
    } catch (e) {
      if (
        (
          e as {
            code?: number;
            stderr?: string;
          }
        ).code === 1 &&
        (
          e as {
            stderr?: string;
          }
        ).stderr?.includes("No such")
      )
        return undefined;
      throw e;
    }
  }
  private lane<T>(id: string, work: () => Promise<T>) {
    identity(id);
    const result = (this.projectLanes.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    this.projectLanes.set(id, result);
    void result
      .finally(() => {
        if (this.projectLanes.get(id) === result) this.projectLanes.delete(id);
      })
      .catch(() => {});
    return result;
  }
  private fresh(
    spec: ProjectRuntimeSpec,
    status: Placement["status"],
  ): Placement {
    this.validateSpec(spec);
    return {
      ...spec,
      allocationId: randomUUID(),
      network:
        this.options.network.slice(0, 24) +
        "-" +
        createHash("sha256").update(spec.projectId).digest("hex").slice(0, 24),
      status,
    };
  }
  private validateSpec(spec: ProjectRuntimeSpec) {
    identity(spec.projectId);
    identity(spec.organizationId);
    identity(spec.hostId);
    if (spec.egressProxyUrl || spec.egressToken) {
      if (
        !spec.egressProxyUrl ||
        !/^wme_schedule_[a-zA-Z0-9_-]{43}$/.test(spec.egressToken ?? "") ||
        !this.options.egressProxyOrigins?.includes(
          new URL(spec.egressProxyUrl).origin,
        ) ||
        new URL(spec.egressProxyUrl).origin !== spec.egressProxyUrl
      )
        throw new RuntimeError(
          "invalid_gateway",
          "Scheduled network capability is invalid.",
        );
    }
    if (spec.hostId !== (this.options.hostId ?? "local"))
      throw new RuntimeError(
        "wrong_host",
        "Project placement belongs to a different supervisor.",
      );
  }
  private async placed(spec: ProjectRuntimeSpec) {
    this.validateSpec(spec);
    try {
      const p = await this.placement(spec.projectId);
      if (
        p.projectId !== spec.projectId ||
        p.organizationId !== spec.organizationId ||
        p.hostId !== spec.hostId
      )
        throw new RuntimeError(
          "placement_conflict",
          "Stored projects cannot move implicitly.",
        );
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return undefined;
    }
  }
  private async writePolicy(p: Placement) {
    const library = join(
        this.options.storageRoots[0],
        "organizations",
        p.organizationId,
        "files",
      ),
      mounts = [];
    if (
      p.scheduleMounts !== undefined &&
      (!Array.isArray(p.scheduleMounts) || p.scheduleMounts.length > 500)
    )
      throw new RuntimeError(
        "invalid_mount",
        "Invalid scheduled share policy.",
      );
    for (const m of p.scheduleMounts ?? []) {
      if (
        !m ||
        typeof m.source !== "string" ||
        typeof m.target !== "string" ||
        !/^\/workspace\/[^/\\]+$/.test(m.target) ||
        !["read", "write"].includes(m.access) ||
        !isWithin(library, m.source) ||
        resolve(m.source) !== m.source ||
        (await realpath(m.source)) !== m.source
      )
        throw new RuntimeError(
          "invalid_mount",
          "Schedule share belongs to a different scope.",
        );
      mounts.push({
        ...m,
        source: "/library/" + relative(library, m.source),
      });
    }
    await this.save(
      join(
        this.options.journalRoot,
        "projects",
        p.projectId,
        "schedule-policy.json",
      ),
      {
        enabled: p.scheduleEnabled === true,
        mounts,
      },
    );
  }
  updateProject(spec: ProjectRuntimeSpec) {
    return this.lane(spec.projectId, async () => {
      const p = await this.placed(spec);
      if (!p || p.status !== "ready") return;
      const next = {
        ...p,
        scheduleEnabled: spec.scheduleEnabled,
        scheduleMounts: spec.scheduleMounts,
      };
      await this.writePolicy(next);
      await this.save(this.placementFile(p.projectId), next);
      const c = await this.inspect(p);
      if (c?.State.Running) {
        const result = await this.send(p.projectId, {
          operation: "policy",
        });
        if (result.ok !== true)
          throw new RuntimeError(
            "stop_not_confirmed",
            "Schedule policy was not acknowledged.",
          );
      }
    });
  }
  ensureProject(spec: ProjectRuntimeSpec) {
    return this.lane(spec.projectId, () => this.provision(spec));
  }
  private async ready(projectId: string) {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        if (
          (
            await this.send(projectId, {
              operation: "status",
            })
          ).ready === true
        )
          return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new RuntimeError(
      "project_initializing",
      "Project supervisor did not become ready.",
    );
  }
  private async provision(spec: ProjectRuntimeSpec) {
    let p = await this.placed(spec);
    if (p && p.status !== "ready")
      throw new RuntimeError(
        "project_deleted",
        "Restore the project before starting its runtime.",
      );
    if (!p) {
      p = this.fresh(spec, "ready");
      await this.save(this.placementFile(spec.projectId), p);
    }
    if (spec.egressToken && p.egressToken !== spec.egressToken) {
      p = {
        ...p,
        egressToken: spec.egressToken,
        egressProxyUrl: spec.egressProxyUrl,
      };
      await this.save(this.placementFile(spec.projectId), p);
    }
    if (
      spec.scheduleMounts !== undefined ||
      spec.scheduleEnabled !== undefined
    ) {
      p = {
        ...p,
        scheduleMounts: spec.scheduleMounts,
        scheduleEnabled: spec.scheduleEnabled,
      };
      await this.save(this.placementFile(p.projectId), p);
    }
    await this.writePolicy(p);
    const existing = await this.inspect(p);
    if (existing) {
      if (existing.Config.Image !== this.options.image)
        throw new RuntimeError(
          "runtime_upgrade_required",
          "The stored project uses a different runtime image. Complete the operator's backed-up runtime update before resuming it.",
        );
      if (!existing.State.Running) await this.command(["start", existing.Id]);
      await this.ready(spec.projectId);
      await this.send(spec.projectId, {
        operation: "policy",
      });
      return;
    }
    const root = this.options.storageRoots[0],
      project = join(root, "projects", spec.projectId),
      library = join(root, "organizations", spec.organizationId, "files"),
      sessions = join(
        this.options.sessionRoot,
        spec.organizationId,
        spec.projectId,
      );
    for (const path of [join(project, "files"), library, sessions])
      await mkdir(path, {
        recursive: true,
        mode: 0o750,
      });
    const journal = join(this.options.journalRoot, "projects", spec.projectId);
    const roots = [root, this.options.sessionRoot, this.options.journalRoot];
    await ensureStorageVolumes(roots, (args) => this.command(args));
    const networkName = p.network;
    const listed = await this.command([
      "network",
      "ls",
      "--filter",
      `name=^${networkName}$`,
      "--format",
      "{{.ID}}",
    ]);
    if (!listed.stdout.trim())
      await createIsolatedNetwork(
        {
          name: networkName,
          pool: this.options.networkPool,
          bridgeName: `br-wmerun${createHash("sha256").update(p.projectId).digest("hex").slice(0, 6)}`,
          labels: {
            "com.wovenmatter.enterprise.project": p.projectId,
            "com.wovenmatter.enterprise.allocation": p.allocationId,
          },
        },
        (args) => this.command(args),
      );
    const network = JSON.parse(
      (await this.command(["network", "inspect", networkName])).stdout,
    )[0];
    if (
      !network?.Internal ||
      network.Labels?.["com.wovenmatter.enterprise.allocation"] !==
        p.allocationId
    )
      throw new RuntimeError(
        "resource_ownership",
        "Project network ownership cannot be verified.",
      );
    if (
      !Object.values(network.Containers ?? {}).some(
        (c: any) => c.Name === this.options.gatewayContainer,
      )
    )
      await this.command([
        "network",
        "connect",
        "--alias",
        new URL(this.options.gatewayOrigins[0]).hostname,
        networkName,
        this.options.gatewayContainer,
      ]);
    const args = [
      "create",
      "--name",
      "wme-project-" + spec.projectId,
      "--restart",
      "unless-stopped",
      "--label",
      "com.wovenmatter.enterprise.project=" + spec.projectId,
      "--label",
      "com.wovenmatter.enterprise.organization=" + spec.organizationId,
      "--label",
      "com.wovenmatter.enterprise.allocation=" + p.allocationId,
      "--read-only",
      "--user",
      "0:0",
      "--init",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SYS_ADMIN",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "SYS_CHROOT",
      "--security-opt",
      "no-new-privileges:true",
      "--security-opt",
      "apparmor=" +
        (this.options.supervisorAppArmorProfile ?? "wme-project-supervisor"),
      "--security-opt",
      "seccomp=unconfined",
      "--security-opt",
      "systempaths=unconfined",
      "--pids-limit",
      "1024",
      "--memory",
      "4g",
      "--cpus",
      "4",
      "--network",
      networkName,
      "--ipc",
      "private",
      "--log-driver",
      "none",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
      "--mount",
      volumeMount(project, "/project", roots, false),
      "--mount",
      volumeMount(library, "/library", roots, false),
      "--mount",
      volumeMount(sessions, "/state", roots, false),
      "--mount",
      volumeMount(journal, "/control", roots, false),
      "--entrypoint",
      "node",
      this.options.image,
      "/opt/runtime/src/project-daemon.js",
    ];
    await this.command(args);
    await this.command(["start", "wme-project-" + spec.projectId]);
    await this.ready(spec.projectId);
  }
  stopProject(spec: ProjectRuntimeSpec) {
    return this.lane(spec.projectId, async () => {
      const p = (await this.placed(spec)) ?? this.fresh(spec, "deleted");
      if (p.status !== "purged")
        await this.save(this.placementFile(p.projectId), {
          ...p,
          status: "deleted",
        });
      const c = await this.inspect(p);
      if (c?.State.Running) await this.command(["stop", "--time", "10", c.Id]);
    });
  }
  restoreProject(spec: ProjectRuntimeSpec) {
    return this.lane(spec.projectId, async () => {
      const p = (await this.placed(spec)) ?? this.fresh(spec, "deleted");
      if (p.status === "purged")
        throw new RuntimeError(
          "project_purged",
          "This project's recovery period has ended.",
        );
      await this.save(this.placementFile(p.projectId), {
        ...p,
        status: "ready",
      });
      await this.provision(spec);
    });
  }
  purgeProject(spec: ProjectRuntimeSpec) {
    return this.lane(spec.projectId, async () => {
      const p = await this.placed(spec);
      if (!p) return;
      if (p.status !== "deleted" && p.status !== "purged")
        throw new RuntimeError(
          "purge_denied",
          "Only a stopped deleted project can be purged.",
        );
      const c = await this.inspect(p);
      if (c) await this.command(["rm", "--force", c.Id]);
      let n: any;
      try {
        n = JSON.parse(
          (await this.command(["network", "inspect", p.network])).stdout,
        )[0];
      } catch (e) {
        const error = e as { code?: number; stderr?: string };
        // Docker Engine also uses this exact response after a previous purge
        // removed the network but did not commit the placement tombstone.
        if (!(
          error.code === 1 &&
          (error.stderr?.includes("No such") ||
            error.stderr?.trim() ===
              `Error response from daemon: network ${p.network} not found`)
        ))
          throw e;
      }
      if (n) {
        if (
          n.Labels?.["com.wovenmatter.enterprise.allocation"] !==
            p.allocationId ||
          n.Labels?.["com.wovenmatter.enterprise.project"] !== p.projectId
        )
          throw new RuntimeError(
            "resource_ownership",
            "Project network ownership cannot be verified.",
          );
        for (const [id, c] of Object.entries(n.Containers ?? {}))
          if ((c as any).Name === this.options.gatewayContainer)
            await this.command(["network", "disconnect", n.Id, id]);
        await this.command(["network", "rm", n.Id]);
      }
      await this.save(this.placementFile(p.projectId), {
        ...p,
        status: "purged",
      });
    });
  }
  private async send(projectId: string, envelope: unknown) {
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        this.options.dockerBinary ?? "docker",
        [
          "exec",
          "--interactive",
          "--user",
          "0:0",
          "wme-project-" + identity(projectId),
          "node",
          "/opt/runtime/src/project-client.js",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
          },
        },
      );
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new RuntimeError(
            "supervisor_timeout",
            "Project supervisor did not respond.",
          ),
        );
      }, 45000);
      child.once("close", () => clearTimeout(timeout));
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
        if (output.length > MAX_LINE) child.kill("SIGKILL");
      });
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(output)
          : reject(new Error("Project supervisor unavailable")),
      );
      child.stdin.on("error", reject);
      child.stdin.end(JSON.stringify(envelope) + "\n");
    });
    const value = JSON.parse(result);
    if (value.type === "failed")
      throw new RuntimeError(
        value.code ?? "runtime_boundary",
        "Project service rejected the operation.",
      );
    return value;
  }
  async execute(
    request: RuntimeRequest,
    emit: EventSink,
    signal?: AbortSignal,
  ) {
    await validateHostRequest(
      request,
      this.options.storageRoots,
      this.options.sessionRoot,
    );
    const p = await this.placement(request.projectId);
    if (p.status !== "ready" || p.organizationId !== request.organizationId)
      throw new RuntimeError(
        "project_unavailable",
        "Project runtime is unavailable.",
      );
    if (
      !this.options.gatewayOrigins.includes(
        new URL(request.gateway.baseUrl).origin,
      ) ||
      (request.egressProxyUrl &&
        !this.options.egressProxyOrigins?.includes(
          new URL(request.egressProxyUrl).origin,
        ))
    )
      throw new RuntimeError(
        "invalid_gateway",
        "Runtime transport destination is not allowed.",
      );
    const root = this.options.storageRoots[0],
      expected = join(root, "projects", request.projectId, "files"),
      library = join(root, "organizations", request.organizationId, "files");
    if (
      request.mounts.find((m) => m.target === "/workspace")?.source !== expected
    )
      throw new RuntimeError(
        "invalid_mount",
        "Project workspace identity does not match placement.",
      );
    const expectedSession = join(
      this.options.sessionRoot,
      request.organizationId,
      request.projectId,
      "sessions",
      request.conversationId,
      request.harness,
      request.access,
    );
    if (resolve(request.sessionDirectory) !== expectedSession)
      throw new RuntimeError(
        "invalid_session",
        "Native session belongs to a different thread.",
      );
    const mounts = await Promise.all(
      request.mounts.map(async (m) => {
        if (m.target === "/workspace")
          return {
            ...m,
            source: "/project/files",
          };
        if (
          !isWithin(library, m.source) ||
          (await realpath(m.source)) !== m.source
        )
          throw new RuntimeError(
            "invalid_mount",
            "Share belongs to a different organization.",
          );
        return {
          ...m,
          source: "/library/" + relative(library, m.source),
        };
      }),
    );
    const file = join(
      this.options.journalRoot,
      "runs",
      identity(request.runId) + ".json",
    );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          request.organizationId,
          request.projectId,
          request.conversationId,
          request.harness,
          request.model,
          request.connectionId,
          request.access,
          request.prompt,
          request.resumeId,
          request.generation,
          request.userId,
        ]),
      )
      .digest("hex");
    await this.lane(request.projectId, async () => {
      let prior: Receipt | undefined;
      try {
        prior = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        prior &&
        (prior.projectId !== request.projectId ||
          prior.fingerprint !== fingerprint)
      )
        throw new RuntimeError(
          "request_conflict",
          "This execution identity was already used.",
        );
      if (!prior)
        await this.save(file, {
          runId: request.runId,
          projectId: request.projectId,
          organizationId: request.organizationId,
          conversationId: request.conversationId,
          fingerprint,
          status: "active",
        });
      signal?.throwIfAborted();
      await this.send(request.projectId, {
        operation: "execute",
        request: { ...request, mounts },
      });
    });
    return this.attach(request.runId, 0, emit, signal);
  }
  private async receipt(runId: string): Promise<Receipt> {
    try {
      const receipt = JSON.parse(
        await readFile(
          join(this.options.journalRoot, "runs", identity(runId) + ".json"),
          "utf8",
        ),
      ) as Receipt;
      if (receipt.runId !== runId)
        throw new RuntimeError(
          "receipt_invalid",
          "Execution identity is invalid.",
        );
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new RuntimeError(
          "run_missing",
          "The workspace never acknowledged this run.",
        );
      throw error;
    }
  }
  async attach(
    runId: string,
    after: number,
    emit: EventSink,
    signal?: AbortSignal,
  ) {
    const receipt = await this.receipt(runId);
    const attached = await this.send(receipt.projectId, {
      operation: "attach",
      runId,
    });
    const token = attached.attachment;
    if (typeof token !== "string")
      throw new RuntimeError(
        "attachment_invalid",
        "Workspace attachment is invalid.",
      );
    this.attachments.set(runId, token);
    let cursor = after;
    try {
      await emit({
        type: "attached",
        ...(attached.terminal && after === attached.cursor
          ? { terminal: true }
          : {}),
      });
      while (!signal?.aborted) {
        const batch = await this.send(receipt.projectId, {
          operation: "poll",
          runId,
          after: cursor,
          waitMs: 10000,
        });
        if (!Array.isArray(batch.events))
          throw new RuntimeError(
            "invalid_event",
            "Workspace output is invalid.",
          );
        for (const value of batch.events) {
          signal?.throwIfAborted();
          if (value.sequence !== cursor + 1)
            throw new RuntimeError(
              "invalid_cursor",
              "Workspace event order is invalid.",
            );
          await emit({ ...validateEvent(value), sequence: value.sequence });
          cursor = value.sequence;
        }
        if (batch.terminal) {
          await this.save(
            join(this.options.journalRoot, "runs", runId + ".json"),
            { ...receipt, status: "finished" },
          );
          return;
        }
      }
      signal?.throwIfAborted();
    } finally {
      if (this.attachments.get(runId) === token) this.attachments.delete(runId);
    }
  }
  async steer(runId: string, input: SteeringInput) {
    const receipt = await this.receipt(runId),
      attachment = this.attachments.get(runId);
    if (!attachment)
      throw new RuntimeError(
        "attachment_missing",
        "Reconnect to the active execution before sending input.",
      );
    await this.send(receipt.projectId, {
      operation: "steer",
      runId,
      attachment,
      input,
    });
  }
  async acknowledge(runId: string, cursor: number) {
    const receipt = await this.receipt(runId);
    await this.send(receipt.projectId, {
      operation: "acknowledge",
      runId,
      cursor,
    });
  }
  async stopSession(
    projectId: string,
    conversationId: string,
    generation: number,
  ) {
    const placement = await this.placement(projectId),
      container = await this.inspect(placement);
    // Persisted API generation fences every future admission even when the container is stopped.
    if (container?.State.Running)
      await this.send(projectId, {
        operation: "stop-session",
        conversationId,
        generation,
      });
  }
  async cancel(runId: string) {
    let receipt: Receipt;
    try {
      receipt = await this.receipt(runId);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "run_missing") return;
      throw error;
    }
    const placement = await this.placement(receipt.projectId),
      container = await this.inspect(placement);
    if (container?.State.Running)
      await this.send(receipt.projectId, { operation: "cancel", runId });
  }
  async recover() {
    // Reconcile project availability only. Attached work and idle environments belong to the project service.
    let projects: string[] = [];
    try {
      projects = await readdir(join(this.options.journalRoot, "projects"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const id of projects) {
      const placement = await this.placement(id);
      if (placement.status === "ready") await this.ensureProject(placement);
    }
    return [];
  }
}
