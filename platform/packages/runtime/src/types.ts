import type { MountEvidence } from "./mount-evidence.ts";
export type Harness = "codex" | "claude" | "grok" | "pi";
export type Access = "read" | "write";
export type RuntimeEvent = { sequence?: number } & (
  | { type: "attached"; terminal?: boolean }
  | { type: "started" }
  | { type: "input_accepted" }
  | { type: "native_session"; sessionId: string }
  | { type: "assistant_delta"; delta: string }
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
  access: Access;
  mounts: RuntimeMount[];
  /** Host directory outside user-editable volumes. Native history only, no upstream credentials. */
  sessionDirectory: string;
  gateway: { baseUrl: string; token: string };
  /** Trusted credential-free internal proxy origin. Omit to disable public egress. */
  egressProxyUrl?: string;
  resumeId?: string;
}
/** The only values sent to the isolated container. No host paths or management secrets. */
export type ContainerRequest = Pick<
  RuntimeRequest,
  | "runId"
  | "projectId"
  | "harness"
  | "model"
  | "prompt"
  | "access"
  | "gateway"
  | "egressProxyUrl"
  | "resumeId"
  | "assetId"
> & { mountEvidence?: MountEvidence[] };
export interface SteeringInput {
  id: string;
  sequence: number;
  authorId: string;
  authorName: string;
  content: string;
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
export interface Runtime {
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
