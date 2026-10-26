import type { MountEvidence } from "./mount-evidence.ts";
export type Harness = "pi" | "codex" | "claude_code" | "grok_build" | "opencode";
export type NativeOptions = { thinking?: string; permission?: string };
export type NativeResponse = { interactionId: string; cancelled?: boolean; optionID?: string; answers?: Record<string, string[]> };
/** Authorized immutable bytes, resolved by the API; never a browser or host path. */
export type RuntimeAttachment = { name: string; mimeType: string; data: string };
export type Access = "read" | "write";
export type RuntimeEvent = { sequence?: number } & (
  | { type: "attached"; terminal?: boolean }
  | { type: "started" }
  | { type: "input_accepted" }
  | { type: "native_session"; sessionId: string }
  | { type: "assistant_delta"; delta: string }
  | { type: "assistant_snapshot"; text: string }
  | { type: "native_update"; update: Record<string, unknown> }
  | { type: "native_records"; batch: Record<string, unknown> }
  | {
      type: "citation";
      fileId: string;
      versionId: string;
      page?: number;
      label?: string;
    }
  | {
      type: "tool_start" | "tool_end";
      tool: string;
      toolId: string;
      status?: string;
    }
  | { type: "completed" }
  | { type: "cancelled" }
  | { type: "failed"; code: string; message: string }
);
export type EventSink = (event: RuntimeEvent) => Promise<void> | void;
/** Constructed only from trusted project/file authorization services, never browser input. */
export interface RuntimeMount {
  source: string;
  target: string;
  access: Access;
}
export interface RuntimeRequest {
  /** Dedicated asset draft capability; never inferred from shared project access. */
  assetId?: string;
  workspaceLease?: number;
  runId: string;
  organizationId: string;
  projectId: string;
  conversationId: string;
  /** Monotonic thread authority fence, assigned by the API, never an agent. */
  generation?: number;
  userId?: string;
  connectionId?: string;
  harness: Harness;
  model: string;
  prompt: string;
  attachments?: RuntimeAttachment[];
  access: Access;
  mounts: RuntimeMount[];
  /** Host directory outside user-editable volumes. Native history only, no upstream credentials. */
  sessionDirectory: string;
  /** Storage lineage retained when legacy read sessions gain full workspace access. */
  sessionStorageAccess?: Access;
  /** Trusted container path fixed by the first accepted send. */
  workingDirectory: string;
  workingDirectoryIdentity?: { device: string; inode: string };
  gateway: { baseUrl: string; token: string };
  /** Trusted credential-free internal proxy origin. Omit to disable public egress. */
  egressProxyUrl?: string;
  resumeId?: string;
  native?: NativeOptions;
  pi?: {
    codeMode?: "on" | "only" | "off";
    subagentConcurrency?: number;
    thinking?: string;
    sdkGeneration?: string;
    provider?: "openai" | "anthropic" | "xai" | "openrouter" | "custom";
    api?: "openai-responses" | "anthropic-messages" | "openai-compatible";
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsNativeCompaction?: boolean;
    supportsImages?: boolean;
    supportsReasoning?: boolean;
    thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
    defaultThinkingLevel?: string;
    modelCompat?: { forceAdaptiveThinking?: boolean };
    routeIdentity?: string;
    accountAffinity?: "proxy-session-affinity";
  };
}
/** The only values sent to the isolated container. No host paths or management secrets. */
export type ContainerRequest = Pick<
  RuntimeRequest,
  | "workingDirectory"
  | "workingDirectoryIdentity"
  | "runId"
  | "projectId"
  | "harness"
  | "model"
  | "prompt"
  | "attachments"
  | "access"
  | "gateway"
  | "egressProxyUrl"
  | "resumeId"
  | "assetId"
  | "pi"
  | "native"
> & { mountEvidence?: MountEvidence[] };
export interface SteeringInput {
  /** Native interaction response; shares the durable admission receipt lane. */
  nativeResponse?: NativeResponse;
  id: string;
  sequence: number;
  authorId: string;
  authorName: string;
  content: string;
  attachments?: RuntimeAttachment[];
}
export interface ProjectRuntimeSpec {
  /** Absent means a project. Asset IDs use a distinct asset- namespace on the legacy wire. */
  owner?: { kind: "asset"; assetId: string };
  workspaceLease?: number;
  projectId: string;
  organizationId: string;
  hostId: string;
  egressProxyUrl?: string;
  egressToken?: string;
  scheduleEnabled?: boolean;
  scheduleMounts?: RuntimeMount[];
}
export type RuntimeSDKCatalogDTO = {
  bundledGeneration: string;
  defaultGeneration: string;
  items: Array<{
    id: string;
    label: string;
    piVersion: string;
    status: "approved";
    bundled?: boolean;
    provenance?: {
      sourceCommit?: string;
      builtAt?: string;
      builder?: string;
    };
    integrity: {
      algorithm: "sha256";
      manifest: string;
    };
  }>;
};
export interface Runtime {
  /** Attach to an existing isolated browser; never starts or replays an agent turn. */
  browser?(projectId:string,conversationId:string,input:Record<string,unknown>):Promise<unknown>;
  /** Read approved Pi SDK generations for a placed project without starting its container. */
  sdkCatalog?(projectId: string): Promise<RuntimeSDKCatalogDTO>;
  /** Release only idle asset compute, conditional on the current workspace lease. Keep durable state. */
  releaseAsset?(spec: ProjectRuntimeSpec): Promise<void>;
  ensureProject?(spec: ProjectRuntimeSpec): Promise<void>;
  updateProject?(spec: ProjectRuntimeSpec): Promise<void>;
  stopProject?(spec: ProjectRuntimeSpec): Promise<void>;
  restoreProject?(spec: ProjectRuntimeSpec): Promise<void>;
  purgeProject?(spec: ProjectRuntimeSpec): Promise<void>;
  steer?(runId: string, input: SteeringInput): Promise<void>;
  /** Attach only. Never creates a native process or resubmits an input. */
  attach?(
    runId: string,
    after: number,
    emit: EventSink,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Called only after output and its cursor commit in the API database. */
  acknowledge?(runId: string, cursor: number): Promise<void>;
  /** Stop all retained environments owned by this thread, including idle descendants. */
  stopSession?(
    projectId: string,
    conversationId: string,
    generation: number,
  ): Promise<void>;
  execute(
    request: RuntimeRequest,
    emit: EventSink,
    signal?: AbortSignal,
  ): Promise<void>;
  cancel(runId: string): Promise<void>;
  recover(): Promise<string[]>;
}
export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}
