import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { agentInstructions } from "../native.ts";
import { SteeringChannel, steeringText } from "../steering.ts";
import {
  RuntimeError,
  type ContainerRequest,
  type EventSink,
} from "../types.ts";
import { loadEmbeddedDefaultAgent } from "./default-agent.ts";

type EngineRecord = {
  engine: {
    initialize(): Promise<unknown>;
    apply(payload: Record<string, unknown>): Promise<unknown>;
    handle(
      method: string,
      params?: Record<string, unknown>,
      emit?: (update: Record<string, unknown>) => void,
    ): Promise<Record<string, unknown>>;
  };
  sessionId?: string;
  routeKey: string;
  model: string;
  tokenDigest: string;
  optionsKey: string;
  sdkGeneration: string;
};

export type EnterprisePiDependencies = {
  sessionDirectory?: string;
  cwd?: string;
  sdkCatalogDirectory?: string;
  claudeQuery?: (
    options: unknown,
  ) => Promise<AsyncIterable<unknown> & { close?: () => void }>;
};

type PiProviderRoute = {
  provider: string;
  model: string;
  baseUrl: string;
  api: "openai-responses" | "anthropic-messages" | "woven-claude-native";
  nativeCompaction: boolean;
  customServer?: { id: string; url: string; models: string[] };
  enterpriseProvider?: {
    id: string;
    definition: Record<string, unknown>;
  };
};

function piModelDefinition(request: ContainerRequest) {
  return {
    id: request.model,
    name: request.model,
    reasoning: request.pi?.supportsReasoning === true,
    input: request.pi?.supportsImages === true ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: request.pi?.contextWindow ?? 32768,
    maxTokens: request.pi?.maxOutputTokens ?? 4096,
  };
}

function stableLocalProviderId(request: ContainerRequest) {
  const route = `${request.gateway.baseUrl.replace(/\/$/, "")}/v1:${request.model}`;
  const hex = createHash("sha256").update(route).digest("hex").slice(0, 32);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return `local-server-${uuid}`;
}

export function enterprisePiRoute(request: ContainerRequest): PiProviderRoute {
  const provider = request.pi?.provider;
  const gateway = request.gateway.baseUrl.replace(/\/$/, "");
  if (provider === "openai") {
    return {
      provider: "openai",
      model: request.model,
      baseUrl: `${gateway}/v1`,
      api: "openai-responses",
      nativeCompaction: true,
      enterpriseProvider: {
        id: "openai",
        definition: {
          name: "WovenMatter Enterprise OpenAI",
          baseUrl: `${gateway}/v1`,
          api: "openai-responses",
          authHeader: true,
          models: [piModelDefinition(request)],
        },
      },
    };
  }
  if (provider === "xai") {
    return {
      provider: "xai-api",
      model: request.model,
      baseUrl: `${gateway}/v1`,
      api: "openai-responses",
      nativeCompaction: true,
      enterpriseProvider: {
        id: "xai-api",
        definition: {
          name: "WovenMatter Enterprise xAI",
          baseUrl: `${gateway}/v1`,
          api: "openai-responses",
          authHeader: true,
          models: [piModelDefinition(request)],
        },
      },
    };
  }
  if (provider === "anthropic") {
    return {
      provider: "anthropic",
      model: request.model,
      baseUrl: gateway,
      api: "woven-claude-native",
      nativeCompaction: true,
    };
  }
  const id = stableLocalProviderId(request);
  return {
    provider: id,
    model: request.model,
    baseUrl: `${gateway}/v1`,
    api: "openai-responses",
    nativeCompaction: false,
    customServer: { id, url: `${gateway}/v1`, models: [request.model] },
  };
}

function routeKey(request: ContainerRequest) {
  const route = enterprisePiRoute(request);
  return [
    request.pi?.routeIdentity ??
      `${route.provider}:${route.baseUrl}:${route.model}`,
    route.api,
    route.nativeCompaction ? "compact" : "no-compact",
  ].join(":");
}

function tokenDigest(request: ContainerRequest) {
  return createHash("sha256").update(request.gateway.token).digest("hex");
}

function optionsKey(request: ContainerRequest) {
  const options = validatedPiOptions(request);
  return JSON.stringify(options);
}

