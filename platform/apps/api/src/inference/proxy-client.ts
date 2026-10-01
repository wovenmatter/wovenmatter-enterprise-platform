import { AppError } from "../context.js";
/** CLIProxyAPI v8 adapter, pinned to acdace936fa7df2905500c7f5e0a97d683138dea. */
export const CLI_PROXY_REVISION = "acdace936fa7df2905500c7f5e0a97d683138dea";
export const CLAUDE_SUBSCRIPTION_NOTICE =
  "Using a Claude subscription through this third-party proxy may result in Anthropic restricting, suspending, or terminating your account. Continued access is not guaranteed.";

export class InferenceError extends AppError {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(statusCode, code, message);
    this.name = "InferenceError";
  }
}
export interface ProxyEndpoint {
  baseUrl: string;
  managementKey: string;
  clientKey: string;
}
export type ProxyResolver = (
  organizationId: string,
) => Promise<ProxyEndpoint | undefined>;
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
export function text(value: unknown, limit = 240): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/** Errors deliberately exclude upstream response bodies, URLs and credentials. */
export class ProxyClient {
  constructor(
    private readonly resolve: ProxyResolver,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async endpoint(organizationId: string): Promise<ProxyEndpoint> {
    const endpoint = await this.resolve(organizationId);
    if (!endpoint)
      throw new InferenceError(
        503,
        "inference_not_configured",
        "Central inference is not configured for this organization.",
      );
    const url = new URL(endpoint.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      throw new InferenceError(
        503,
        "invalid_inference_configuration",
        "The inference service configuration is invalid.",
      );
    }
    if (
      !endpoint.managementKey ||
      !endpoint.clientKey ||
      endpoint.managementKey === endpoint.clientKey
    ) {
      throw new InferenceError(
        503,
        "invalid_inference_configuration",
        "Separate management and inference credentials are required.",
      );
    }
    return endpoint;
  }
  async request(
    organizationId: string,
    path: string,
    init: { method?: string; body?: unknown; client?: boolean } = {},
  ): Promise<unknown> {
    const endpoint = await this.endpoint(organizationId);
    if (!path.startsWith(init.client ? "/v1/" : "/v8/management/"))
      throw new Error("Invalid proxy API path");
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, endpoint.baseUrl), {
        method: init.method ?? "GET",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${init.client ? endpoint.clientKey : endpoint.managementKey}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new InferenceError(
        502,
        "inference_unavailable",
        "The central inference service could not be reached.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new InferenceError(
        502,
        "inference_request_failed",
        `The central inference service rejected the operation (HTTP ${response.status}).`,
      );
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 4 * 1024 * 1024) {
      await response.body?.cancel();
      throw new InferenceError(
        502,
        "inference_response_too_large",
        "The inference response exceeded the allowed size.",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) return {};
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new InferenceError(
            502,
            "inference_response_too_large",
            "The inference response exceeded the allowed size.",
          );
        }
        chunks.push(value);
      }
      return size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch (error) {
      if (error instanceof InferenceError) throw error;
      throw new InferenceError(
        502,
        "invalid_inference_response",
        "The inference service returned an invalid response.",
      );
    } finally {
      reader.releaseLock();
    }
  }
  async forward(
    organizationId: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    forwarding: { sessionId?: string; anthropicBeta?: string } = {},
  ): Promise<Response> {
    if (
      ![
        "/v1/models",
        "/v1/responses",
        "/v1/responses/compact",
        "/v1/chat/completions",
        "/v1/messages",
        "/v1/messages/count_tokens",
      ].includes(path)
    ) {
      throw new InferenceError(
        404,
        "inference_endpoint_not_found",
        "This inference endpoint is unavailable.",
      );
    }
    const endpoint = await this.endpoint(organizationId);
    try {
      return await this.fetcher(new URL(path, endpoint.baseUrl), {
        method: path === "/v1/models" ? "GET" : "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${endpoint.clientKey}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(forwarding.sessionId
            ? { "x-session-affinity": forwarding.sessionId }
            : {}),
          ...(forwarding.anthropicBeta
            ? { "anthropic-beta": forwarding.anthropicBeta }
            : {}),
        },
        ...(path === "/v1/models" ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new InferenceError(
        502,
        "inference_unavailable",
        "The central inference service could not be reached.",
      );
    }
  }
}
