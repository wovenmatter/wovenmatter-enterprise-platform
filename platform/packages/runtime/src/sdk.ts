import { randomUUID } from "node:crypto";
import { SteeringChannel, steeringText } from "./steering.js";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  agentInstructions,
  runtimeEnvironment,
  egressEnvironment,
  type NativeSessionState,
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
  steering?: SteeringChannel,
  dependencies?: {
    query: typeof import("@anthropic-ai/claude-agent-sdk").query;
    sessionDirectory: string;
  },
  retained?: NativeSessionState,
): Promise<void> {
  const { query } =
    dependencies ?? (await import("@anthropic-ai/claude-agent-sdk"));
  const sessionDirectory = dependencies?.sessionDirectory ?? "/session/claude";
  const abortController =
    retained?.claude?.abortController ?? new AbortController();
  const abort = () => abortController.abort();
  signal.addEventListener("abort", abort, { once: true });
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const env = {
    ...runtimeEnvironment(),
    ...egressEnvironment(request),
    CLAUDE_CONFIG_DIR: sessionDirectory,
    ANTHROPIC_BASE_URL: request.gateway.baseUrl,
    ANTHROPIC_AUTH_TOKEN: request.gateway.token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  let finished = false;
  const toolNames = new Map<string, string>();
  const streamedMessages = new Set<string>();
  let currentMessageId = "";
  const { PassThrough } = await import("node:stream");
  const inputStream =
    retained?.claude?.input ?? new PassThrough({ objectMode: true });
  const receipts = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void }
  >();
  const initialId = randomUUID();
  const unfinished = new Set<string>([initialId]);
  inputStream.write({
    type: "user",
    uuid: initialId,
    message: { role: "user", content: request.prompt },
    parent_tool_use_id: null,
  });
  const stream =
    retained?.claude?.stream ??
    query({
      prompt: inputStream,
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
  const iterator = retained?.claude?.iterator ?? stream[Symbol.asyncIterator]();
  if (retained && !retained.claude)
    retained.claude = { input: inputStream, stream, iterator, abortController };
  if (retained?.claude?.sessionId)
    await emit({
      type: "native_session",
      sessionId: retained.claude.sessionId,
    });
  try {
    signal.throwIfAborted();
    steering?.set(
      (input) =>
        new Promise<void>((resolve, reject) => {
          signal.throwIfAborted();
          const timer = setTimeout(() => {
            receipts.delete(input.id);
            reject(
              new RuntimeError(
                "steering_uncertain",
                "Claude did not acknowledge this input.",
              ),
            );
          }, 30000);
          receipts.set(input.id, {
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          unfinished.add(input.id);
          inputStream.write({
            type: "user",
            uuid: input.id,
            priority: "now",
            message: { role: "user", content: steeringText(input) },
            parent_tool_use_id: null,
          });
        }),
    );
    for await (const message of {
      [Symbol.asyncIterator]: () => ({
        next: () => iterator.next(),
        return: async () => ({ done: true as const, value: undefined }),
      }),
    }) {
      if (
        message.type === "user" &&
        message.uuid &&
        receipts.has(message.uuid)
      ) {
        receipts.get(message.uuid)!.resolve();
        receipts.delete(message.uuid);
      }
      if (message.type === "system" && message.subtype === "init") {
        if (retained?.claude) retained.claude.sessionId = message.session_id;
        await emit({ type: "native_session", sessionId: message.session_id });
      }
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
        const consumed =
          message.user_message_uuids ??
          (message.user_message_uuid ? [message.user_message_uuid] : []);
        // Echoed inputs acknowledge admission, not completion. The installed SDK
        // reports exactly which client UUIDs a result consumed, including fold-ins.
        if (!consumed.length)
          throw new RuntimeError(
            "native_receipt_missing",
            "Claude did not identify the inputs completed by this result; their outcome is uncertain.",
          );
        for (const id of consumed) {
          unfinished.delete(id);
          if (id === initialId) await emit({ type: "input_accepted" });
          const receipt = receipts.get(id);
          if (receipt) {
            receipt.resolve();
            receipts.delete(id);
          }
        }
        if (!unfinished.size) {
          // Close admissions synchronously before releasing this execution.
          const settled = steering?.settle();
          if (!retained) inputStream.end();
          await settled;
          finished = true;
          break;
        }
      }
    }
    if (!finished)
      throw new RuntimeError(
        "agent_disconnected",
        "Claude disconnected before completing",
      );
  } finally {
    signal.removeEventListener("abort", abort);
    for (const receipt of receipts.values())
      receipt.reject(
        new RuntimeError(
          "steering_uncertain",
          "Claude ended before acknowledging input.",
        ),
      );
    await steering?.settle();
    if (!retained || !finished) {
      if (retained) delete retained.claude;
      inputStream.destroy();
      stream.close();
    }
  }
}

/** Pi uses its public SDK directly with the centrally configured inference gateway. */
export async function runPi(
  request: ContainerRequest,
  emit: EventSink,
  signal: AbortSignal,
  steering?: SteeringChannel,
  retained?: NativeSessionState,
): Promise<void> {
  if (retained?.pi) {
    const session = retained.pi as PiSession;
    try {
      return await drivePiSession(
        session,
        request,
        emit,
        signal,
        steering,
        true,
      );
    } catch (error) {
      delete retained.pi;
      session.dispose();
      throw error;
    }
  }
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
  await runtime.setRuntimeApiKey(
    "wovenmatter-enterprise",
    request.gateway.token,
  );
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
  if (retained) retained.pi = session;
  try {
    await drivePiSession(
      session,
      request,
      emit,
      signal,
      steering,
      Boolean(retained),
    );
  } catch (error) {
    if (retained) {
      delete retained.pi;
      session.dispose();
    }
    throw error;
  }
}

type PiSession = Pick<
  Awaited<
    ReturnType<
      typeof import("@earendil-works/pi-coding-agent").createAgentSession
    >
  >["session"],
  "subscribe" | "abort" | "prompt" | "clearQueue" | "sessionId" | "dispose"
>;
/** Keep the native subscription alive through admitted preflight and continuations. */
export async function drivePiSession(
  session: PiSession,
  request: ContainerRequest,
  emit: EventSink,
  signal: AbortSignal,
  steering?: SteeringChannel,
  retained = false,
) {
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
    const continuations: Promise<void>[] = [];
    await session.prompt(request.prompt, {
      preflightResult: (ok) => {
        if (signal.aborted) {
          session.clearQueue();
          signal.throwIfAborted();
        }
        if (ok) {
          push({ type: "input_accepted" });
          steering?.set(
            (input) =>
              new Promise<void>((resolve, reject) => {
                signal.throwIfAborted();
                const task = session.prompt(steeringText(input), {
                  streamingBehavior: "steer",
                  preflightResult: (accepted) => {
                    if (signal.aborted) {
                      session.clearQueue();
                      signal.throwIfAborted();
                    }
                    if (accepted) resolve();
                    else
                      reject(
                        new RuntimeError(
                          "steering_rejected",
                          "Pi rejected the input.",
                        ),
                      );
                  },
                });
                continuations.push(task);
                void task.catch(reject);
              }),
          );
        }
      },
    });
    await steering?.settle();
    while (continuations.length) await Promise.all(continuations.splice(0));
    await events;
    if (agentError)
      throw new RuntimeError(
        "agent_failed",
        "Pi did not finish the requested work",
      );
  } finally {
    signal.removeEventListener("abort", abort);
    await steering?.settle();
    unsubscribe();
    if (!retained) session.dispose();
  }
}
