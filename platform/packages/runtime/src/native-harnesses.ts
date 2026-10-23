import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { JsonRpcProcess, type RpcMessage } from "./rpc.js";
import { agentInstructions, runtimeEnvironment, egressEnvironment, type NativeSessionState } from "./native.js";
import { steeringText, type SteeringChannel } from "./steering.js";
import { RuntimeError, type ContainerRequest, type EventSink, type Harness } from "./types.js";
import { prepareAttachments, attachmentPrompt, openCodeFiles } from "./attachments.js";

const source = (name: string) => import(new URL(`./embedded/native-harnesses/${name}.mjs`, import.meta.url).href);
export const harnessCatalog = [
  { id: "pi", label: "Pi Durable", transport: "embedded", command: null },
  { id: "codex", label: "Codex", transport: "acp", command: "codex-acp" },
  { id: "claude_code", label: "Claude Code", transport: "acp", command: "claude-agent-acp" },
  { id: "grok_build", label: "Grok Build", transport: "agent-stdio", command: "grok" },
  { id: "opencode", label: "OpenCode", transport: "opencode-v2", command: "opencode" },
] as const;

/** Only local broker capabilities cross the namespace boundary. Never provider keys. */
export function nativeEnvironment(request: ContainerRequest, home = "/session/native-home") {
  const base = request.gateway.baseUrl.replace(/\/$/, "");
  const env: Record<string, string> = { ...runtimeEnvironment(home), ...egressEnvironment(request),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
    NO_BROWSER: "1", DISABLE_AUTOUPDATER: "1" };
  if (request.harness === "codex") Object.assign(env, {
    CODEX_HOME: join(home, ".codex"), OPENAI_API_KEY: request.gateway.token, MODEL_PROVIDER: "enterprise",
    DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }),
    CODEX_CONFIG: JSON.stringify({ model: request.model, model_provider: "enterprise", developer_instructions: agentInstructions,
      model_providers: { enterprise: { name: "Organization inference", base_url: base + "/v1", env_key: "OPENAI_API_KEY", wire_api: "responses" } } }),
  });
  if (request.harness === "claude_code") Object.assign(env, {
    CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_API_KEY: request.gateway.token, ANTHROPIC_BASE_URL: base,
    ANTHROPIC_MODEL: request.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: request.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: request.model, ANTHROPIC_DEFAULT_OPUS_MODEL: request.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  if (request.harness === "grok_build") Object.assign(env, {
    GROK_HOME: join(home, ".grok"), XAI_API_KEY: request.gateway.token,
    GROK_MODELS_BASE_URL: base + "/v1", GROK_XAI_API_BASE_URL: base + "/v1",
    GROK_DEFAULT_MODEL: request.model, GROK_DISABLE_AUTOUPDATER: "1",
  });
  if (request.harness === "opencode") env.WME_NATIVE_GATEWAY_TOKEN = request.gateway.token;
  return env;
}

export function nativeCommand(request: ContainerRequest) {
  const selected = harnessCatalog.find(item => item.id === request.harness)!;
  if (!selected?.command) throw new RuntimeError("invalid_harness", "Select a native harness.");
  const permission = request.native?.permission ?? "auto";
  if (request.harness === "grok_build" && !["default", "acceptEdits", "auto", "bypassPermissions", "dontAsk"].includes(permission))
    throw new RuntimeError("native_setting_unavailable", "This Grok permission is unavailable.");
  return { command: selected.command, args: request.harness === "grok_build"
    ? ["--permission-mode", permission, "--rules", agentInstructions, "agent", "--no-leader", "stdio"] : [] };
}

/** Grok's native BYOK configuration, scoped to this run's existing gateway.
 * Desktop inherits the user's model config; Enterprise supplies the same native
 * model protocol without placing organization credentials in the session. */
export function grokConfiguration(request: ContainerRequest): string {
  const api = request.pi?.api ?? "openai-responses";
  const backend = {"openai-responses": "responses", "openai-compatible": "chat_completions", "anthropic-messages": "messages"}[api];
  const quoted = (value: string) => JSON.stringify(value).replace(/\u007f/g, "\\u007f");
  const model = quoted(request.model);
  return `[models]\ndefault = ${model}\nsession_summary = ${model}\nimage_description = ${model}\nweb_search = ${model}\n\n` +
    `[model.${model}]\nmodel = ${model}\nbase_url = ${quoted(request.gateway.baseUrl.replace(/\/$/, "") + "/v1")}\n` +
    `env_key = "XAI_API_KEY"\napi_backend = "${backend}"\nsupports_backend_search = ${request.pi?.provider === "xai"}\n` +
    `supports_reasoning_effort = ${request.pi?.supportsReasoning === true}\n\n[cli]\nauto_update = false\n`;
}

type NativeState = { harness: Harness; rpc?: JsonRpcProcess; sessionId?: string; initial?: any; steering?: boolean; openCode?: any; poison?: string; permission?: string; launchIdentity?: string };
const failure = (code: string) => new RuntimeError(code, "The native operation was not confirmed; it was not replayed.");
const selections = (options: any[]): any[] => (options ?? []).flatMap(item => item.value != null ? [{id: String(item.value), label: item.name ?? String(item.value)}] : selections(item.options));
export function nativeSettings(initial: any, canSteer: boolean) {
  const model = initial.configOptions?.find((o: any) => o.id === "model" || o.category === "model");
  const thinking = initial.configOptions?.find((o: any) => ["effort", "thinking", "reasoning_effort"].includes(o.id) || o.category === "thought_level");
  const permission = initial.configOptions?.find((o: any) => ["permission_mode", "approval_mode", "mode"].includes(o.id));
  return { model: model?.currentValue ?? initial.models?.currentModelId, thinking: thinking?.currentValue,
    permission: permission?.currentValue ?? initial.modes?.currentModeId, models: model ? selections(model.options) : (initial.models?.availableModels ?? []).map((o: any) => ({id: o.modelId, label: o.name ?? o.modelId})),
    thinkingLevels: selections(thinking?.options), permissions: permission ? selections(permission.options) : (initial.modes?.availableModes ?? []).map((o: any) => ({id: o.id, label: o.name ?? o.id})), canSteer, canConfigure: true };
}
/** Desktop clientRunTokens contract: absent or invalid native accounting stays unknown. */
export function nativeRunTokens(result: any): number | undefined {
  const usage = result?.usage;
  if (!usage) return undefined;
  if (Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0) return usage.totalTokens;
  if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) return undefined;
  const values = [usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

/** Source: desktop client-execution-runtime + durable-acp. The trusted WorkspaceService
 * owns admission, receipts, attachment cursors and interruption fences in Enterprise. */
export async function runNative(request: ContainerRequest, emit: EventSink, signal: AbortSignal, channel: SteeringChannel,
  retained: NativeSessionState, options: { home?: string; launch?: (command: string, args: string[], env: Record<string,string>, cwd: string) => JsonRpcProcess; instances?: any } = {}) {
  const home = options.home ?? "/session/native-home";
  await mkdir(home, { recursive: true, mode: 0o700 });
  // Codex refuses CODEX_HOME unless it already exists. Create only the private
  // per-harness state directories; native tools never discover the host home.
  for (const directory of [".codex", ".claude", ".grok", ".config", ".local/share", ".local/state"])
    await mkdir(join(home, directory), {recursive: true, mode: 0o700});
  const files = await prepareAttachments(request.attachments, home);
  let state = retained.native as NativeState | undefined;
  if (state?.poison === request.runId) throw failure("native_outcome_uncertain");
  // An uncertain run identity cannot replay. A different explicit user run can
  // load its durable native history; native active-session checks still apply.
  if (state?.poison) state.poison = undefined;
  if (state && state.harness !== request.harness) throw failure("native_identity_changed");
  state ??= { harness: request.harness };
  retained.native = state;
  // Credential and raw native error material never enter the browser event journal.
  let output = Promise.resolve();
  const publish = (event: any) => {
    const safe = JSON.parse(JSON.stringify(event).replaceAll(request.gateway.token, "[redacted]"));
    output = output.then(async () => { await emit(safe); });
    return output;
  };
  const update = (value: any) => {
    if (value.sessionUpdate === "woven_native_record") return publish({type: "native_records", batch: value.recordBatch});
    if (value.sessionUpdate === "agent_message_chunk" && value.content?.type === "text") {
      if (!value._meta?.wovenAssistantSnapshot) void publish({type: "assistant_delta", delta: value.content.text});
    }
    return publish({ type: "native_update", update: value });
  };
  const interaction = (value: any) => update({sessionUpdate: "woven_interaction", interaction: value});
  const settings = (initial: any, canSteer: boolean) => {
    const value = nativeSettings(initial, canSteer);
    // Desktop LocalACPSessionPermissions supplies these native CLI modes:
    // Grok does not advertise them through ACP configOptions.
    if (request.harness === "grok_build") return {...value, permission: request.native?.permission ?? "auto", permissions: [
      {id: "default", label: "Ask for approval"}, {id: "acceptEdits", label: "Auto-accept edits"},
      {id: "auto", label: "Auto"}, {id: "dontAsk", label: "Don't ask"},
      {id: "bypassPermissions", label: "Full access"},
    ]};
    // Claude family aliases are private launch configuration; browser selection
    // uses the authorized organization catalog and its exact model IDs.
    return request.harness === "claude_code" ? {...value, model: request.model, models: []} : value;
  };
  if (request.harness === "opencode") {
    await runOpenCode(request, state, signal, channel, home, update, interaction, publish, openCodeFiles(files), options.instances);
    await output;
    return;
  }
  const { applyTaskConfiguration } = await source("configuration");
  const { clientInteraction, clientInteractionResponse } = await source("client-interactions");
  const callbacks = new Map<string, RpcMessage>();
  let submitted = false;
  try {
    const launchIdentity = JSON.stringify([request.model, request.pi?.api, request.harness === "grok_build" ? request.native?.permission : null]);
    if (state.rpc && state.launchIdentity !== launchIdentity) {
      state.rpc.close(); await state.rpc.stopped; state.rpc = undefined;
    }
    if (!state.rpc) {
      if (request.harness === "grok_build")
        await writeFile(join(home, ".grok/config.toml"), grokConfiguration(request), {mode: 0o600});
      const {command, args} = nativeCommand(request);
      state.rpc = (options.launch ?? ((...args) => new JsonRpcProcess(...args)))(command, args, nativeEnvironment(request, home), request.workingDirectory);
      state.permission = request.native?.permission;
      state.launchIdentity = launchIdentity;
      const initialized = await state.rpc.request("initialize", {protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false, elicitation: {form: {}}}, clientInfo: {name: "WovenMatter Enterprise", version: "1"}});
      if (initialized.protocolVersion !== 1) throw failure("native_protocol_unsupported");
      state.steering = initialized._meta?.steering?.supported === true;
      const params = {cwd: request.workingDirectory, mcpServers: [], ...(request.resumeId ? {sessionId: request.resumeId} : {}),
        ...(request.harness === "claude_code" ? {_meta: {systemPrompt: {append: agentInstructions}}} : {})};
      state.initial = await state.rpc.request(request.resumeId ? "session/load" : "session/new", params);
      // ACP LoadSessionResponse does not require sessionId. A successful load
      // confirms the requested identity; reject any explicit conflicting identity.
      const id = state.initial.sessionId ?? request.resumeId;
      if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(id) || (request.resumeId && id !== request.resumeId)) throw failure("native_identity_changed");
      state.sessionId = id;
    }
    if (request.resumeId && state.sessionId !== request.resumeId) throw failure("native_identity_changed");
    if (request.harness === "grok_build" && state.permission !== request.native?.permission) throw failure("native_restart_required");
    const rpc = state.rpc!, sessionId = state.sessionId!;
    rpc.onMessage = async message => {
      if (message.params?.sessionId && message.params.sessionId !== sessionId) throw failure("native_identity_changed");
      if (message.method === "session/update") {
        const value = message.params.update;
        if (value.sessionUpdate === "config_option_update") {
          state!.initial = {...state!.initial, configOptions: value.configOptions};
          await update({sessionUpdate: "woven_native_settings", settings: settings(state!.initial, request.harness === "grok_build" || !!state!.steering)});
        }
        await update(value);
      } else if (message.id != null && ["session/request_permission", "elicitation/create"].includes(message.method ?? "")) {
        try {
          const id = String(message.id) + ":" + createHash("sha256").update(JSON.stringify(message)).digest("hex");
          const view = message.method === "elicitation/create" ? clientInteraction(message) : {kind: "approval", title: message.params?.toolCall?.title ?? "Agent needs approval", options: (message.params?.options ?? []).map((o: any) => ({id: o.optionId, label: o.name})), questions: []};
          callbacks.set(id, message);
          await interaction({id, ...view});
        } catch {
          rpc.send({id: message.id, error: {code: -32602, message: "Unsupported interaction schema."}});
        }
      } else if (message.method && message.id != null) rpc.send({id: message.id, error: {code: -32601, message: "Client operation unavailable."}});
    };
    const configure = async (method: string, params: unknown) => {
      const result = await rpc.request(method, params);
      state!.initial = {...state!.initial, ...result};
      return result;
    };
    const modelOption = state.initial.configOptions?.find((option: any) => option.id === "model" || option.category === "model");
    // Claude advertises family aliases when ANTHROPIC_DEFAULT_*_MODEL points to
    // an organization model. All three aliases are explicitly bound to this
    // run's gateway model above; never send an unrelated catalog model.
    const advertised = selections(modelOption?.options).map(option => option.id);
    const nativeModel = request.harness === "claude_code" && !advertised.includes(request.model) && advertised.includes("sonnet") ? "sonnet" : request.model;
    await applyTaskConfiguration(configure, sessionId, state.initial, {runtimeKind: request.harness, model: nativeModel, ...request.native});
    await publish({type: "native_session", sessionId});
    await update({sessionUpdate: "woven_native_settings", settings: settings(state.initial, request.harness === "grok_build" || !!state.steering)});
    if (signal.aborted) throw failure("native_cancelled");
    const cancel = () => { try { rpc.send({method: "session/cancel", params: {sessionId}}); } catch {} };
    signal.addEventListener("abort", cancel, {once: true});
    try {
      // Submit the root first. Opening steering before this write can reorder inputs.
      const completion = rpc.request("session/prompt", {sessionId, prompt: attachmentPrompt(request.prompt, files), _meta: {wovenRunID: request.runId}}, 24 * 3600_000);
      submitted = true;
      channel.set(async input => {
        const response = input.nativeResponse;
        if (response) {
          const pending = callbacks.get(response.interactionId);
          if (!pending) throw failure("native_interaction_expired");
          if (!response.cancelled && pending.method === "session/request_permission" && !(pending.params.options ?? []).some((o: any) => o.optionId === response.optionID)) throw failure("native_response_invalid");
          let result;
          try { result = pending.method === "elicitation/create" ? clientInteractionResponse(pending, response) : {outcome: response.cancelled ? {outcome: "cancelled"} : {outcome: "selected", optionId: response.optionID}}; }
          catch { throw failure("native_response_invalid"); }
          rpc.send({id: pending.id, result}); callbacks.delete(response.interactionId);
          await update({sessionUpdate: "woven_interaction_resolved", id: response.interactionId});
          return;
        }
        const files = await prepareAttachments(input.attachments, home);
        if (request.harness === "grok_build") {
          // Desktop LocalACPClient:1297–1301 uses a concurrent prompt for files.
          if (files.length) await rpc.request("session/prompt", {sessionId, prompt: attachmentPrompt(steeringText(input), files), _meta: {wovenRunID: request.runId}}, 24 * 3600_000);
          else await rpc.request("_x.ai/interject", {sessionId, text: steeringText(input)});
          return;
        }
        if (!state!.steering) throw failure("steering_unavailable");
        const result = await rpc.request("_session/steering", {sessionId, prompt: attachmentPrompt(steeringText(input), files), _meta: {wovenRunID: request.runId, steering: {idleBehavior: "promptRequired"}}});
        if (!["injected", "startedNewTurn"].includes(result.outcome)) throw failure("steering_rejected");
      });
      // ACP has no distinct root admission acknowledgement; only completion proves it.
      const result = await Promise.race([completion, rpc.closed]);
      await rpc.flush();
      const totalTokens = nativeRunTokens(result);
      if (totalTokens !== undefined) await update({sessionUpdate: "woven_usage", usage: {totalTokens}});
      await publish({type: "input_accepted"});
      if (result?.stopReason === "cancelled" && !signal.aborted) throw failure("native_cancelled");
    } finally { signal.removeEventListener("abort", cancel); }
    await output;
  } catch (error) {
    if (submitted) state.poison = request.runId;
    state.rpc?.close(); state.rpc = undefined;
    throw error;
  }
}