function nativeEmitter(emit: EventSink, inputId: string) {
  let queue = Promise.resolve();
  let failure: unknown;
  let accepted = false;
  const push = (event: Parameters<EventSink>[0]) => {
    queue = queue
      .then(() => emit(event))
      .catch((error) => {
        failure ??= error;
      });
    return queue;
  };
  const handle = (update: Record<string, unknown>) => {
    const sessionUpdate = update.sessionUpdate;
    if (sessionUpdate === "woven_input_accepted") {
      void push({ type: "native_update", update });
      if (!accepted && update.inputID === inputId) {
        accepted = true;
        void push({ type: "input_accepted" });
      }
      return;
    }
    if (sessionUpdate === "woven_native_record" && update.recordBatch) {
      void push({
        type: "native_records",
        batch: update.recordBatch as Record<string, unknown>,
      });
      return;
    }
    if (
      sessionUpdate === "agent_message_chunk" ||
      sessionUpdate === "agent_thought_chunk"
    ) {
      const content = update.content as { text?: unknown } | undefined;
      const text = typeof content?.text === "string" ? content.text : "";
      const meta = update._meta as Record<string, unknown> | undefined;
      const snapshot =
        meta?.wovenAssistantSnapshot === true ||
        meta?.wovenThoughtSnapshot === true;
      if (snapshot) {
        void push({ type: "native_update", update });
      } else if (text) {
        void push({ type: "native_update", update });
        if (sessionUpdate === "agent_message_chunk")
          void push({ type: "assistant_delta", delta: text });
      }
      return;
    }
    void push({ type: "native_update", update });
  };
  return {
    handle,
    settle: async () => {
      await queue;
      if (failure) throw failure;
    },
  };
}

function validatedPiOptions(request: ContainerRequest) {
  const codeMode = request.pi?.codeMode ?? "on";
  if (!["on", "only", "off"].includes(codeMode))
    throw new RuntimeError("invalid_pi_option", "Unsupported Pi code mode.");
  const subagentConcurrency = request.pi?.subagentConcurrency ?? 8;
  if (
    !Number.isInteger(subagentConcurrency) ||
    subagentConcurrency < 2 ||
    subagentConcurrency > 24
  )
    throw new RuntimeError(
      "invalid_pi_option",
      "Pi subagent concurrency must be an integer between 2 and 24.",
    );
  const thinking = request.pi?.thinking;
  if (
    thinking !== undefined &&
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      thinking,
    )
  )
    throw new RuntimeError(
      "invalid_pi_option",
      "Unsupported Pi thinking level.",
    );
  return { codeMode, subagentConcurrency, thinking };
}

function anthropicModelDefinition(request: ContainerRequest) {
  return {
    value: request.model,
    displayName: request.model,
    supportedEffortLevels:
      request.pi?.supportsReasoning === true
        ? ["low", "medium", "high", "max"]
        : [],
  };
}

function enterpriseClaudeFetch(
  request: ContainerRequest,
  credentials: { read(provider: string): Promise<{ key?: string }> },
) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const incoming = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const headers = new Headers();
    const contentType = incoming.get("content-type");
    const accept = incoming.get("accept");
    const anthropicVersion = incoming.get("anthropic-version");
    const anthropicBeta = incoming.get("anthropic-beta");
    if (contentType) headers.set("content-type", contentType);
    if (accept) headers.set("accept", accept);
    if (anthropicVersion) headers.set("anthropic-version", anthropicVersion);
    if (anthropicBeta && Buffer.byteLength(anthropicBeta) <= 2048)
      headers.set("anthropic-beta", anthropicBeta);
    const credential = await credentials.read("anthropic");
    if (!credential?.key)
      throw new RuntimeError(
        "gateway_unavailable",
        "The scoped inference capability is unavailable.",
      );
    headers.set("authorization", `Bearer ${credential.key}`);
    headers.set("x-wovenmatter-model", request.model);
    if (request.pi?.routeIdentity)
      headers.set("x-wovenmatter-route-identity", request.pi.routeIdentity);
    return fetch(input, {
      ...init,
      headers,
      signal: init?.signal,
      redirect: "error",
    });
  };
}

