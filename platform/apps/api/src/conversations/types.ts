import type { Runtime } from "@wovenmatter-enterprise/runtime";
import type { AppContext, User } from "../context.js";
export type Harness = "pi";
export type Mode = "read" | "write";
export interface ConversationRow {
  pi_options?: string;
  runtime_generation?: number;
  id: string;
  org_id: string;
  project_id: string | null;
  asset_id?: string | null;
  creator_id: string;
  title: string;
  mode: Mode;
  harness: Harness;
  model: string;
  connection_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
export interface RunRow {
  runtime_generation?: number;
  id: string;
  conversation_id: string;
  org_id: string;
  project_id: string | null;
  asset_id?: string | null;
  user_id: string;
  request_id: string;
  user_message_id: string;
  assistant_message_id: string;
  status: string;
  mode: Mode;
  harness: Harness;
  model: string;
  connection_id: string | null;
  native_session_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}
export interface MessageRow {
  content_truncated?: number;
  activity_count?: number;
  id: string;
  request_id?: string;
  conversation_id: string;
  run_id: string;
  role: "user" | "assistant";
  kind?: string;
  delivery?: string;
  sequence?: number;
  error?: string | null;
  author_id: string | null;
  author_name?: string | null;
  content: string;
  citations: string;
  created_at: string;
}
export interface EventRow {
  id: number;
  conversation_id: string;
  run_id: string | null;
  type: string;
  data: string;
  created_at: string;
}
export interface ConversationDependencies {
  assets?: import("../assets/service.js").AssetAgentService;
  runtime: Runtime;
  files: {
    resolveProjectMounts(
      ctx: AppContext,
      user: User,
      projectId: string,
      mode: Mode,
    ): Promise<
      { source: string; target: string; readOnly: boolean; fileId?: string }[]
    >;
    reconcileProjectFiles(ctx: AppContext, projectId: string): Promise<unknown>;
    captureProjectManifest?(
      ctx: AppContext,
      user: User,
      projectId: string,
    ): Promise<{ fileId: string; path: string; versionId: string }[]>;
  };
  inference: {
    resolvePiModel?(
      orgId: string,
      model: string,
    ): Promise<
      NonNullable<
        import("../../../../packages/runtime/src/types.js").RuntimeRequest["pi"]
      >
    >;
    issueGateway(input: {
      orgId: string;
      projectId: string;
      assetId?: string;
      userId: string;
      runId: string;
      model?: string;
      harness?: string;
      connectionId?: string;
      conversationId?: string;
    }): Promise<{ baseUrl: string; token: string }>;
    revokeGateway(runId: string): Promise<void>;
    validateSelection(
      orgId: string,
      model: string,
      harness: string,
      connectionId?: string,
    ): Promise<void>;
    models?(
      orgId: string,
    ): Promise<Array<{ id: string; thinkingLevels?: string[] }>>;
  };
  recheckIntervalMs?: number;
  maxConcurrentRuns?: number;
  maxConcurrentRunsPerOrganization?: number;
}
export function conversationView(c: ConversationRow) {
  return {
    id: c.id,
    orgId: c.org_id,
    projectId: c.project_id,
    assetId: c.asset_id ?? null,
    createdBy: c.creator_id,
    title: c.title,
    mode: c.mode,
    harness: c.harness,
    pi: JSON.parse(c.pi_options ?? "{}"),
    model: c.model,
    connectionId: c.connection_id,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}
export function runView(r: RunRow) {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    userId: r.user_id,
    requestId: r.request_id,
    messageId: r.user_message_id,
    assistantMessageId: r.assistant_message_id,
    status: r.status,
    mode: r.mode,
    harness: r.harness,
    model: r.model,
    nativeSessionId: r.native_session_id,
    error: r.error_code
      ? { code: r.error_code, message: r.error_message }
      : null,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}
export function messageView(m: MessageRow) {
  return {
    id: m.id,
    requestId: m.request_id,
    conversationId: m.conversation_id,
    runId: m.run_id,
    role: m.role,
    kind: m.kind ?? "message",
    delivery: m.delivery,
    sequence: m.sequence,
    error: m.error,
    authorId: m.author_id,
    authorName: m.author_name ?? null,
    content: m.content,
    contentTruncated: Boolean(m.content_truncated),
    activityCount: m.activity_count ?? undefined,
    citations: JSON.parse(m.citations),
    createdAt: m.created_at,
  };
}
export function eventView(e: EventRow) {
  return {
    id: e.id,
    conversationId: e.conversation_id,
    runId: e.run_id,
    type: e.type,
    data: JSON.parse(e.data),
    createdAt: e.created_at,
  };
}
