import { NativeControls } from "./native-controls";
import { WorkspaceDetails, WorkspaceNotePanel } from "../shell/WorkspaceDetails";
import { agents, agentName, acceptsModel } from "../agents";
import {
  ConversationRunWork,
  NativeChecklist,
  NativeHistory,
  useConversationActivities,
} from "./ConversationWork";
import type { Activity } from "../activity-state";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  FolderOpen,
  MessageSquare,
  Settings,
  Square,
  Trash2,
} from "lucide-react";
import {
  api,
  ApiError,
  date,
  errorMessage,
  providerNames,
  send,
  useResource,
  type List,
  type Project,
  type Model,
  type Run,
  type Conversation,
  type WorkspaceFolder,
} from "../api";
import { useWorkspace } from "../workspace";
import { useSearchParams } from "react-router-dom";
import {
  workspaceChanged,
  useWorkspaceChanges,
  readWorkspaceValue,
  writeWorkspaceValue,
} from "../workspace-events";
import { ContentLink, RichText } from "../components/RichText";
import { useCopyFeedback } from "../components/useCopyFeedback";
import {
  Icon,
  Menu,
  MenuItem,
  MenuLink,
  MenuSeparator,
  Picker,
  type PickerOption,
} from "../components/controls";
import {
  mergeMessages,
  emptyAssistantLabel,
  loadPendingMessage,
  savePendingMessage,
  clearPendingMessage,
  settleConversationInput,
  loadConversationDraft,
  saveConversationDraft,
} from "../conversation-state";
import {
  AsyncForm,
  Confirm,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  PageHeader,
  Status,
} from "../components/ui";
export type { Model, Conversation } from "../api";
type Message = {
  id: string;
  requestId?: string;
  role: "user" | "assistant";
  authorId: string;
  authorName: string;
  content: string;
  contentTruncated?: boolean;
  activityCount?: number;
  runId: string;
  createdAt: string;
  kind?: "message" | "comment";
  delivery?: string;
  error?: string;
  citations?: {
    fileId?: string;
    page?: number;
    label?: string;
    url?: string;
    versionId?: string;
  }[];
};
type Messages = List<Message> & {
  hasMore: boolean;
  nextBefore: string | null;
};
const activeStatuses = new Set([
  "queued",
  "dispatching",
  "running",
  "cancelling",
]);
export function ConversationsPage({ project }: { project: Project }) {
  const { org, user } = useWorkspace();
  const agentDefaults = useResource<{ defaultHarness: string }>(`/enterprise/api/projects/${project.id}/agent-settings`);
  const list = useResource<List<Conversation>>(
    `/enterprise/api/projects/${project.id}/conversations`,
  );
  const models = useResource<List<Model>>(
    `/enterprise/api/organizations/${org.id}/inference/models`,
    60_000,
  );
  useWorkspaceChanges(list.reload);
  const folders = useResource<List<WorkspaceFolder>>(
    `/enterprise/api/projects/${project.id}/folders`,
    10000,
  );
  useWorkspaceChanges(folders.reload);
  const [query, setQuery] = useSearchParams();
  const requestedConversation = query.get("conversation") ?? undefined;
  const conversationId =
    requestedConversation &&
    list.data?.items.some((c) => c.id === requestedConversation)
      ? requestedConversation
      : undefined;
  const creating = query.get("new") === "1";
  useEffect(() => {
    if (requestedConversation) list.reload();
  }, [requestedConversation, list.reload]);
  const selectionKey = `wme:selected:${user.id}:${project.id}`;
  useEffect(() => {
    if (conversationId) writeWorkspaceValue(selectionKey, conversationId);
  }, [conversationId, selectionKey]);
  useEffect(() => {
    if (
      requestedConversation ||
      creating ||
      !list.data ||
      query.has("folder") ||
      query.has("trash")
    )
      return;
    const previous = readWorkspaceValue(selectionKey);
    if (previous && list.data.items.some((c) => c.id === previous))
      setQuery({ conversation: previous }, { replace: true });
  }, [requestedConversation, creating, list.data, selectionKey, setQuery]);
  function select(id?: string, folderId?: string | null) {
    const next = new URLSearchParams(query);
    next.delete("new");
    if (folderId !== undefined) next.set("folder", folderId ?? "all");
    if (id) next.set("conversation", id);
    else next.delete("conversation");
    setQuery(next);
  }
  function closeCreate() {
    const next = new URLSearchParams(query);
    next.delete("new");
    setQuery(next, { replace: true });
  }
  if (query.get("trash") === "1")
    return <ConversationTrash project={project} />;
  const selectedFolder = folders.data?.items.find(
    (f) => f.id === query.get("folder"),
  );
  return (
    <div className={`conversation-layout ${query.has("note") ? "has-note" : ""}`}>
      <div className="conversation-main">
        {conversationId ? (
          <Thread
            key={conversationId}
            id={conversationId}
            project={project}
            models={models.data?.items ?? []}
            refresh={workspaceChanged}
            onDeleted={() => {
              writeWorkspaceValue(selectionKey, "");
              select();
              workspaceChanged();
            }}
          />
        ) : requestedConversation ? (
          (!list.data || list.loading) && !list.error ? (
            <Loading />
          ) : (
            <ErrorNotice
              message={
                list.error ||
                "This conversation is unavailable in this workspace."
              }
            />
          )
        ) : !agentDefaults.data && agentDefaults.loading ? <Loading /> : (
          <WorkspaceWelcome key={query.get("agent") ?? agentDefaults.data?.defaultHarness ?? "loading"} title={selectedFolder?.name ?? project.name} initialAgent={query.get("agent") ?? agentDefaults.data?.defaultHarness ?? "pi"} models={models.data?.items ?? []} onStart={async (harness, model, content) => {
            const chat = await send<Conversation>(`/enterprise/api/projects/${project.id}/conversations`, { harness, model: model || undefined, folderId: selectedFolder?.id ?? null, mode: "write" });
            const draftKey = `wme:draft:${user.id}:${chat.id}`, pendingKey = `wme:pending:${user.id}:${chat.id}`;
            const pending = { id: crypto.randomUUID(), content, kind: "message" as const };
            saveConversationDraft(draftKey, content, "message"); savePendingMessage(pendingKey, pending);
            try { await send(`/enterprise/api/conversations/${chat.id}/messages`, { content, kind: "message", requestId: pending.id }); settleConversationInput(pendingKey, draftKey, pending); } catch { /* Retained pending request is safely retried in the thread. */ }
            select(chat.id, chat.folderId); workspaceChanged();
          }} />
        )}
        {!conversationId ? <ErrorNotice message={list.error} /> : null}
      </div>
      {query.get("note") ? <WorkspaceNotePanel projectId={project.id} noteId={query.get("note")!} onClose={() => { const next = new URLSearchParams(query); next.delete("note"); setQuery(next); }} /> : null}
      <WorkspaceDetails project={project} chats={list.data?.items ?? []} folderName={selectedFolder?.name} />
      {creating ? (
        <Modal title="New conversation" compact onClose={closeCreate}>
          {!folders.data || (!agentDefaults.data && agentDefaults.loading) ? (
            <>
              <Loading />
              <ErrorNotice message={folders.error || agentDefaults.error} />
            </>
          ) : query.get("folder") &&
            query.get("folder") !== "all" &&
            !folders.data.items.some((f) => f.id === query.get("folder")) ? (
            <ErrorNotice message="This folder is unavailable. Choose All Workspaces or another folder." />
          ) : (
            <ConversationForm
              project={project}
              folders={folders.data?.items}
              initialFolder={query.get("folder")}
              initialAgent={query.get("agent") ?? agentDefaults.data?.defaultHarness}
              onCancel={closeCreate}
              onSave={async (body) => {
                const navigationTarget = window.location.href;
                const c = await send<Conversation>(
                  `/enterprise/api/projects/${project.id}/conversations`,
                  body,
                );
                if (window.location.href === navigationTarget)
                  select(c.id, c.folderId);
                workspaceChanged();
              }}
            />
          )}
        </Modal>
      ) : null}
    </div>
  );
}
function WorkspaceWelcome({ title, initialAgent, models, onStart }: { title: string; initialAgent: string; models: Model[]; onStart: (harness: string, model: string, content: string) => Promise<void> }) {
  const [harness, setHarness] = useState(initialAgent), [model, setModel] = useState("");
  const [draft, setDraft] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit() { if (!draft.trim() || busy) return; setBusy(true); setError(""); try { await onStart(harness, model, draft); } catch (e) { setError(errorMessage(e)); setBusy(false); } }
  return <div className="workspace-welcome"><header className="thread-header"><h2>{title}</h2></header><Empty title="What would you like to work on?">Start a conversation with your agent.</Empty><div className="composer-area"><ErrorNotice message={error} /><form onSubmit={event => { event.preventDefault(); void submit(); }}><textarea aria-label="Message your agent" placeholder="Message your agent…" value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} /><div className="composer-controls"><Picker label="Agent" heading="Agent" icon={Cpu} value={harness} placeholder="Agent" options={agents.map(agent => ({ value: agent.id, label: agent.name, description: agent.detail }))} onChange={value => { setHarness(value); setModel(""); }} disabled={busy} />{<Picker label="Model" heading="Model" icon={Cpu} value={model} placeholder="Workspace default" options={[{ value: "", label: "Workspace default" }, ...models.filter(model => acceptsModel(harness, model.provider)).map(model => ({ value: model.id, label: model.name }))]} onChange={setModel} disabled={busy} />}<div className="composer-send-actions"><button className="send-button" aria-label="Send message" type="submit" disabled={busy || !draft.trim()}><Icon icon={ArrowUp} size={16} weight="send" /></button></div></div></form><div className="composer-status" role="status">{busy ? "Starting conversation…" : "Shared with your workspace"}</div></div></div>;
}

