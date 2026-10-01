import type { MountEvidence } from "./mount-evidence.ts";
export type Harness = "codex" | "claude" | "grok" | "pi";
export type Access = "read" | "write";
export type RuntimeEvent =
  | { type: "started" }
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
  | { type: "failed"; code: string; message: string };
export type EventSink = (event: RuntimeEvent) => Promise<void> | void;
/** Constructed only from trusted project/file authorization services, never browser input. */
export interface RuntimeMount {
  source: string;
  target: string;
  access: Access;
}
export interface RuntimeRequest {
  runId: string;
  organizationId: string;
  projectId: string;
  conversationId: string;
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
> & { mountEvidence?: MountEvidence[] };
export interface Runtime {
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
