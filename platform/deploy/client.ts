import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type {
  Runtime,
  RuntimeRequest,
  RuntimeEvent,
  EventSink,
} from "../packages/runtime/src/types.ts";
import type { ProxyEndpoint } from "./provisioning.ts";
import type {
  LibraryStart,
  LibraryRuntimeState,
  LibraryRuntimeHost,
} from "../apps/api/src/library/runtime.js";
import { StringDecoder } from "node:string_decoder";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { validateNetworkBoundary } from "./network-boundary.js";

export interface SupervisorClientOptions {
  socketPath: string;
  tokenFile: string;
}
export type LibraryLaunch = LibraryStart;
export type LibraryProcess = LibraryRuntimeState;
/** Used only inside the trusted API process. Secrets never leave this transport boundary. */
export function createSupervisorClient(options: SupervisorClientOptions) {
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
    return new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            socketPath: options.socketPath,
            path,
            method,
            signal,
            headers: {
              ...extraHeaders,
              authorization: `Bearer ${token}`,
              ...(body === undefined
                ? {}
                : { "content-length": Buffer.byteLength(body) }),
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
      { "content-type": "application/json" },
      AbortSignal.timeout(timeoutMs),
    );
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error(`Supervisor operation failed (${response.statusCode})`);
    }
    let content = "";
    for await (const chunk of response) {
      content += chunk;
      if (Buffer.byteLength(content) > 1024 * 1024) {
        response.destroy();
        throw new Error("Supervisor response exceeds limit");
      }
    }
    return JSON.parse(content) as T;
  }
  const runtime: Runtime = {
    async execute(
      request: RuntimeRequest,
      emit: EventSink,
      signal?: AbortSignal,
    ) {
      const response = await send(
        "/v1/runs",
        "POST",
        JSON.stringify(request),
        { "content-type": "application/json" },
        signal,
      );
      if (response.statusCode !== 200) {
        response.destroy();
        throw new Error("Runtime dispatch was rejected");
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
          const event = JSON.parse(line) as RuntimeEvent;
          if (
            !event ||
            ![
              "started",
              "native_session",
              "assistant_delta",
              "tool_start",
              "tool_end",
              "citation",
              "completed",
              "cancelled",
              "failed",
            ].includes(event.type)
          )
            throw new Error("Invalid runtime event");
          terminal = ["completed", "cancelled", "failed"].includes(event.type);
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
    },
    async cancel(id: string) {
      await json(`/v1/runs/${encodeURIComponent(id)}`, "DELETE");
    },
    async recover() {
      return (await json<{ runIds: string[] }>("/v1/recovery")).runIds;
    },
  };
  const registry = {
    async resolve(id: string): Promise<ProxyEndpoint | undefined> {
      return (
        await json<{ endpoint?: ProxyEndpoint }>(
          `/v1/organizations/${encodeURIComponent(id)}`,
        )
      ).endpoint;
    },
    async ensure(id: string): Promise<ProxyEndpoint> {
      return (
        await json<{ endpoint: ProxyEndpoint }>(
          `/v1/organizations/${encodeURIComponent(id)}`,
          "PUT",
        )
      ).endpoint;
    },
  };
  const libraryHost: LibraryRuntimeHost = {
    start: (input: LibraryLaunch) =>
      json<LibraryProcess>("/v1/library/start", "POST", input),
    status: (id: string) =>
      json<LibraryProcess>(`/v1/library/${encodeURIComponent(id)}`),
    resume: (id: string) =>
      json<LibraryProcess>(
        `/v1/library/${encodeURIComponent(id)}/resume`,
        "POST",
      ),
    async stop(id: string) {
      await json(`/v1/library/${encodeURIComponent(id)}`, "DELETE");
    },
    async fetch(
      id: string,
      path: string,
      init: RequestInit = {},
    ): Promise<Response> {
      const original = Object.fromEntries(new Headers(init.headers));
      const body =
        init.body === null || init.body === undefined
          ? undefined
          : typeof init.body === "string" || init.body instanceof Uint8Array
            ? init.body
            : new Uint8Array(await new Response(init.body).arrayBuffer());
      const response = await send(
        `/v1/library/${encodeURIComponent(id)}/http`,
        "POST",
        body,
        {
          "x-wme-method": init.method ?? "GET",
          "x-wme-path": Buffer.from(path).toString("base64url"),
          "x-wme-headers": Buffer.from(JSON.stringify(original)).toString(
            "base64url",
          ),
        },
        init.signal ?? undefined,
      );
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else if (value) headers.set(key, value);
      }
      const status = response.statusCode ?? 502;
      let stream: Readable = response;
      const encoding = response.headers["content-encoding"];
      const decoder =
        encoding === "gzip"
          ? createGunzip()
          : encoding === "deflate"
            ? createInflate()
            : encoding === "br"
              ? createBrotliDecompress()
              : undefined;
      if (decoder) {
        response.on("error", (error) => decoder.destroy(error));
        decoder.on("close", () => response.destroy());
        stream = response.pipe(decoder);
        headers.delete("content-encoding");
        headers.delete("content-length");
      }
      return new Response(
        [204, 205, 304].includes(status) || init.method === "HEAD"
          ? null
          : (Readable.toWeb(stream) as ReadableStream<Uint8Array>),
        { status, headers },
      );
    },
    async upgrade(id, path, headers, downstreamSocket, head) {
      const token = (await readFile(options.tokenFile, "utf8")).trim();
      if (!/^[0-9a-f]{64}$/.test(token))
        throw new Error("Invalid supervisor credential file");
      await new Promise<void>((resolve, reject) => {
        const request = httpRequest({
          socketPath: options.socketPath,
          method: "GET",
          path: `/v1/library/${encodeURIComponent(id)}/ws`,
          headers: {
            authorization: `Bearer ${token}`,
            connection: "Upgrade",
            upgrade: "websocket",
            "x-wme-path": Buffer.from(path).toString("base64url"),
            "x-wme-headers": Buffer.from(JSON.stringify(headers)).toString(
              "base64url",
            ),
          },
        });
        request.once("error", () => {
          downstreamSocket.destroy();
          reject(new Error("Application WebSocket connection failed"));
        });
        request.once("response", (response) => {
          response.destroy();
          downstreamSocket.destroy();
          reject(new Error("Application WebSocket rejected"));
        });
        request.once("upgrade", (response, upstream, upstreamHead) => {
          const lines = [`HTTP/1.1 ${response.statusCode} Switching Protocols`];
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            const name = response.rawHeaders[index]!,
              value = response.rawHeaders[index + 1]!;
            if (name.toLowerCase() === "set-cookie") {
              if (!/^(?:__Host-)?wme[_-]/i.test(value.split("=")[0]!.trim()))
                lines.push(
                  `${name}: ${value.replace(/;\s*Domain=[^;]*/gi, "")}`,
                );
            } else lines.push(`${name}: ${value}`);
          }
          downstreamSocket.write(lines.join("\r\n") + "\r\n\r\n");
          if (upstreamHead.length) downstreamSocket.write(upstreamHead);
          if (head.length) upstream.write(head);
          downstreamSocket.on("error", () => upstream.destroy());
          upstream.on("error", () => downstreamSocket.destroy());
          downstreamSocket.on("close", () => upstream.destroy());
          upstream.on("close", () => downstreamSocket.destroy());
          downstreamSocket.pipe(upstream).pipe(downstreamSocket);
          resolve();
        });
        downstreamSocket.once("close", () => request.destroy());
        request.setTimeout(15_000, () =>
          request.destroy(new Error("WebSocket handshake timed out")),
        );
        request.end();
      });
    },
  };
  async function health(): Promise<void> {
    const result = await json<{ ready?: boolean }>(
      "/healthz",
      "GET",
      undefined,
      5_000,
    );
    if (result.ready !== true)
      throw new Error("Runtime supervisor is not ready");
  }
  async function networkBoundary() {
    return validateNetworkBoundary(
      await json<unknown>("/v1/network-boundary", "GET", undefined, 5_000),
    );
  }
  return { runtime, registry, libraryHost, health, networkBoundary };
}