function enterpriseClaudeRuntime(
  ClaudeRuntime: new (directory: string) => {
    directory: string;
    models: Array<Record<string, unknown>>;
    sdkVersion(): Promise<string>;
    sdkQuery(
      options: unknown,
    ): Promise<AsyncIterable<unknown> & { close?: () => void }>;
  },
  directory: string,
  request: ContainerRequest,
  route: PiProviderRoute,
  query?: EnterprisePiDependencies["claudeQuery"],
) {
  const gateway = route.baseUrl.replace(/\/$/, "");
  return new (class EnterpriseClaudeRuntime extends ClaudeRuntime {
    models = [anthropicModelDefinition(request)];

    async loadModels() {
      this.models = [anthropicModelDefinition(request)];
    }

    async status() {
      return {
        connected: false,
        state: "credentials_present",
        detail:
          "Anthropic is available through the scoped Enterprise gateway for this run.",
      };
    }

    async discover() {
      return this.models;
    }

    async environment(key?: string) {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
          ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"].includes(
            name,
          ),
        ),
      );
      return {
        ...env,
        HOME: directory,
        NO_PROXY: "localhost,127.0.0.1,::1",
        ANTHROPIC_API_KEY: key ?? request.gateway.token,
        ANTHROPIC_BASE_URL: gateway,
        CLAUDE_CONFIG_DIR: `${directory}/claude-enterprise-config`,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: `${directory}/claude-enterprise-config`,
        CLAUDE_AGENT_SDK_CLIENT_APP: "wovenmatter-enterprise/0.1.0",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
      };
    }

    providerDependencies(credentials: {
      read(provider: string): Promise<{ key?: string }>;
    }) {
      return {
        admission: {
          upstream: gateway,
          fetcher: enterpriseClaudeFetch(request, credentials),
        },
      };
    }

    async sdkQuery(options: unknown) {
      if (query) return query(options);
      return super.sdkQuery(options);
    }
  })(directory);
}

function enterpriseInstructions(request: ContainerRequest) {
  return [
    agentInstructions,
    `Current access: ${request.access}.`,
    request.assetId
      ? `This run is scoped to asset ${request.assetId}; preserve asset draft and publication boundaries.`
      : "This run is scoped to the current project workspace.",
    "Background jobs and scheduled scripts are not new chat sessions; do not invent scheduling authority or report background completion without observing native results.",
  ].join(" ");
}

async function createEngine(
  request: ContainerRequest,
  dependencies: EnterprisePiDependencies = {},
): Promise<EngineRecord> {
  const runtime = await loadEmbeddedDefaultAgent({
    sdkGeneration: request.pi?.sdkGeneration,
    catalogDirectory: dependencies.sdkCatalogDirectory,
  });
  const route = enterprisePiRoute(request);
  const model = `${route.provider}/${route.model}`;
  const directory = join(
    dependencies.sessionDirectory ?? "/session",
    "pi-enterprise",
  );
  const options = validatedPiOptions(request);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { DefaultAgentEngine } = (await import(
    new URL("src/engine.mjs", `file://${runtime.root}/`).href
  )) as {
    DefaultAgentEngine: new (
      input: Record<string, unknown>,
    ) => EngineRecord["engine"];
  };
  const { ClaudeRuntime } = (await import(
    new URL("src/claude-runtime.mjs", `file://${runtime.root}/`).href
  )) as {
    ClaudeRuntime: new (directory: string) => {
      directory: string;
      models: Array<Record<string, unknown>>;
      sdkVersion(): Promise<string>;
      sdkQuery(
        options: unknown,
      ): Promise<AsyncIterable<unknown> & { close?: () => void }>;
    };
  };
  const cwd = dependencies.cwd ?? "/workspace";
  const claude =
    route.provider === "anthropic"
      ? enterpriseClaudeRuntime(
          ClaudeRuntime,
          directory,
          request,
          route,
          dependencies.claudeQuery,
        )
      : {
          models: [],
          async loadModels() {},
          async status() {
            return { connected: false, state: "sign_in_required" };
          },
          async discover() {},
        };
  const engine = new DefaultAgentEngine({
    cwd,
    directory,
    config: {
      providers: [route.provider],
      models: [model],
      defaultModel: model,
      fallbackModels: [],
      codeMode: options.codeMode,
      subagentConcurrency: options.subagentConcurrency,
      customServers: route.customServer ? [route.customServer] : [],
    },
    credentials: {
      [route.provider]: {
        type: "api_key",
        key: request.gateway.token,
        enterpriseRouteIdentity: routeKey(request),
      },
    },
    enterpriseProviders: route.enterpriseProvider
      ? [route.enterpriseProvider]
      : [],
    enterpriseInstructions: enterpriseInstructions(request),
    claude,
  });
  await engine.initialize();
  return {
    engine,
    routeKey: routeKey(request),
    model: request.model,
    tokenDigest: tokenDigest(request),
    optionsKey: optionsKey(request),
    sdkGeneration: runtime.generation,
  };
}

