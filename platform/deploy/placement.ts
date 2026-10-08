import { randomBytes, randomUUID, createHash } from "node:crypto";
import { openDirectory } from "../packages/runtime/src/sandbox.js";
import { readFile, open, unlink, realpath } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import {
  createSupervisorClient,
  type SupervisorClientOptions,
} from "./client.js";
import { identity, isWithin } from "../packages/runtime/src/validation.js";
import {
  RuntimeError,
  type Runtime,
  type ProjectRuntimeSpec,
} from "../packages/runtime/src/types.js";
export interface ConfiguredHost extends SupervisorClientOptions {
  id: string;
  name: string;
  /** Explicit shared-storage mapping; no automatic copies or relocation. */
  apiStateRoot: string;
  supervisorStateRoot: string;
}
export async function readHosts(
  file: string,
  apiStateRoot?: string,
): Promise<ConfiguredHost[]> {
  const values = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(values) || !values.length || values.length > 64)
    throw new Error("Configure 1–64 workspace hosts");
  const ids = new Set<string>();
  const sharedRoot = resolve(apiStateRoot ?? values[0]?.apiStateRoot ?? ".");
  return values.map((value) => {
    identity(value.id);
    if (ids.has(value.id)) throw new Error("Duplicate host ID");
    ids.add(value.id);
    if (
      typeof value.name !== "string" ||
      value.name.length > 100 ||
      !value.apiStateRoot ||
      !value.supervisorStateRoot
    )
      throw new Error("Host label and explicit storage roots are required");
    if (resolve(value.apiStateRoot) !== sharedRoot)
      throw new Error(
        "All hosts must use the application state root through explicitly shared storage; independent API roots are unsupported",
      );
    if (!value.socketPath && value.storageMode !== "shared")
      throw new Error(
        "Remote file access requires an explicitly mounted shared storage root; configure and verify it before selecting this host",
      );
    return {
      ...value,
      hostId: value.id,
      apiStateRoot: resolve(value.apiStateRoot),
      supervisorStateRoot: resolve(value.supervisorStateRoot),
    };
  });
}
/** Placement lookup is from the authoritative project row, never browser input. */
export function placedRuntime(
  hosts: ConfiguredHost[],
  lookup: (projectId: string) => Promise<ProjectRuntimeSpec>,
  runProject: (runId: string) => Promise<string | undefined>,
) {
  if (new Set(hosts.map((h) => resolve(h.apiStateRoot))).size !== 1)
    throw new Error("All hosts must share one API state root");
  const clients = new Map(
    hosts.map((host) => [
      host.id,
      {
        host,
        client: createSupervisorClient(host),
      },
    ]),
  );
  async function verifyStorage(
    host: ConfiguredHost,
    client: ReturnType<typeof createSupervisorClient>,
  ) {
    if ((await realpath(host.apiStateRoot)) !== host.apiStateRoot)
      throw new RuntimeError(
        "storage_scope",
        "Configured shared storage root is not canonical.",
      );
    const parent = await openDirectory(host.apiStateRoot, ".host-probes", true),
      id = randomUUID(),
      file = `/proc/self/fd/${parent.fd}/${id}`,
      token = randomBytes(32).toString("hex");
    try {
      const fd = await open(file, "wx", 0o600);
      try {
        await fd.writeFile(token);
        await fd.sync();
      } finally {
        await fd.close();
      }
      const result = await client.storageProbe(id);
      if (result.digest !== createHash("sha256").update(token).digest("hex"))
        throw new RuntimeError(
          "storage_unverified",
          "Supervisor does not see the current shared storage.",
        );
    } finally {
      await unlink(file).catch(() => {});
      await parent.close();
    }
  }
  function target(spec: ProjectRuntimeSpec) {
    const value = clients.get(spec.hostId);
    if (!value)
      throw new RuntimeError(
        "host_unavailable",
        "The assigned workspace host is unavailable.",
      );
    return value;
  }
  function policy(spec: ProjectRuntimeSpec, host: ConfiguredHost) {
    return {
      ...spec,
      ...(spec.scheduleMounts
        ? {
            scheduleMounts: spec.scheduleMounts.map((m) => {
              if (!isWithin(host.apiStateRoot, m.source))
                throw new RuntimeError(
                  "storage_scope",
                  "Schedule storage is outside the shared root.",
                );
              return {
                ...m,
                source: join(
                  host.supervisorStateRoot,
                  relative(host.apiStateRoot, m.source),
                ),
              };
            }),
          }
        : {}),
    };
  }
  const runtime: Runtime = {
    async releaseAsset(spec) {
      await target(spec).client.runtime.releaseAsset!(spec);
    },
    async updateProject(spec) {
      const { host, client } = target(spec);
      await client.runtime.updateProject!(policy(spec, host));
    },
    async ensureProject(spec) {
      const { host, client } = target(spec);
      await verifyStorage(host, client);
      await client.runtime.ensureProject!(policy(spec, host));
    },
    async stopProject(spec) {
      await target(spec).client.runtime.stopProject!(spec);
    },
    async restoreProject(spec) {
      const { host, client } = target(spec);
      await verifyStorage(host, client);
      await client.runtime.restoreProject!(policy(spec, host));
    },
    async purgeProject(spec) {
      await target(spec).client.runtime.purgeProject!(spec);
    },
    async execute(request, emit, signal) {
      const spec = await lookup(request.projectId),
        { host, client } = target(spec);
      await verifyStorage(host, client);
      if (spec.organizationId !== request.organizationId)
        throw new RuntimeError(
          "placement_conflict",
          "Run organization does not match its project.",
        );
      const translate = (path: string) => {
        if (!isWithin(host.apiStateRoot, path))
          throw new RuntimeError(
            "storage_scope",
            "Runtime storage is outside the assigned host's configured root.",
          );
        return join(
          host.supervisorStateRoot,
          relative(host.apiStateRoot, path),
        );
      };
      return client.runtime.execute(
        {
          ...request,
          mounts: request.mounts.map((m) => ({
            ...m,
            source: translate(m.source),
          })),
          sessionDirectory: translate(request.sessionDirectory),
        },
        emit,
        signal,
      );
    },
    async attach(id, after, emit, signal) {
      const project = await runProject(id);
      if (!project) throw new RuntimeError("run_missing", "Run not found.");
      return target(await lookup(project)).client.runtime.attach!(
        id,
        after,
        emit,
        signal,
      );
    },
    async stopSession(projectId, conversationId, generation) {
      return target(await lookup(projectId)).client.runtime.stopSession!(
        projectId,
        conversationId,
        generation,
      );
    },
    async acknowledge(id, cursor) {
      const project = await runProject(id);
      if (!project) throw new RuntimeError("run_missing", "Run not found.");
      return target(await lookup(project)).client.runtime.acknowledge!(
        id,
        cursor,
      );
    },
    async steer(id, input) {
      const project = await runProject(id);
      if (!project) throw new RuntimeError("run_ended", "Run not found.");
      await target(await lookup(project)).client.runtime.steer!(id, input);
    },
    async cancel(id) {
      const project = await runProject(id);
      if (project)
        await target(await lookup(project)).client.runtime.cancel(id);
    },
    async recover() {
      return (
        await Promise.all(
          [...clients.values()].map((c) => c.client.runtime.recover()),
        )
      ).flat();
    },
  };
  return {
    runtime,
    async health() {
      await Promise.all(
        [...clients.values()].map(async (c) => {
          await c.client.health();
          await verifyStorage(c.host, c.client);
        }),
      );
    },
  };
}
