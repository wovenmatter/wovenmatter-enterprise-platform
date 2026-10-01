import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  agentInstructions,
  runtimeEnvironment,
  egressEnvironment,
} from "./native.ts";
import {
  RuntimeError,
  type ContainerRequest,
  type EventSink,
  type RuntimeEvent,
} from "./types.ts";

export async function runClaude(
  request: ContainerRequest,
  emit: EventSink,
  signal: AbortSignal,
): Promise<void> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  signal.addEventListener("abort", abort, { once: true });
  await mkdir("/session/claude", { recursive: true, mode: 0o700 });
  const env = {
    ...runtimeEnvironment(),
    ...egressEnvironment(request),
    CLAUDE_CONFIG_DIR: "/session/claude",
    ANTHROPIC_BASE_URL: request.gateway.baseUrl,
    ANTHROPIC_AUTH_TOKEN: request.gateway.token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  let finished = false;
  const toolNames = new Map<string, string>();
  const streamedMessages = new Set<string>();
  let currentMessageId = "";
  const stream = query({
    prompt: request.prompt,
    options: {
      cwd: "/workspace",
      model: request.model,
      env,
      abortController,
      ...(request.resumeId ? { resume: request.resumeId } : {}),
      // Docker enforces ceilings for all tools/subagents, including shell commands.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      mcpServers: {},
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: agentInstructions + ` Current access: ${request.access}.`,
      },
    },
  });
  try {
    signal.throwIfAborted();
    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init")
        await emit({ type: "native_session", sessionId: message.session_id });
      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "message_start") currentMessageId = event.message.id;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          streamedMessages.add(currentMessageId);
          await emit({ type: "assistant_delta", delta: event.delta.text });
        }
      }
      if (message.type === "assistant")
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            toolNames.set(block.id, block.name);
            await emit({
              type: "tool_start",
              tool: block.name,
              toolId: block.id,
            });
          }
          if (
            block.type === "text" &&
            !streamedMessages.has(message.message.id)
          )
            await emit({ type: "assistant_delta", delta: block.text });
        }
      if (
        message.type === "user" &&
        typeof message.message.content !== "string"
      )
        for (const block of message.message.content) {
          if (block.type === "tool_result")
            await emit({
              type: "tool_end",
              tool: toolNames.get(block.tool_use_id) ?? "tool",
              toolId: block.tool_use_id,
              status: block.is_error ? "failed" : "completed",
            });
        }
      if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error)
          throw new RuntimeError(
            "agent_failed",
            "Claude did not finish the requested work",
          );
        finished = true;
      }
    }
    if (!finished)
      throw new RuntimeError(
        "agent_disconnected",
        "Claude disconnected before completing",
      );
  } finally {
    signal.removeEventListener("abort", abort);
    stream.close();
  }
}

/** Pi uses its public SDK directly with the centrally configured inference gateway. */
export async function runPi(
  request: ContainerRequest,
  emit: EventSink,
  signal: AbortSignal,
): Promise<void> {
  const {
    ModelRuntime,
    SessionManager,
    SettingsManager,
    DefaultResourceLoader,
    createAgentSession,
  } = await import("@earendil-works/pi-coding-agent");
  await mkdir("/session/pi", { recursive: true, mode: 0o700 });
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    modelsStorePath: "/session/pi/models.json",
    refreshOnCreate: false,
    allowModelNetwork: false,
    credentials: {
      async read() {
        return undefined;
      },
      async list() {
        return [];
      },
      async modify() {
        throw new Error("Central credentials cannot be changed from a project");
      },
      async delete() {
        throw new Error("Central credentials cannot be changed from a project");
      },
    },
  });
  runtime.registerProvider("wovenmatter-enterprise", {
    name: "WovenMatter Enterprise Platform",
    baseUrl: request.gateway.baseUrl.replace(/\/$/, "") + "/v1",
    api: "openai-completions",
    authHeader: true,
    models: [
      {
        id: request.model,
        name: request.model,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 8192,
      },
    ],
  });
  await runtime.setRuntimeApiKey("wovenmatter-enterprise", request.gateway.token);
  let sessionManager;
  if (request.resumeId) {
    const file = (await readdir("/session/pi")).find((name) =>
      name.endsWith(`_${request.resumeId}.jsonl`),
    );
    if (!file)
      throw new RuntimeError(
        "session_missing",
        "The saved Pi session is unavailable; the request was not replayed",
      );
    sessionManager = SessionManager.open(
      join("/session/pi", file),
      "/session/pi",
    );
  } else sessionManager = SessionManager.create("/workspace", "/session/pi");
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: true },
  });
  const loader = new DefaultResourceLoader({
    cwd: "/workspace",
    agentDir: "/session/pi",
    settingsManager,
    noExtensions: true,
    noThemes: true,
    noSkills: true,
    noPromptTemplates: true,
    appendSystemPrompt: [
      agentInstructions + ` Current access: ${request.access}.`,
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: "/workspace",
    agentDir: "/session/pi",
    modelRuntime: runtime,
    model: runtime.getModel("wovenmatter-enterprise", request.model),
    sessionManager,
    settingsManager,
    resourceLoader: loader,
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  });
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) =>
    stream(model, context, { ...options, maxRetries: 0, transport: "sse" });
  // SDK notifications are synchronous. Chain persistence to preserve event order and surface failures.
  let events = Promise.resolve();
  let agentError = false;
  const push = (event: RuntimeEvent) => {
    events = events.then(async () => {
      await emit(event);
    });
    void events.catch(() => session.abort());
  };
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    )
      push({
        type: "assistant_delta",
        delta: event.assistantMessageEvent.delta,
      });
    if (event.type === "tool_execution_start")
      push({
        type: "tool_start",
        tool: event.toolName,
        toolId: event.toolCallId,
      });
    if (event.type === "tool_execution_end")
      push({
        type: "tool_end",
        tool: event.toolName,
        toolId: event.toolCallId,
        status: event.isError ? "failed" : "completed",
      });
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      ["error", "aborted"].includes(event.message.stopReason)
    )
      agentError = true;
  });
  const abort = () => {
    void session.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await emit({ type: "native_session", sessionId: session.sessionId });
    await session.prompt(request.prompt);
    await events;
    if (agentError)
      throw new RuntimeError(
        "agent_failed",
        "Pi did not finish the requested work",
      );
  } finally {
    signal.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
}
