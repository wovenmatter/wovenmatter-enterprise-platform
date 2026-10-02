import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import type {
  Runtime,
  RuntimeRequest,
  EventSink,
} from "../packages/runtime/src/types.ts";
import type { ProxyEndpoint } from "./provisioning.ts";
import { StringDecoder } from "node:string_decoder";
import { request as httpsRequest } from "node:https";
import { validateEvent } from "../packages/runtime/src/validation.js";
import { RuntimeError } from "../packages/runtime/src/types.js";
import { validateNetworkBoundary } from "./network-boundary.js";
export interface SupervisorClientOptions {
  socketPath?: string;
  origin?: string;
  caFile?: string;
  certFile?: string;
  keyFile?: string;
  hostId?: string;
  tokenFile: string;
}
/** Used only inside the trusted API process. Secrets never leave this transport boundary. */
export function createSupervisorClient(options: SupervisorClientOptions) {
  if (Boolean(options.socketPath) === Boolean(options.origin))
    throw new Error("Choose exactly one supervisor transport");
  async function send(
    path: string,
    method = "GET",
    body?: string | Uint8Array,
    extraHeaders: Record<string, string> = {},
    signal?: AbortSignal,
  ) {
    const token = (await readFile(options.tokenFile, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(token))
      throw new Error("Invalid supervisor credential file");
    const tls = options.origin
      ? await (async () => {
          const origin = new URL(options.origin!);
          if (
            origin.protocol !== "https:" ||
            origin.pathname !== "/" ||
            origin.username ||
            origin.password ||
            origin.search ||
            origin.hash ||
            !options.caFile ||
            !options.certFile ||
            !options.keyFile
          )
            throw new Error(
              "Remote supervisors require a TLS origin and pinned CA/client credentials",
            );
          const [ca, cert, key] = await Promise.all(
            [options.caFile, options.certFile, options.keyFile].map((file) =>
              readFile(file!),
            ),
          );
          return {
            hostname: origin.hostname,
            port: origin.port || 443,
            ca,
            cert,
            key,
            rejectUnauthorized: true,
          };
        })()
      : {};
    return new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        const request = (options.origin ? httpsRequest : httpRequest)(
          {
            ...tls,
            socketPath: options.socketPath,
            path,
            method,
            signal,
            headers: {
              ...extraHeaders,
              authorization: `Bearer ${token}`,
              "x-wme-host": options.hostId ?? "local",
              ...(body === undefined
                ? {}
                : {
                    "content-length": Buffer.byteLength(body),
                  }),
            },
          },
          resolve,
        );
        request.once("error", () =>
          reject(new Error("Runtime supervisor is unavailable")),
        );
        request.setTimeout(35 * 60_000, () =>
          request.destroy(new Error("Supervisor request timed out")),
        );
        request.end(body);
      },
    );
  }
  async function json<T>(
    path: string,
    method = "GET",
    body?: unknown,
    timeoutMs = 120_000,
  ): Promise<T> {
    const response = await send(
      path,
      method,
      body === undefined ? undefined : JSON.stringify(body),
      {
        "content-type": "application/json",
      },
      AbortSignal.timeout(timeoutMs),
    );
    let content = "";
    for await (const chunk of response) {
      content += chunk;
      if (Buffer.byteLength(content) > 1024 * 1024) {
        response.destroy();
        throw new Error("Supervisor response exceeds limit");
      }
    }
    if (response.statusCode !== 200) {
      let code = "supervisor_failed";
      try {
        code = JSON.parse(content).error ?? code;
      } catch {}
      throw new RuntimeError(
        code,
        `Supervisor operation failed (${response.statusCode})`,
      );
    }
    return JSON.parse(content) as T;
  }
  async function stream(
    path: string,
    input: unknown,
    emit: EventSink,
    signal?: AbortSignal,
  ) {
    const response = await send(
      path,
      "POST",
      JSON.stringify(input),
      { "content-type": "application/json" },
      signal,
    );
    if (response.statusCode !== 200) {
      let value = "";
      for await (const chunk of response) {
        value += chunk;
        if (value.length > 4096) {
          response.destroy();
          break;
        }
      }
      let code = "runtime_disconnected";
      try {
        code = JSON.parse(value).error ?? code;
      } catch {}
      throw new RuntimeError(code, "Runtime attachment was rejected.");
    }
    let pending = "",
      terminal = false;
    const decoder = new StringDecoder("utf8");
    for await (const chunk of response) {
      pending += decoder.write(chunk);
      let boundary: number;
      while ((boundary = pending.indexOf("\n")) >= 0) {
        if (boundary > 1024 * 1024) {
          response.destroy();
          throw new Error("Runtime event exceeds limit");
        }
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (!line) continue;
        if (terminal)
          throw new Error("Runtime emitted an event after completion");
        const event = validateEvent(JSON.parse(line));
        terminal =
          ["completed", "cancelled", "failed"].includes(event.type) ||
          (event.type === "attached" && event.terminal === true);
        await emit(event);
      }
      if (Buffer.byteLength(pending) > 1024 * 1024) {
        response.destroy();
        throw new Error("Runtime event exceeds limit");
      }
    }
    if (pending || decoder.end() || !terminal)
      throw new Error(
        "Runtime disconnected; execution was not automatically replayed",
      );
  }
  const runtime: Runtime = {
    async updateProject(spec) {
      await json(
        `/v1/projects/${encodeURIComponent(spec.projectId)}/update`,
        "POST",
        spec,
      );
    },
    async ensureProject(spec) {
      await json(
        `/v1/projects/${encodeURIComponent(spec.projectId)}/ensure`,
        "POST",
        spec,
      );
    },
    async stopProject(spec) {
      await json(
        `/v1/projects/${encodeURIComponent(spec.projectId)}/stop`,
        "POST",
        spec,
      );
    },
    async restoreProject(spec) {
      await json(
        `/v1/projects/${encodeURIComponent(spec.projectId)}/restore`,
        "POST",
        spec,
      );
    },
    async purgeProject(spec) {
      await json(
        `/v1/projects/${encodeURIComponent(spec.projectId)}/purge`,
        "POST",
        spec,
      );
    },
    async steer(id, input) {
      await json(
        `/v1/runs/${encodeURIComponent(id)}/steer`,
        "POST",
        input,
        40000,
      );
    },
    async execute(
      request: RuntimeRequest,
      emit: EventSink,
      signal?: AbortSignal,
    ) {
      return stream("/v1/runs", request, emit, signal);
    },
    async attach(id, after, emit, signal) {
      return stream(
        `/v1/runs/${encodeURIComponent(id)}/attach`,
        { after },
        emit,
        signal,
      );
    },
    async acknowledge(id, cursor) {
      await json(`/v1/runs/${encodeURIComponent(id)}/acknowledge`, "POST", {
        cursor,
      });
    },
    async stopSession(projectId, conversationId, generation) {
      await json(
        `/v1/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(conversationId)}/stop`,
        "POST",
        { generation },
      );
    },
    async cancel(id: string) {
      await json(`/v1/runs/${encodeURIComponent(id)}`, "DELETE");
    },
    async recover() {
      return (
        await json<{
          runIds: string[];
        }>("/v1/recovery")
      ).runIds;
    },
  };
  const registry = {
    async resolve(id: string): Promise<ProxyEndpoint | undefined> {
      return (
        await json<{
          endpoint?: ProxyEndpoint;
        }>(`/v1/organizations/${encodeURIComponent(id)}`)
      ).endpoint;
    },
    async ensure(id: string): Promise<ProxyEndpoint> {
      return (
        await json<{
          endpoint: ProxyEndpoint;
        }>(`/v1/organizations/${encodeURIComponent(id)}`, "PUT")
      ).endpoint;
    },
  };
  async function health(): Promise<void> {
    const result = await json<{
      ready?: boolean;
    }>("/healthz", "GET", undefined, 5_000);
    if (result.ready !== true)
      throw new Error("Runtime supervisor is not ready");
  }
  async function networkBoundary() {
    return validateNetworkBoundary(
      await json<unknown>("/v1/network-boundary", "GET", undefined, 5_000),
    );
  }
  return {
    runtime,
    registry,
    health,
    networkBoundary,
    storageProbe: (id: string) =>
      json<{
        digest: string;
      }>(`/v1/storage-probe/${id}`, "GET", undefined, 5000),
  };
}