async function refreshEngine(record: EngineRecord, request: ContainerRequest) {
  const route = enterprisePiRoute(request);
  const nextTokenDigest = tokenDigest(request);
  const nextOptionsKey = optionsKey(request);
  if (record.tokenDigest !== nextTokenDigest) {
    await record.engine.apply({
      credentials: {
        [route.provider]: {
          type: "api_key",
          key: request.gateway.token,
          enterpriseRouteIdentity: routeKey(request),
        },
      },
    });
    record.tokenDigest = nextTokenDigest;
  }
  if (record.optionsKey !== nextOptionsKey) {
    const options = validatedPiOptions(request);
    await record.engine.apply({
      config: {
        providers: [route.provider],
        models: [`${route.provider}/${route.model}`],
        defaultModel: `${route.provider}/${route.model}`,
        fallbackModels: [],
        codeMode: options.codeMode,
        subagentConcurrency: options.subagentConcurrency,
        customServers: route.customServer ? [route.customServer] : [],
      },
    });
    record.optionsKey = nextOptionsKey;
  }
}

export async function runEnterprisePi(
  request: ContainerRequest,
  emit: EventSink,
  signal: AbortSignal,
  steering?: SteeringChannel,
  retained?: { pi?: unknown },
  dependencies: EnterprisePiDependencies = {},
) {
  signal.throwIfAborted();
  let record = retained?.pi as EngineRecord | undefined;
  const retainedSessionId = record?.sessionId;
  const nextRouteKey = routeKey(request);
  const requestedGeneration = request.pi?.sdkGeneration;
  if (
    record &&
    requestedGeneration !== undefined &&
    record.sdkGeneration !== requestedGeneration
  )
    throw new RuntimeError(
      "sdk_generation_active",
      "This Pi Durable session is still attached to another approved SDK generation. Stop or reopen it before changing SDK generation.",
    );
  if (record && record.routeKey !== nextRouteKey) {
    if (record.sessionId)
      await record.engine
        .handle("session/dispose", { sessionId: record.sessionId })
        .catch(() => undefined);
    record = undefined;
    if (retained) delete retained.pi;
  }
  record ??= await createEngine(request, dependencies);
  await refreshEngine(record, request);
  if (retained && !retained.pi) retained.pi = record;
  const native = nativeEmitter(emit, request.runId);
  const abort = () => {
    if (record.sessionId)
      void record.engine
        .handle("session/cancel", { sessionId: record.sessionId })
        .catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const loaded = await record.engine.handle(
      request.resumeId || retainedSessionId ? "session/load" : "session/new",
      {
        ...(request.resumeId || retainedSessionId
          ? { sessionId: request.resumeId ?? retainedSessionId }
          : {}),
        cwd: dependencies.cwd ?? "/workspace",
      },
      native.handle,
    );
    const sessionId = String(loaded.sessionId ?? "");
    if (!sessionId)
      throw new RuntimeError(
        "session_missing",
        "Pi Durable did not open a session.",
      );
    record.sessionId = sessionId;
    await emit({ type: "native_session", sessionId });
    const options = validatedPiOptions(request);
    if (options.thinking)
      await record.engine.handle(
        "session/set_config_option",
        { sessionId, configId: "thinking", value: options.thinking },
        native.handle,
      );
    steering?.set(async (input) => {
      await record.engine.handle(
        "_session/steering",
        {
          sessionId,
          prompt: [{ type: "text", text: steeringText(input) }],
          _meta: {
            wovenInputID: input.id,
            wovenTools: undefined,
          },
        },
        native.handle,
      );
      await native.settle();
    });
    const result = await record.engine.handle(
      "session/prompt",
      {
        sessionId,
        prompt: [{ type: "text", text: request.prompt }],
        _meta: {
          wovenRunID: request.runId,
          wovenInputID: request.runId,
        },
      },
      native.handle,
    );
    await native.settle();
    await steering?.settle();
    const stopReason = result.stopReason;
    if (stopReason === "cancelled") await emit({ type: "cancelled" });
    else await emit({ type: "completed" });
  } catch (error) {
    if (signal.aborted) await emit({ type: "cancelled" });
    else
      await emit({
        type: "failed",
        code: error instanceof RuntimeError ? error.code : "agent_failed",
        message: error instanceof Error ? error.message : "Pi Durable failed.",
      });
  } finally {
    signal.removeEventListener("abort", abort);
    await steering?.settle();
    await native.settle();
    if (!retained && record.sessionId)
      await record.engine
        .handle("session/dispose", { sessionId: record.sessionId })
        .catch(() => undefined);
  }
}
