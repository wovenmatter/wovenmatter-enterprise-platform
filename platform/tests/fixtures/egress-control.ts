import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import {
  createRuntimeEgress,
  type NetworkBoundary,
} from "../../apps/api/src/runtime-egress.js";
import type {
  Runtime,
  RuntimeRequest,
} from "../../packages/runtime/src/types.js";

/** Isolated acceptance fixture: real queue, memberships, SQLite and run capabilities;
 * only model availability and the provider-less holding runtime are synthetic. */
export async function createEgressControlFixture(options: {
  networkBoundary(): Promise<NetworkBoundary>;
  host?: string;
  port?: number;
}) {
  const stateDir = await mkdtemp(join(tmpdir(), "wme-egress-control-"));
  let system: Awaited<ReturnType<typeof buildApp>> | undefined;
  let network: Awaited<ReturnType<typeof createRuntimeEgress>> | undefined;
  let stopped: Promise<void> | undefined;
  const held = new Map<string, () => void>();
  let dispatched!: (request: RuntimeRequest) => void;
  const running = new Promise<RuntimeRequest>((resolve) => {
    dispatched = resolve;
  });
  const runtime: Runtime = {
    async execute(request, emit, signal) {
      let release!: () => void;
      const stop = new Promise<void>((resolve) => {
        release = resolve;
      });
      held.set(request.runId, release);
      signal?.addEventListener("abort", release, { once: true });
      try {
        await emit({ type: "started" });
        dispatched(request);
        if (signal?.aborted) release();
        await stop;
        await emit({ type: "cancelled" });
      } finally {
        signal?.removeEventListener("abort", release);
        held.delete(request.runId);
      }
    },
    async cancel(id) {
      held.get(id)?.();
    },
    async recover() {
      return [];
    },
  };
  function close(): Promise<void> {
    return (stopped ??= (async () => {
      await network?.close();
      try {
        await system?.app.close();
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    })());
  }
  try {
    network = await createRuntimeEgress({
      runtime,
      proxyOrigin: "http://api:4101",
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      networkBoundary: options.networkBoundary,
      authorize: (projectId, token) => {
        if (!system) return Promise.reject(new Error("Fixture is not ready"));
        return system.inference.authorizeGateway(projectId, token);
      },
    });
    system = await buildApp(
      {
        stateDir,
        publicOrigin: "http://portal.test",
        host: "127.0.0.1",
        port: 4100,
        secureCookies: false,
        contentOriginTemplate: "http://{assetId}.assets.test",
      },
      {
        jobs: false,
        startConversations: false,
        runtime: network.runtime,
        webRoot: join(stateDir, "absent"),
        registry: {
          resolve: async () => ({
            baseUrl: "http://proxy.invalid",
            managementKey: "synthetic-management",
            clientKey: "synthetic-client",
          }),
        },
      },
    );
    // The fixture never requests a model catalog or inference from an actual provider.
    system.inference.validateSelection = async (_org, model, harness) => {
      if (model !== "fixture" || harness !== "codex")
        throw new Error("Unexpected fixture model");
    };
    const { port } = await network.start();
    await system.conversations.start();
    const org = randomUUID(),
      user = randomUUID(),
      project = randomUUID(),
      now = new Date().toISOString();
    await system.ctx.db.batch([
      {
        sql: "INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)",
        params: [org, "Synthetic network acceptance", now],
      },
      {
        sql: "INSERT INTO users(id,org_id,email,name,role,enabled,created_at) VALUES(?,?,?,'Synthetic employee','member',1,?)",
        params: [user, org, `${user}@acceptance.invalid`, now],
      },
      {
        sql: "INSERT INTO projects(id,org_id,name,status,access,created_at) VALUES(?,?,'Synthetic network probe','ready','read',?)",
        params: [project, org, now],
      },
      {
        sql: "INSERT INTO project_members VALUES(?,?,?,?)",
        params: [project, user, "read", now],
      },
    ]);
    const actor = await system.conversations.user(user);
    const conversation = await system.conversations.create(actor, project, {
      title: "Synthetic public GET acceptance",
      mode: "read",
      harness: "codex",
      model: "fixture",
    });
    const admitted = await system.conversations.admit(actor, conversation.id, {
      content: "Synthetic GET-only network acceptance; no customer content",
      requestId: randomUUID(),
    });
    let timer: NodeJS.Timeout | undefined;
    let request: RuntimeRequest;
    try {
      request = await Promise.race([
        running,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Synthetic run did not dispatch")),
            5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (request.runId !== admitted.run.id)
      throw new Error("Unexpected synthetic run");
    const ready = {
      org,
      user,
      project,
      conversation: conversation.id,
      run: request.runId,
      token: request.gateway.token,
      boundary: await options.networkBoundary(),
      port,
    };
    return {
      ready,
      system,
      close,
      async revoke() {
        await system!.inference.revokeGateway(request.runId);
        await system!.conversations.cancel(
          actor,
          conversation.id,
          request.runId,
        );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