function PiSDKSettings({ conversationId }: { conversationId: string }) {
  const catalog = useResource<{
    defaultGeneration: string;
    selectedGeneration: string;
    pending: boolean;
    items: { id: string; label: string; piVersion: string }[];
  }>("/enterprise/api/conversations/" + conversationId + "/sdk-catalog");
  const [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (catalog.data) setSelected(catalog.data.selectedGeneration);
  }, [catalog.data]);
  return (
    <div className="pi-sdk-settings">
      <Field
        label="Pi Durable SDK version"
        hint="Pi Durable SDK updates are published and verified by your platform maintainer. Applying one stops this conversation's idle background work and keeps its history."
      >
        <select
          value={selected}
          disabled={busy || !catalog.data}
          onChange={(e) => setSelected(e.target.value)}
        >
          {catalog.data?.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.piVersion} · {item.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="row-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={catalog.reload}
        >
          Check for updates
        </button>
        <button
          type="button"
          className="secondary"
          disabled={
            busy || !selected || selected === catalog.data?.selectedGeneration
          }
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await send(
                "/enterprise/api/conversations/" +
                  conversationId +
                  "/sdk-generation",
                { generation: selected },
              );
              catalog.reload();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Applying…" : "Apply version"}
        </button>
      </div>
      {catalog.data?.pending ? (
        <p className="muted">
          The selected update is waiting for the previous runtime to stop.
        </p>
      ) : null}
      <ErrorNotice message={error || catalog.error} />
    </div>
  );
}
export function ConversationForm({
  conversation,
  folders,
  initialFolder,
  initialAgent,
  onSave,
  onCancel,
}: {
  project?: Project;
  modelsError?: string;
  conversation?: Conversation;
  folders?: WorkspaceFolder[];
  initialFolder?: string | null;
  initialAgent?: string | null;
  onSave: (body: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <AsyncForm
      submitLabel={conversation ? "Save changes" : "Start session"}
      onCancel={onCancel}
      onSubmit={async (d) =>
        onSave(
          conversation
            ? {
                title: d.get("title"),
                ...(conversation.harness === "pi" ? { pi: { codeMode: d.get("codeMode"), subagentConcurrency: Number(d.get("subagentConcurrency")) } } : {}),
              }
            : { mode: "write", harness: d.get("harness"), folderId: d.get("folderId") || null },
        )
      }
    >
      {conversation ? (
        <>
          <Field label="Title">
            <input
              name="title"
              defaultValue={conversation.title}
              maxLength={200}
              required
              autoFocus
            />
          </Field>
          {conversation.harness === "pi" ? <><details className="settings-disclosure pi-options">
            <summary>
              <Icon
                icon={ChevronDown}
                size={12}
                weight="control"
                className="disclosure-chevron"
              />
              <span>Pi Durable settings</span>
            </summary>
            <Field label="Code mode">
              <select
                name="codeMode"
                defaultValue={conversation.pi?.codeMode ?? "on"}
              >
                <option value="on">Enabled</option>
                <option value="only">Code mode only</option>
                <option value="off">Disabled</option>
              </select>
            </Field>
            <Field label="Concurrent subagents">
              <input
                name="subagentConcurrency"
                type="number"
                min={2}
                max={24}
                step={1}
                defaultValue={conversation.pi?.subagentConcurrency ?? 8}
              />
            </Field>
          </details>
          <PiSDKSettings conversationId={conversation.id} /></> : <p className="muted">{agentName(conversation.harness)} keeps its native runtime settings and approval controls.</p>}
        </>
      ) : (
        <>
          <Field label="Agent">
            <select name="harness" defaultValue={initialAgent ?? "pi"} autoFocus>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
          </Field>
          <Field label="Folder">
            <select
              name="folderId"
              defaultValue={
                initialFolder === "all" ? "" : (initialFolder ?? "")
              }
            >
              <option value="">All Workspaces</option>
              {folders?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
    </AsyncForm>
  );
}
function ModelControls({
  conversation,
  models,
  disabled,
  canEdit,
  onSaving,
  onSaved,
  onError,
}: {
  conversation?: Conversation;
  models: Model[];
  disabled: boolean;
  canEdit: boolean;
  onSaving: (saving: boolean) => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const current = conversation?.model ?? "";
  const currentThinking = conversation?.pi?.thinking ?? "";
  const [value, setValue] = useState(current);
  const [thinking, setThinking] = useState(currentThinking);
  useEffect(() => {
    setValue(current);
    setThinking(currentThinking);
  }, [current, currentThinking]);
  const levels = models.find((m) => m.id === value)?.thinkingLevels ?? [];
  async function change(body: unknown) {
    onSaving(true);
    onError("");
    try {
      const updated = await send<Conversation>(
        "/enterprise/api/conversations/" + conversation!.id,
        body,
        "PATCH",
      );
      setValue(updated.model);
      setThinking(updated.pi?.thinking ?? "");
      onSaved();
    } catch (error) {
      setValue(current);
      setThinking(currentThinking);
      onError(errorMessage(error));
    } finally {
      onSaving(false);
    }
  }
  const modelOptions: PickerOption[] = [
    ...(current && !models.some((m) => m.id === current)
      ? [{ value: current, label: `${current} (unavailable)`, disabled: true }]
      : []),
    ...models.map((m) => {
      const label = m.name || m.id;
      // Native popouts disambiguate repeated labels with their attribution.
      const repeated = models.some(
        (other) => other !== m && (other.name || other.id) === label,
      );
      return {
        value: m.id,
        label,
        detail: repeated
          ? `${providerNames[m.provider] ?? m.provider} · ${m.id}`
          : undefined,
      };
    }),
  ];
  const thinkingOptions: PickerOption[] = [
    { value: "", label: "Model default" },
    ...(thinking && !levels.includes(thinking)
      ? [{ value: thinking, label: `${thinking} (unavailable)`, disabled: true }]
      : []),
    ...levels.map((level) => ({
      value: level,
      label:
        level === "xhigh"
          ? "Extra high"
          : level.charAt(0).toUpperCase() + level.slice(1),
    })),
  ];
  return (
    <div className="composer-model-controls">
      <Picker
        label="Conversation model"
        heading="Model"
        icon={Cpu}
        width={360}
        value={value}
        placeholder="Select a model"
        options={modelOptions}
        emptyMessage="No models are available. An administrator can connect a provider in Connections."
        disabled={disabled || !canEdit || !conversation}
        onChange={(model) => {
          setValue(model);
          setThinking("");
          void change({ model });
        }}
      />
      <Picker
        label="Thinking level"
        heading="Thinking Level"
        icon={Brain}
        value={thinking}
        placeholder="Model default"
        options={thinkingOptions}
        disabled={
          disabled ||
          !canEdit ||
          !conversation ||
          (!levels.length && !thinking)
        }
        onChange={(next) => {
          setThinking(next);
          void change({ pi: { thinking: next || null } });
        }}
      />
    </div>
  );
}
function RetainedReply({ id, message }: { id: string; message: Message }) {
  const [complete, setComplete] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const text = complete ?? message.content;
  const { copyState, copy } = useCopyFeedback(text);
  const truncated = message.contentTruncated && complete === undefined;
  async function load() {
    setLoading(true);
    setError("");
    try {
      const reply = await api<Message>(
        `/enterprise/api/conversations/${id}/messages/${message.id}`,
      );
      setComplete(reply.content);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <RichText>{text}</RichText>
      {truncated ? (
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "Loading reply…" : "Show complete reply"}
        </button>
      ) : (
        <div className="response-actions">
          <button
            type="button"
            className="icon-button small"
            aria-label="Copy response"
            title="Copy complete response"
            onClick={() => {
              void copy(() => navigator.clipboard.writeText(text));
            }}
          >
            <Icon icon={copyState === "Copied" ? Check : Copy} size={12} weight="control" />
          </button>
          <small role="status">{copyState}</small>
        </div>
      )}
      {error ? (
        <small className="danger" role="alert">
          {error}
        </small>
      ) : null}
    </>
  );
}
export function Thread({
  id,
  project,
  models,
  refresh,
  onDeleted,
  asset,
}: {
  id: string;
  project?: Project;
  models: Model[];
  refresh: () => void;
  onDeleted: () => void;
  asset?: { onSaved: () => void };
}) {
  const { user } = useWorkspace();
  const assetSaved = useRef(asset?.onSaved);
  assetSaved.current = asset?.onSaved;
  const [, setWorkspaceQuery] = useSearchParams();
  const folders = useResource<List<WorkspaceFolder>>(
    !asset && project ? `/enterprise/api/projects/${project.id}/folders` : null,
    10000,
  );
  useWorkspaceChanges(folders.reload);
  const detail = useResource<Conversation>(
    `/enterprise/api/conversations/${id}`,
    10000,
  );
  useWorkspaceChanges(detail.reload);
  const activity = useConversationActivities(id);
  const [loadingRuns, setLoadingRuns] = useState<Set<string>>(new Set());
  const messages = useResource<Messages>(
    `/enterprise/api/conversations/${id}/messages?compact=1`,
  );
  const runs = useResource<List<Run>>(
    `/enterprise/api/conversations/${id}/runs`,
  );
  const [older, setOlder] = useState<Message[]>([]);
  const history = messages.data?.items ?? [];
  const pendingKey = `wme:pending:${user.id}:${id}`;
  const [restored] = useState(() => loadPendingMessage(pendingKey));
  const [before, setBefore] = useState<string | null>(null);
  const [olderLoaded, setOlderLoaded] = useState(false);
  const draftKey = `wme:draft:${user.id}:${id}`;
  const [savedDraft] = useState(() => loadConversationDraft(draftKey));
  const [draft, setDraft] = useState(
    restored?.content ?? savedDraft?.content ?? "",
  );
  const [kind, setKind] = useState<"message" | "comment">(
    restored?.kind ?? savedDraft?.kind ?? "message",
  );
  useEffect(() => {
    saveConversationDraft(draftKey, draft, kind);
  }, [draftKey, draft, kind]);
  const inputElement = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = inputElement.current;
    if (input) {
      input.style.height = "auto";
      // Three to seven 20-pixel lines, as in the native composer.
      input.style.height = `${Math.min(140, Math.max(60, input.scrollHeight))}px`;
    }
  }, [draft]);
  const [nativeOpen, setNativeOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [uncertain, setUncertain] = useState(Boolean(restored));
  const request = useRef<
    | {
        id: string;
        content: string;
        kind?: "message" | "comment";
      }
    | undefined
  >(restored);
  const [error, setError] = useState("");
  // A navigation can lose the POST acknowledgement after durable admission.
  // Reconcile only this user's exact receipt; never replay an uncertain input.
  useEffect(() => {
    const pending = request.current;
    if (
      !uncertain ||
      !pending ||
      !messages.data?.items.some(
        (message) =>
          message.role === "user" &&
          message.authorId === user.id &&
          message.requestId === pending.id &&
          message.content === pending.content.trim() &&
          (message.kind ?? "message") === (pending.kind ?? "message"),
      )
    )
      return;
    request.current = undefined;
    settleConversationInput(pendingKey, draftKey, pending);
    setUncertain(false);
    setDraft((current) => (current === pending.content ? "" : current));
    setError("");
  }, [messages.data, uncertain, pendingKey, user.id]);
  const [streamState, setStreamState] = useState("Connecting…");
  const [initialCursor, setInitialCursor] = useState<number>();
  const [tool, setTool] = useState("");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);
  const inspectWork = useCallback(() => {
    follow.current = false;
    setFollowing(false);
  }, []);
  const previousActivity = useRef(new Map<string, Activity[]>());
  const activityByRun = useMemo(() => {
    const map = new Map<string, Activity[]>();
    for (const item of activity.items) {
      if (item.deleted) continue;
      const items = map.get(item.runId) ?? [];
      items.push(item);
      map.set(item.runId, items);
    }
    for (const [runId, items] of map) {
      const previous = previousActivity.current.get(runId);
      if (
        previous?.length === items.length &&
        items.every((item, index) => item === previous[index])
      )
        map.set(runId, previous);
    }
    previousActivity.current = map;
    return map;
  }, [activity.items]);
  const indexedRuns = useRef(new Set<string>());
  indexedRuns.current = new Set(activityByRun.keys());
  const active =
    runs.data?.items.filter((r) => activeStatuses.has(r.status)) ?? [];
  const creator = Boolean(detail.data);
  const canAct = Boolean(detail.data);
  async function stop() {
    try {
      await send(`/enterprise/api/conversations/${id}/cancel`, {});
      runs.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    if (detail.data && initialCursor === undefined)
      setInitialCursor(detail.data.lastEventId ?? 0);
  }, [detail.data, initialCursor]);
  useEffect(() => {
    if (initialCursor === undefined) return;
    let timer: number | undefined;
    let disposed = false;
    const source = new EventSource(
      `/enterprise/api/conversations/${id}/events?after=${initialCursor}`,
      {
        withCredentials: true,
      },
    );
    const reload = () => {
      messages.reload();
      runs.reload();
    };
    const update = (raw: Event) => {
      if (disposed) return;
      let event: {
        type: string;
        runId?: string;
        data?: Record<string, unknown>;
      };
      try {
        event = JSON.parse((raw as MessageEvent).data);
      } catch {
        return;
      }
      if (event.type === "access.revoked") {
        source.close();
        setError("Your access to this conversation has been removed.");
        refresh();
        return;
      }
      if (event.type === "activity.changed") {
        activity.reload();
        return;
      }
      if (
        event.runId &&
        indexedRuns.current.has(event.runId) &&
        [
          "assistant.delta",
          "assistant.snapshot",
          "tool.started",
          "tool.completed",
        ].includes(event.type)
      )
        return;
      if (event.type === "files.reconciliation_failed")
        setError(
          String(event.data?.message ?? "File updates could not be refreshed."),
        );
      if (event.type === "tool.started")
        setTool(
          String(
            event.data?.name ?? event.data?.tool ?? "Agent is using a tool",
          ),
        );
      if (event.type === "tool.completed") setTool("");
      if (
        event.type === "members.changed" ||
        event.type === "sdk.changed" ||
        event.type === "settings.changed"
      )
        detail.reload();
      if (event.type === "asset.saved") assetSaved.current?.();
      if (event.type === "run.queued" || event.type === "run.started")
        detail.reload();
      if (
        event.type.startsWith("run.") &&
        !["run.queued", "run.started", "run.session"].includes(event.type)
      ) {
        setTool("");
        activity.reload();
        detail.reload();
        refresh();
      }
      if (!timer)
        timer = window.setTimeout(() => {
          timer = undefined;
          reload();
        }, 250);
    };
    for (const name of [
      "run.queued",
      "run.started",
      "run.stopping",
      "run.session",
      "assistant.delta",
      "assistant.snapshot",
      "activity.changed",
      "sdk.changed",
      "assistant.citation",
      "files.reconciliation_failed",
      "tool.started",
      "tool.completed",
      "run.completed",
      "run.failed",
      "run.cancelled",
      "run.interrupted",
      "message.comment",
      "message.steering",
      "message.delivery",
      "members.changed",
      "settings.changed",
      "asset.saved",
      "access.revoked",
    ])
      source.addEventListener(name, update);
    source.onopen = () => {
      setStreamState("Connected");
      activity.reload();
      reload();
      assetSaved.current?.();
    };
    source.onerror = () => setStreamState("Reconnecting…");
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [
    id,
    initialCursor,
    messages.reload,
    runs.reload,
    detail.reload,
    refresh,
    activity.reload,
  ]);
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages.data, tool, activity.items]);
  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (follow.current) node.scrollTop = node.scrollHeight;
      });
    });
    observer.observe(node, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [id]);
  async function submit() {
    if (
      !canAct ||
      sending ||
      modelSaving ||
      (!draft.trim() && !request.current)
    )
      return;
    if (kind === "message" && !active.length && detail.data?.harness === "pi" && !detail.data?.model) {
      setError("Select a model before sending a message.");
      return;
    }
    setSending(true);
    setError("");
    const pending = request.current ?? {
      id: crypto.randomUUID(),
      content: draft,
      kind,
    };
    request.current = pending;
    savePendingMessage(pendingKey, pending);
    try {
      await send(`/enterprise/api/conversations/${id}/messages`, {
        content: pending.content,
        requestId: pending.id,
        kind: pending.kind ?? "message",
      });
      request.current = undefined;
      settleConversationInput(pendingKey, draftKey, pending);
      setUncertain(false);
      setDraft("");
      messages.reload();
      runs.reload();
      refresh();
      follow.current = true;
      setFollowing(true);
    } catch (e) {
      if (request.current !== pending) return;
      const known = e instanceof ApiError && e.status < 500;
      if (known) {
        request.current = undefined;
        clearPendingMessage(pendingKey);
        setUncertain(false);
        setError(errorMessage(e));
      } else {
        setUncertain(true);
        setError(
          "Delivery could not be confirmed. Retry safely with the same request; your message will not be submitted twice.",
        );
      }
    } finally {
      setSending(false);
    }
  }
  async function loadOlder() {
    try {
      const page = await api<Messages>(
        `/enterprise/api/conversations/${id}/messages?compact=1&before=${encodeURIComponent(before ?? messages.data?.nextBefore ?? "")}`,
      );
      setOlder((prev) => [...page.items, ...prev]);
      setBefore(page.nextBefore);
      setOlderLoaded(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const combined = mergeMessages(
    mergeMessages(older, history),
    messages.data?.items ?? [],
  );
  return (
    <>
      <header className="thread-header">
        <h2 title={detail.data?.title}>
          {detail.data?.title ?? "Conversation"}
        </h2>
        <div className="thread-header-actions">
          <Menu label="Conversation actions" className="small">
            <MenuLink href={`/enterprise/api/conversations/${id}/export`} download>
              Export messages
            </MenuLink>
            <MenuLink
              href={`/enterprise/api/conversations/${id}/export?full=1`}
              download
            >
              Export full run
            </MenuLink>
            <MenuItem onSelect={() => setNativeOpen(true)}>Native history</MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={Square}
              disabled={!canAct}
              title="Stop this thread’s current work and background processes. Other threads keep running."
              onSelect={() => void stop()}
            >
              {active.length ? "Stop" : "Stop background work"}
            </MenuItem>
            {creator ? (
              <>
                <MenuItem
                  icon={Settings}
                  disabled={!canAct || active.length > 0}
                  onSelect={() => setEditing(true)}
                >
                  Conversation settings
                </MenuItem>
                {!asset ? (
                  <MenuItem
                    icon={Trash2}
                    danger
                    disabled={!canAct}
                    onSelect={() => setDeleting(true)}
                  >
                    Move to Trash
                  </MenuItem>
                ) : null}
              </>
            ) : null}
          </Menu>
        </div>
      </header>
      <NativeHistory
        id={id}
        opened={nativeOpen}
        onClose={() => setNativeOpen(false)}
      />
      <ErrorNotice
        message={
          detail.error ||
          messages.error ||
          runs.error ||
          activity.error ||
          error
        }
      />
      <div
        className="transcript"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el) {
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 90;
            setFollowing(follow.current);
          }
        }}
      >
        {(olderLoaded ? before : messages.data?.hasMore) ? (
          <button
            className="text-button load-older"
            onClick={() => void loadOlder()}
          >
            Load earlier messages
          </button>
        ) : null}
        {activity.hasOlder ? (
          <button
            className="text-button load-older"
            onClick={() => {
              inspectWork();
              void activity.loadOlder().catch((e) => setError(errorMessage(e)));
            }}
          >
            Load earlier activity
          </button>
        ) : null}
        {messages.loading && !messages.data ? (
          <Loading />
        ) : !combined.length ? (
          <Empty title="What would you like to work on?">
            {asset
              ? "Describe what you want to create or change. The agent saves a private draft for your review."
              : "Your agent can use the files available in this workspace."}
          </Empty>
        ) : (
          combined.map((m) => (
            <article key={m.id} className={`message message-${m.role}`}>
              <div className="message-meta">
                <strong>
                  {m.role === "assistant" ? "Pi Durable" : m.authorName || "Member"}
                </strong>
                <time dateTime={m.createdAt}>{date(m.createdAt)}</time>
              </div>
              <div className="message-content">
                {m.role === "assistant" ? (
                  activityByRun.has(m.runId) ? (
                    <>
                      <ConversationRunWork
                        id={id}
                        items={activityByRun.get(m.runId)!}
                        status={
                          runs.data?.items.find((run) => run.id === m.runId)
                            ?.status
                        }
                        startedAt={
                          runs.data?.items.find((run) => run.id === m.runId)
                            ?.startedAt
                        }
                        completedAt={
                          runs.data?.items.find((run) => run.id === m.runId)
                            ?.completedAt
                        }
                        onInspect={inspectWork}
                      />
                      {m.contentTruncated &&
                      !activityByRun
                        .get(m.runId)!
                        .some((item) => item.kind === "final") ? (
                        <RetainedReply id={id} message={m} />
                      ) : null}
                    </>
                  ) : m.content ? (
                    <RetainedReply id={id} message={m} />
                  ) : (
                    <span className="muted">
                      {emptyAssistantLabel(
                        runs.data?.items.find((run) => run.id === m.runId)
                          ?.status,
                      )}
                    </span>
                  )
                ) : (
                  m.content
                )}
              </div>
              {m.role === "assistant" &&
              (m.activityCount ?? 0) >
                (activityByRun.get(m.runId)?.length ?? 0) ? (
                <div>
                  <small>Earlier work for this reply is available.</small>{" "}
                  <button
                    type="button"
                    className="text-button"
                    disabled={loadingRuns.has(m.runId)}
                    onClick={() => {
                      inspectWork();
                      setLoadingRuns((previous) =>
                        new Set(previous).add(m.runId),
                      );
                      void activity
                        .loadRun(m.runId)
                        .catch((e) => setError(errorMessage(e)))
                        .finally(() => {
                          setLoadingRuns((previous) => {
                            const next = new Set(previous);
                            next.delete(m.runId);
                            return next;
                          });
                        });
                    }}
                  >
                    {loadingRuns.has(m.runId)
                      ? "Loading activity…"
                      : "Load complete activity"}
                  </button>
                </div>
              ) : null}
              {m.kind === "comment" ? (
                <small>Comment</small>
              ) : m.delivery && m.delivery !== "accepted" ? (
                <small role="status">
                  {m.delivery === "pending"
                    ? "Awaiting agent delivery"
                    : (m.error ?? m.delivery)}
                </small>
              ) : null}
              {m.role === "assistant" &&
              runs.data?.items.find((run) => run.id === m.runId)?.error ? (
                <small className="danger">
                  {
                    runs.data.items.find((run) => run.id === m.runId)?.error
                      ?.message
                  }
                </small>
              ) : null}
              {m.citations?.length ? (
                <div className="citations">
                  {m.citations.map((c, i) =>
                    c.url?.startsWith("/enterprise/api/files/") ? (
                      <ContentLink key={i} href={c.url} page={c.page}>
                        {c.label ?? "Source"}
                        {c.page ? ` · page ${c.page}` : ""}
                      </ContentLink>
                    ) : (
                      <span key={i}>
                        {c.label ?? "Source"}
                        {c.page ? ` · page ${c.page}` : ""}
                      </span>
                    ),
                  )}
                </div>
              ) : null}
            </article>
          ))
        )}
        {tool ? (
          <div className="tool-status" role="status">
            {tool}
          </div>
        ) : null}
        {runs.data?.items
          .filter((r) =>
            ["failed", "interrupted", "cancelling"].includes(r.status),
          )
          .slice(0, 1)
          .map((r) => (
            <div className="notice" key={r.id}>
              <Status value={r.status} />
              <span>
                {r.error?.message ||
                  "This run stopped. Send a new message when you are ready to continue."}
              </span>
            </div>
          ))}
      </div>
      <div className="composer-area">
        {detail.data && detail.data.harness !== "pi" ? <NativeControls conversation={detail.data} models={models} onSaved={() => { detail.reload(); refresh(); }} /> : null}
        {!following ? (
          <button
            type="button"
            className="secondary latest-reply"
            onClick={() => {
              follow.current = true;
              setFollowing(true);
              if (scroll.current)
                scroll.current.scrollTop = scroll.current.scrollHeight;
            }}
          >
            <Icon icon={ArrowDown} size={12} weight="control" />
            Latest reply
          </button>
        ) : null}
        <NativeChecklist
          items={activity.items}
          activeRunIds={new Set(active.map((run) => run.id))}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="sr-only" htmlFor="message">
            Message your agent
          </label>
          {!asset ? (
            <div className="composer-folder-row">
              <Picker
                label="Conversation folder"
                heading="Folder"
                icon={FolderOpen}
                className="composer-folder"
                width={320}
                value={detail.data?.folderId ?? ""}
                placeholder="All Workspaces"
                title={
                  detail.data?.workingDirectory ??
                  "Choose a working folder before sending"
                }
                options={[
                  { value: "", label: "All Workspaces" },
                  ...(detail.data?.folderId &&
                  !folders.data?.items.some((f) => f.id === detail.data?.folderId)
                    ? [{ value: detail.data.folderId, label: "Removed folder" }]
                    : []),
                  ...(folders.data?.items.map((f) => ({
                    value: f.id,
                    label: f.name,
                  })) ?? []),
                ]}
                disabled={
                  !detail.data ||
                  detail.data.workspaceLocked ||
                  detail.data.createdBy !== user.id ||
                  sending ||
                  modelSaving ||
                  uncertain
                }
                onChange={async (value) => {
                  const navigationTarget = window.location.href;
                  const folderId = value || null;
                  setModelSaving(true);
                  try {
                    const updated = await send<Conversation>(
                      `/enterprise/api/conversations/${id}/organization`,
                      { folderId },
                      "PATCH",
                    );
                    if (window.location.href === navigationTarget)
                      setWorkspaceQuery(
                        (current) => {
                          const next = new URLSearchParams(current);
                          next.set("folder", updated.folderId ?? "all");
                          return next;
                        },
                        { replace: true },
                      );
                    detail.reload();
                    workspaceChanged();
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setModelSaving(false);
                  }
                }}
              />
            </div>
          ) : null}
          <textarea
            ref={inputElement}
            id="message"
            rows={3}
            placeholder={canAct ? `Message ${agentName(detail.data?.harness)}…` : "Loading conversation…"}
            value={draft}
            maxLength={100000}
            readOnly={uncertain}
            disabled={sending || !canAct}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-controls">
            {(!detail.data?.harness || detail.data.harness === "pi") ? <ModelControls
              conversation={detail.data}
              models={models}
              disabled={
                active.length > 0 || sending || uncertain || modelSaving
              }
              canEdit={creator && canAct}
              onSaving={setModelSaving}
              onSaved={() => {
                detail.reload();
                refresh();
              }}
              onError={setError}
            /> : null}
            <div className="composer-send-actions">
              <div className="message-kind">
                <Picker
                  label="Message mode"
                  heading="Send As"
                  icon={MessageSquare}
                  width={320}
                  value={kind}
                  placeholder="Message"
                  disabled={sending || uncertain || !canAct}
                  options={[
                    {
                      value: "message",
                      label: "Message",
                      description: "Directs the agent. During active work, messages steer the run.",
                    },
                    {
                      value: "comment",
                      label: "Comment",
                      description: "Saved for later agent context without starting work.",
                    },
                  ]}
                  onChange={(value) => setKind(value as "message" | "comment")}
                />
              </div>
              {active.length ? (
                <button
                  className="stop-button"
                  type="button"
                  aria-label="Stop"
                  title="Stop current work and background processes"
                  disabled={!canAct}
                  onClick={() => void stop()}
                >
                  <Icon icon={Square} size={12} weight="control" />
                </button>
              ) : null}
              <button
                type="submit"
                className={`send-button${uncertain ? " retry" : ""}`}
                aria-label={
                  uncertain
                    ? "Retry message"
                    : kind === "comment"
                      ? "Send comment"
                      : "Send message"
                }
                disabled={
                  !canAct ||
                  sending ||
                  modelSaving ||
                  (!draft.trim() && !uncertain)
                }
              >
                {uncertain ? (
                  "Retry"
                ) : (
                  <Icon icon={ArrowUp} size={16} weight="send" />
                )}
              </button>
            </div>
          </div>
        </form>
        <div className="composer-status" role="status">
          {!canAct && detail.data
            ? "Conversation unavailable."
            : uncertain
              ? "Delivery unconfirmed"
              : active.length
                ? kind === "comment"
                  ? "Comment saved for later agent context"
                  : "Working · messages steer the active run"
                : kind === "comment"
                  ? "Comments are saved for later agent context"
                  : streamState}
        </div>
      </div>
      {editing && detail.data ? (
        <Modal title="Conversation settings" onClose={() => setEditing(false)}>
          <ConversationForm
            project={project}
            conversation={detail.data}
            onCancel={() => setEditing(false)}
            onSave={async (body) => {
              await send(`/enterprise/api/conversations/${id}`, body, "PATCH");
              detail.reload();
              refresh();
              setEditing(false);
            }}
          />
        </Modal>
      ) : null}
      {deleting ? (
        <Confirm
          title="Move to Trash?"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            const navigationTarget = window.location.href;
            await api(`/enterprise/api/conversations/${id}`, {
              method: "DELETE",
            });
            if (window.location.href === navigationTarget) onDeleted();
          }}
        >
          This removes access to the conversation for everyone in it.
        </Confirm>
      ) : null}
    </>
  );
}
function ConversationTrash({ project }: { project: Project }) {
  const { user } = useWorkspace();
  const chats = useResource<List<Conversation>>(
    `/enterprise/api/projects/${project.id}/conversations?trash=1`,
  );
  useWorkspaceChanges(chats.reload);
  return (
    <section className="workspace-trash subpage">
      <PageHeader
        title="Trash"
        description="Restoring a conversation preserves its history and working directory. Working files are kept when a chat is moved to Trash."
      />
      <ErrorNotice message={chats.error} onRetry={chats.reload} />
      {chats.loading && !chats.data ? (
        <Loading />
      ) : chats.error && !chats.data ? null : chats.data?.items.length ? (
        <div className="row-list">
          {chats.data.items.map((c) => (
            <div className="setting-row" key={c.id}>
              <Icon icon={MessageSquare} size={16} />
              <div>
                <strong>{c.title}</strong>
              </div>
              {c.createdBy === user.id ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    await send(`/enterprise/api/conversations/${c.id}/restore`, {});
                    chats.reload();
                    workspaceChanged();
                  }}
                >
                  Restore conversation
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <Empty title="Trash is empty">
          Trashed conversations will appear here.
        </Empty>
      )}
    </section>
  );
}
