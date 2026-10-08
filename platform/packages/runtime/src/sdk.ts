import { randomUUID } from "node:crypto";
import { SteeringChannel, steeringText } from "./steering.js";
import { mkdir } from "node:fs/promises";
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
import { runEnterprisePi } from "./embedded/enterprise-pi.ts";

function textUpdate(
  harness: "claude",
  text: string,
  id?: string,
  snapshot = false,
): RuntimeEvent {
  return {
    type: "native_update",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      _meta: {
        harness,
        ...(id ? { nativeMessageID: id } : {}),
        ...(snapshot ? { nativeMessageSnapshot: true } : {}),
      },
    },
  };
}

function toolUpdate(
  harness: "claude",
  phase: "tool_call" | "tool_call_update",
  tool: string,
  toolId: string,
  status?: string,
  native?: Record<string, any>,
): RuntimeEvent {
  return {
    type: "native_update",
    update: {
      sessionUpdate: phase,
      toolCallId: toolId,
      title: tool,
      kind: tool === "Bash" ? "execute" : tool,
      ...(status ? { status } : {}),
      ...(native
        ? phase === "tool_call"
          ? { rawInput: native.input }
          : {
              rawOutput: native,
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text:
                      typeof native.content === "string"
                        ? native.content
                        : Array.isArray(native.content)
                          ? native.content
                              .map((part: any) =>
                                typeof part.text === "string" ? part.text : "",
                              )
                              .join("\n")
                          : "",
                  },
                },
              ],
            }
        : {}),
      _meta: { harness },
    },
  };
}

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
  const streamedMessages = new Map<string, string>();
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
          event.delta.type === "thinking_delta"
        )
          await emit({
            type: "native_update",
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: event.delta.thinking },
              _meta: {
                harness: "claude",
                wovenThoughtID: currentMessageId + ":" + event.index,
              },
            },
          });
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          streamedMessages.set(
            currentMessageId,
            (streamedMessages.get(currentMessageId) ?? "") + event.delta.text,
          );
          await emit(textUpdate("claude", event.delta.text, currentMessageId));
          await emit({ type: "assistant_delta", delta: event.delta.text });
        }
      }
      if (message.type === "assistant") {
        const id = message.message.id;
        const text = message.message.content
          .filter((block: any) => block.type === "text")
          .map((block: any) => block.text)
          .join("");
        const previous = streamedMessages.get(id);
        if (text || previous !== undefined) {
          streamedMessages.set(id, text);
          if (previous === undefined) {
            await emit(textUpdate("claude", text, id));
            await emit({ type: "assistant_delta", delta: text });
          } else if (previous !== text) {
            await emit(textUpdate("claude", text, id, true));
          }
        }
        for (const [index, block] of message.message.content.entries()) {
          if (block.type === "thinking" && typeof block.thinking === "string")
            await emit({
              type: "native_update",
              update: {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: block.thinking },
                _meta: {
                  harness: "claude",
                  wovenThoughtID: id + ":" + index,
                  wovenThoughtSnapshot: true,
                  wovenThoughtStatus: "completed",
                },
              },
            });
          if (block.type === "tool_use") {
            toolNames.set(block.id, block.name);
            await emit(
              toolUpdate(
                "claude",
                "tool_call",
                block.name,
                block.id,
                undefined,
                block,
              ),
            );
            await emit({
              type: "tool_start",
              tool: block.name,
              toolId: block.id,
            });
          }
        }
        await emit({
          type: "native_update",
          update: { sessionUpdate: "woven_assistant_boundary" },
        });
      }
      if (
        message.type === "user" &&
        typeof message.message.content !== "string"
      )
        for (const block of message.message.content) {
          if (block.type === "tool_result") {
            await emit(
              toolUpdate(
                "claude",
                "tool_call_update",
                toolNames.get(block.tool_use_id) ?? "tool",
                block.tool_use_id,
                block.is_error ? "failed" : "completed",
                block,
              ),
            );
            await emit({
              type: "tool_end",
              tool: toolNames.get(block.tool_use_id) ?? "tool",
              toolId: block.tool_use_id,
              status: block.is_error ? "failed" : "completed",
            });
          }
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
  await runEnterprisePi(request, emit, signal, steering, retained);
}
