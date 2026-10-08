import { isAbsolute, posix, resolve, relative, sep } from "node:path";
import { realpath, lstat } from "node:fs/promises";
import {
  RuntimeError,
  type ContainerRequest,
  type RuntimeEvent,
  type RuntimeRequest,
} from "./types.ts";

export const MAX_LINE = 1024 * 1024;
export const MAX_OUTPUT = 16 * 1024 * 1024;
export function identity(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
  )
    throw new RuntimeError("invalid_identity", "Invalid runtime identity");
  return value;
}
export function validateContainerRequest(input: ContainerRequest): void {
  identity(input.runId);
  identity(input.projectId);
  if (input.assetId !== undefined) identity(input.assetId);
  if (
    !["codex", "claude", "grok", "pi"].includes(input.harness) ||
    !["read", "write"].includes(input.access)
  )
    throw new RuntimeError("invalid_request", "Invalid harness or access mode");
  if (
    typeof input.prompt !== "string" ||
    input.prompt.length < 1 ||
    Buffer.byteLength(input.prompt) > 512 * 1024
  )
    throw new RuntimeError(
      "invalid_request",
      "Prompt exceeds the supported size",
    );
  if (
    typeof input.model !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]{0,255}$/.test(input.model)
  )
    throw new RuntimeError("invalid_request", "Invalid model");
  if (
    input.resumeId !== undefined &&
    (typeof input.resumeId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(input.resumeId))
  )
    throw new RuntimeError(
      "invalid_request",
      "Invalid native session identity",
    );
  let url: URL;
  try {
    url = new URL(input.gateway.baseUrl);
  } catch {
    throw new RuntimeError("invalid_gateway", "Invalid inference gateway");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new RuntimeError("invalid_gateway", "Invalid inference gateway");
  if (
    typeof input.gateway.token !== "string" ||
    input.gateway.token.length < 20 ||
    input.gateway.token.length > 8192 ||
    /[\r\n\x00]/.test(input.gateway.token)
  )
    throw new RuntimeError("invalid_gateway", "Invalid inference grant");
  if (input.egressProxyUrl !== undefined) {
    let proxy: URL;
    try {
      if (typeof input.egressProxyUrl !== "string") throw new Error();
      proxy = new URL(input.egressProxyUrl);
    } catch {
      throw new RuntimeError(
        "invalid_egress",
        "Invalid runtime egress capability",
      );
    }
    if (
      proxy.protocol !== "http:" ||
      !proxy.port ||
      proxy.hostname !== url.hostname ||
      proxy.pathname !== "/" ||
      proxy.username ||
      proxy.password ||
      proxy.search ||
      proxy.hash
    )
      throw new RuntimeError(
        "invalid_egress",
        "Invalid runtime egress capability",
      );
  }
  if (input.pi !== undefined) {
    if (input.pi.provider !== undefined && !["openai", "anthropic", "xai", "openrouter", "custom"].includes(input.pi.provider))
      throw new RuntimeError("invalid_request", "Invalid Pi provider");
    if (input.pi.api !== undefined && !["openai-responses", "anthropic-messages", "openai-compatible"].includes(input.pi.api))
      throw new RuntimeError("invalid_request", "Invalid Pi API");
    for (const key of ["contextWindow", "maxOutputTokens"] as const) {
      const value = input.pi[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000))
        throw new RuntimeError("invalid_request", "Invalid Pi model limit");
    }
    if (input.pi.routeIdentity !== undefined && (typeof input.pi.routeIdentity !== "string" || input.pi.routeIdentity.length > 512 || /[\r\n\x00]/.test(input.pi.routeIdentity)))
      throw new RuntimeError("invalid_request", "Invalid Pi route identity");
    if (input.pi.accountAffinity !== undefined && input.pi.accountAffinity !== "proxy-session-affinity")
      throw new RuntimeError("invalid_request", "Invalid Pi account affinity");
    if (input.pi.sdkGeneration !== undefined && (typeof input.pi.sdkGeneration !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(input.pi.sdkGeneration)))
      throw new RuntimeError("invalid_request", "Invalid Pi SDK generation");
  }
}
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))
  );
}
export async function validateHostRequest(
  request: RuntimeRequest,
  storageRoots: string[],
  sessionRoot: string,
): Promise<void> {
  validateContainerRequest(request);
  for (const key of ["organizationId", "projectId", "conversationId"] as const)
    identity(request[key]);
  if (request.mounts.length < 1 || request.mounts.length > 128)
    throw new RuntimeError("invalid_mount", "Invalid workspace mounts");
  const roots = await Promise.all(storageRoots.map((root) => realpath(root)));
  const targets = new Set<string>();
  for (const mount of request.mounts) {
    if (
      !isAbsolute(mount.source) ||
      /[\x00-\x1f\x7f]/.test(mount.source) ||
      !["read", "write"].includes(mount.access)
    )
      throw new RuntimeError("invalid_mount", "Invalid workspace mount");
    const path = await realpath(mount.source);
    if (
      path !== resolve(mount.source) ||
      !roots.some((root) => isWithin(root, path))
    )
      throw new RuntimeError(
        "invalid_mount",
        "Workspace mount escapes managed storage",
      );
    if ((await lstat(path)).isSymbolicLink())
      throw new RuntimeError(
        "invalid_mount",
        "Symbolic source mounts are not permitted",
      );
    if (
      !/^\/workspace(?:\/[^/\\\x00-\x1f\x7f]+)*$/u.test(mount.target) ||
      Buffer.byteLength(mount.target) > 4096 ||
      posix.normalize(mount.target) !== mount.target ||
      targets.has(mount.target)
    )
      throw new RuntimeError("invalid_mount", "Invalid workspace mount target");
    targets.add(mount.target);
  }
  if (!targets.has("/workspace"))
    throw new RuntimeError(
      "invalid_mount",
      "The project workspace is required",
    );
  const nativeRoot = await realpath(sessionRoot);
  const native = await realpath(request.sessionDirectory);
  if (
    native !== resolve(request.sessionDirectory) ||
    !isWithin(nativeRoot, native) ||
    native === nativeRoot ||
    roots.some((root) => isWithin(root, native))
  )
    throw new RuntimeError(
      "invalid_session",
      "Native session storage must be outside project files",
    );
}
export function validateEvent(value: unknown): RuntimeEvent {
  const event = validateEventBody(value);
  const sequence = (value as { sequence?: unknown }).sequence;
  if (sequence !== undefined) {
    if (!Number.isSafeInteger(sequence) || Number(sequence) < 1)
      throw new RuntimeError(
        "invalid_cursor",
        "Invalid runtime event sequence",
      );
    return { ...event, sequence: sequence as number };
  }
  return event;
}
function validateEventBody(value: unknown): RuntimeEvent {
  if (!value || typeof value !== "object")
    throw new RuntimeError("invalid_event", "Invalid runtime event");
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "attached":
      return {
        type: "attached",
        ...(v.terminal === true ? { terminal: true } : {}),
      };
    case "started":
    case "input_accepted":
    case "completed":
    case "cancelled":
      return { type: v.type };
    case "native_session":
      if (
        typeof v.sessionId === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(v.sessionId)
      )
        return { type: v.type, sessionId: v.sessionId };
      break;
    case "assistant_delta":
      if (typeof v.delta === "string" && Buffer.byteLength(v.delta) <= MAX_LINE)
        return { type: v.type, delta: v.delta };
      break;
    case "assistant_snapshot":
      if (typeof v.text === "string" && Buffer.byteLength(v.text) <= MAX_LINE)
        return { type: v.type, text: v.text };
      break;
    case "native_update":
      if (v.update && typeof v.update === "object" && !Array.isArray(v.update))
        return { type: v.type, update: v.update as Record<string, unknown> };
      break;
    case "native_records":
      if (v.batch && typeof v.batch === "object" && !Array.isArray(v.batch))
        return { type: v.type, batch: v.batch as Record<string, unknown> };
      break;
    case "citation":
      if (
        typeof v.fileId === "string" &&
        typeof v.versionId === "string" &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(v.fileId) &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(v.versionId) &&
        (v.page === undefined ||
          (Number.isSafeInteger(v.page) && (v.page as number) > 0))
      )
        return {
          type: "citation",
          fileId: v.fileId,
          versionId: v.versionId,
          ...(v.page === undefined ? {} : { page: v.page as number }),
          ...(typeof v.label === "string"
            ? { label: v.label.slice(0, 256) }
            : {}),
        };
      break;
    case "tool_start":
    case "tool_end":
      if (
        typeof v.tool === "string" &&
        v.tool.length <= 200 &&
        typeof v.toolId === "string" &&
        v.toolId.length <= 256
      )
        return {
          type: v.type,
          tool: v.tool,
          toolId: v.toolId,
          ...(typeof v.status === "string"
            ? { status: v.status.slice(0, 80) }
            : {}),
        };
      break;
    case "failed":
      return {
        type: "failed",
        code:
          typeof v.code === "string" && /^[a-z][a-z_]{0,63}$/.test(v.code)
            ? v.code
            : "harness_failed",
        message:
          "The agent runtime failed. The request was not automatically replayed.",
      };
  }
  throw new RuntimeError("invalid_event", "Invalid runtime event");
}