async function runOpenCode(request: ContainerRequest, state: NativeState, signal: AbortSignal, channel: SteeringChannel, home: string,
  update: (v: any) => Promise<void>, interaction: (v: any) => Promise<void>, publish: (v: any) => Promise<void>, files: ReturnType<typeof openCodeFiles>, supplied?: any) {
  const environment = nativeEnvironment(request, home);
  const directory = join(home, ".config/opencode");
  await mkdir(directory, {recursive: true, mode: 0o700});
  const api = request.pi?.api ?? "openai-responses";
  const providerPackage = api === "anthropic-messages" ? "anthropic-compatible" : api === "openai-compatible" ? "openai-compatible" : "openai-compatible/responses";
  await writeFile(join(directory, "opencode.json"), JSON.stringify({update: "disable", model: "enterprise/" + request.model, instructions: ["/opt/runtime/AGENTS.md"],
    providers: {enterprise: {name: "Organization inference", env: ["WME_NATIVE_GATEWAY_TOKEN"], package: "@opencode/ai/providers/" + providerPackage,
      settings: {baseURL: request.gateway.baseUrl.replace(/\/$/, "") + "/v1", encoding: "none"}, models: {[request.model]: {name: request.model}}}}}), {mode: 0o600});
  const registrationPath = join(environment.XDG_STATE_HOME!, "opencode/service.json");
  state.openCode ??= {child: null};
  const instances = supplied ?? {registrationPath, async action() {
    if (state.openCode.child) return;
    const child = spawn("opencode", ["serve", "--service", "--hostname", "127.0.0.1"], {cwd: request.workingDirectory, env: environment, stdio: "ignore"});
    state.openCode.child = child;
    child.once("close", () => {if (state.openCode.child === child) state.openCode.child = null;});
    let failed = false; child.on("error", () => {failed = true;});
    for (let count = 0; count < 120; count++) {
      if (failed || child.exitCode !== null) throw failure("harness_unavailable");
      try {
        const record = JSON.parse(await readFile(registrationPath, "utf8"));
        const origin = new URL(record.url);
        if (record.pid === child.pid && origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) && !origin.username && !origin.password && typeof record.password === "string") {
          // Registration can precede the actual listener. Desktop instance
          // startup confirms service health before handing out its connection.
          const response = await fetch(new URL("/api/info", origin), {headers: {authorization: "Basic " + Buffer.from("opencode:" + record.password).toString("base64")}, redirect: "error", signal: AbortSignal.timeout(1000)});
          if (response.ok && (await response.json()).pid === child.pid) return;
        }
      } catch {}
      await wait(250);
    }
    throw failure("native_start_uncertain");
  }};
  const {createNativeClientSessions} = await source("client-native-sessions");
  const {createNativeTaskExecutor} = await source("task-gateway-native");
  const sessions = createNativeClientSessions({workspaceRoot: request.workingDirectory, instances});
  const native = await sessions.perform("opencode", {sessionID: state.sessionId ?? request.resumeId, nativeWorkingDirectory: request.workingDirectory}, request.resumeId ? "adopt" : "create");
  state.sessionId = native.sessionID;
  await publish({type: "native_session", sessionId: native.sessionID});
  const settings = await sessions.perform("opencode", native, "configure", {model: "enterprise/" + request.model, ...request.native});
  await update({sessionUpdate: "woven_native_settings", settings: {...settings, canSteer: true}});
  const execute = createNativeTaskExecutor({workspaceRoot: request.workingDirectory, instances});
  try {
    await execute({run: {id: request.runId, title: request.prompt.slice(0, 100), task: {prompt: request.prompt, configuration: {runtimeKind: "opencode", nativeWorkingDirectory: request.workingDirectory}}},
      nativeSessionID: native.sessionID, files, signal, publish: update, bindSession: (id: string) => {if (id !== native.sessionID) throw failure("native_identity_changed");},
      interactive: {publish: interaction, bind: (control: any) => { channel.set(async input => {
        if (!input.nativeResponse) {
          const files = await prepareAttachments(input.attachments, home);
          try { await control.submit({id: "msg_" + createHash("sha256").update(input.id).digest("hex"), text: steeringText(input), files: openCodeFiles(files)}); }
          catch { state.poison = request.runId; throw failure("native_outcome_uncertain"); }
          return;
        }
        try { await control.respond(input.nativeResponse.interactionId, input.nativeResponse); }
        catch (error) {
          const code = (error as any).code;
          if (["native_response_invalid", "native_interaction_expired"].includes(code)) throw failure(code);
          throw error;
        }
        await update({sessionUpdate: "woven_interaction_resolved", id: input.nativeResponse.interactionId});
      }); }}});
    await publish({type: "input_accepted"});
  } catch (error) { if (!(error as any).beforePrompt) state.poison = request.runId; throw error; }
}
