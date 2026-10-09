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
  ArrowUp,
  Ellipsis,
  LockKeyhole,
  ShieldCheck,
  Settings,
  Square,
  Trash2,
  Users,
} from "lucide-react";
import {
  api,
  ApiError,
  date,
  errorMessage,
  send,
  useResource,
  type List,
  type Project,
  type User,
  type Model,
  type Run,
  type Conversation,
} from "../api";
import { useWorkspace } from "../workspace";
import { useSearchParams } from "react-router-dom";
import {
  workspaceChanged,
  useWorkspaceChanges,
  readWorkspaceValue,
  writeWorkspaceValue,
} from "../workspace-events";
import { RichText } from "../components/RichText";
import { sourcePathFromContentUrl } from "../source-preview";
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
  const list = useResource<List<Conversation>>(
    `/enterprise/api/projects/${project.id}/conversations`,
  );
  const models = useResource<List<Model>>(
    `/enterprise/api/organizations/${org.id}/inference/models`,
  );
  useWorkspaceChanges(list.reload);
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
    if (requestedConversation || creating || !list.data) return;
    const previous = readWorkspaceValue(selectionKey);
    if (previous && list.data.items.some((c) => c.id === previous))
      setQuery({ conversation: previous }, { replace: true });
  }, [requestedConversation, creating, list.data, selectionKey, setQuery]);
  function select(id?: string) {
    setQuery(id ? { conversation: id } : {});
  }
  function closeCreate() {
    const next = new URLSearchParams(query);
    next.delete("new");
    setQuery(next, { replace: true });
  }
  return (
    <div className="conversation-layout">
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
                "This conversation is unavailable in this project."
              }
            />
          )
        ) : (
          <Empty
            title={project.name}
            action={
              <button
                className="primary"
                onClick={() => setQuery({ new: "1" })}
              >
                New conversation
              </button>
            }
          >
            Ask a question, analyze your files, or work through ideas.
          </Empty>
        )}
        {!conversationId ? <ErrorNotice message={list.error} /> : null}
      </div>
      {creating ? (
        <Modal title="New conversation" compact onClose={closeCreate}>
          <ConversationForm
            project={project}
            onCancel={closeCreate}
            onSave={async (body) => {
              const c = await send<Conversation>(
                `/enterprise/api/projects/${project.id}/conversations`,
                body,
              );
              select(c.id);
              workspaceChanged();
            }}
          />
        </Modal>
      ) : null}
    </div>
  );
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
        label="Pi Durable version"
        hint="Updates are published and verified by your platform maintainer. Applying one stops this conversation's idle background work and keeps its history."
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
  project,
  conversation,
  onSave,
  onCancel,
}: {
  project?: Project;
  modelsError?: string;
  conversation?: Conversation;
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
                pi: {
                  codeMode: d.get("codeMode"),
                  subagentConcurrency: Number(d.get("subagentConcurrency")),
                },
              }
            : { mode: d.get("mode") },
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
          <details className="pi-options">
            <summary>Pi Durable settings</summary>
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
          <PiSDKSettings conversationId={conversation.id} />
        </>
      ) : (
        <Field
          label="Session permissions"
          hint="Access is fixed for this session."
        >
          <select
            name="mode"
            defaultValue={project?.access ?? "read"}
            autoFocus
          >
            <option value="read">Read-only</option>
            {project?.access === "write" ? (
              <option value="write">Full access</option>
            ) : null}
          </select>
        </Field>
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
  return (
    <div className="composer-model-controls">
      <label>
        <span className="sr-only">Model</span>
        <select
          aria-label="Conversation model"
          title="Model"
          value={value}
          disabled={disabled || !canEdit || !conversation}
          onChange={(e) => {
            const model = e.target.value;
            setValue(model);
            setThinking("");
            void change({ model });
          }}
        >
          <option value="" disabled>
            Select a model
          </option>
          {current && !models.some((m) => m.id === current) ? (
            <option value={current} disabled>
              {current} (unavailable)
            </option>
          ) : null}
          {models.map((m) => (
            <option key={m.provider + ":" + m.id} value={m.id}>
              {m.name || m.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="sr-only">Thinking</span>
        <select
          aria-label="Thinking level"
          title="Thinking level"
          value={thinking}
          disabled={disabled || !canEdit || !conversation || !levels.length}
          onChange={(e) => {
            const next = e.target.value;
            setThinking(next);
            void change({ pi: { thinking: next || null } });
          }}
        >
          <option value="">Model default</option>
          {levels.map((level) => (
            <option key={level} value={level}>
              {level === "xhigh"
                ? "Extra high"
                : level.charAt(0).toUpperCase() + level.slice(1)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
function RetainedReply({ id, message }: { id: string; message: Message }) {
  const [complete, setComplete] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
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
      <RichText>{complete ?? message.content}</RichText>
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
            className="text-button"
            aria-label="Copy response"
            onClick={() => {
              void navigator.clipboard
                .writeText(complete ?? message.content)
                .then(() => setCopied(true))
                .catch((e) => setError(errorMessage(e)));
            }}
          >
            {copied ? "Copied" : "Copy response"}
          </button>
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
  const { user, orgBase } = useWorkspace();
  const assetSaved = useRef(asset?.onSaved);
  assetSaved.current = asset?.onSaved;
  const detail = useResource<Conversation>(
    `/enterprise/api/conversations/${id}`,
    10000,
  );
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
      input.style.height = `${Math.min(168, Math.max(60, input.scrollHeight))}px`;
    }
  }, [draft]);
  const [nativeOpen, setNativeOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);
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
  const [members, setMembers] = useState(false);
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
  const creator = !!asset || detail.data?.createdBy === user.id;
  const canAct =
    !!detail.data &&
    (!project ||
      detail.data.mode === "read" ||
      (project.access === "write" && detail.data.effectiveMode !== "read"));
  async function stop() {
    try {
      await send(`/enterprise/api/conversations/${id}/cancel`, {});
      runs.reload();
      setMenuOpen(false);
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
    if (kind === "message" && !active.length && !detail.data?.model) {
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
          {!asset ? (
            <button
              className="icon-button"
              aria-label="Conversation members"
              onClick={() => setMembers(true)}
            >
              <Users size={17} />
            </button>
          ) : null}
          <div className="thread-menu" ref={menu}>
            <button
              className="icon-button"
              aria-label="Conversation actions"
              aria-expanded={menuOpen}
              aria-haspopup="true"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Ellipsis size={19} />
            </button>
            {menuOpen ? (
              <div className="thread-menu-items">
                <button
                  onClick={() => {
                    setNativeOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  Native history
                </button>
                <button
                  disabled={!canAct}
                  title="Stop this thread’s current work and background processes. Other threads keep running."
                  onClick={() => void stop()}
                >
                  <Square size={14} />
                  {active.length ? "Stop" : "Stop background work"}
                </button>
                {creator ? (
                  <>
                    <button
                      disabled={!canAct || active.length > 0}
                      onClick={() => {
                        setEditing(true);
                        setMenuOpen(false);
                      }}
                    >
                      <Settings size={15} />
                      Conversation settings
                    </button>
                    {!asset ? (
                      <button
                        className="danger"
                        disabled={!canAct}
                        onClick={() => {
                          setDeleting(true);
                          setMenuOpen(false);
                        }}
                      >
                        <Trash2 size={15} />
                        Delete conversation
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
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
              : "Your agent can use the files available in this project."}
          </Empty>
        ) : (
          combined.map((m) => (
            <article key={m.id} className={`message message-${m.role}`}>
              <div className="message-meta">
                <strong>
                  {m.role === "assistant"
                    ? "Assistant"
                    : m.authorName || "Member"}
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
                      <a
                        key={i}
                        href={
                          sourcePathFromContentUrl(c.url, c.page)
                            ? `${orgBase}${sourcePathFromContentUrl(c.url, c.page)}`
                            : c.url
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {c.label ?? "Source"}
                        {c.page ? ` · page ${c.page}` : ""}
                      </a>
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
        {!following ? (
          <button
            className="text-button latest-reply"
            onClick={() => {
              follow.current = true;
              setFollowing(true);
              if (scroll.current)
                scroll.current.scrollTop = scroll.current.scrollHeight;
            }}
          >
            Latest reply ↓
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
          <textarea
            ref={inputElement}
            id="message"
            rows={3}
            placeholder={canAct ? "Message your agent…" : "Read-only for you"}
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
            <label className="message-kind">
              <select
                aria-label="Message mode"
                value={kind}
                disabled={sending || uncertain || !canAct}
                onChange={(e) =>
                  setKind(e.target.value as "message" | "comment")
                }
              >
                <option value="message">Message</option>
                <option value="comment">Comment</option>
              </select>
            </label>
            <ModelControls
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
            />
            <span
              className="session-mode"
              title={
                detail.data?.mode === "write" && !canAct
                  ? "Your project access is read-only. Create a read-only conversation to use the agent."
                  : "Access is fixed for this conversation."
              }
            >
              {detail.data?.mode === "write" && canAct ? (
                <ShieldCheck size={14} />
              ) : (
                <LockKeyhole size={14} />
              )}
              <span>
                {detail.data?.mode === "write" && canAct
                  ? "Full access"
                  : "Read-only"}
              </span>
            </span>
            <div className="composer-send-actions">
              {active.length ? (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Stop"
                  title="Stop current work and background processes"
                  disabled={!canAct}
                  onClick={() => void stop()}
                >
                  <Square size={15} />
                </button>
              ) : null}
              <button
                type="submit"
                className="send-button"
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
                {uncertain ? "Retry" : <ArrowUp size={20} />}
              </button>
            </div>
          </div>
        </form>
        <div className="composer-status" role="status">
          {!canAct && detail.data
            ? "Read-only for you. Start a read-only conversation to use the agent."
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
      {members ? (
        <ThreadMembers
          id={id}
          canAdd={canAct}
          onClose={() => setMembers(false)}
        />
      ) : null}
      {deleting ? (
        <Confirm
          title="Delete conversation?"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api(`/enterprise/api/conversations/${id}`, {
              method: "DELETE",
            });
            onDeleted();
          }}
        >
          This removes access to the conversation for everyone in it.
        </Confirm>
      ) : null}
    </>
  );
}
function ThreadMembers({
  id,
  canAdd,
  onClose,
}: {
  id: string;
  canAdd: boolean;
  onClose: () => void;
}) {
  const members = useResource<
    List<
      User & {
        isCreator?: boolean;
      }
    >
  >(`/enterprise/api/conversations/${id}/members`);
  const people = useResource<List<User>>(
    canAdd ? `/enterprise/api/conversations/${id}/eligible-members` : null,
  );
  return (
    <Modal title="Conversation members" onClose={onClose}>
      <p className="muted">
        Conversations are private until you add people. Participants must retain
        the project access required by this conversation. Read-only project
        access never grants full-access agent authority.
      </p>
      <ErrorNotice message={members.error || people.error} />
      {members.data?.items.map((u) => (
        <div className="setting-row" key={u.id}>
          <div>
            {u.name || u.email}
            <small>{u.email}</small>
          </div>
        </div>
      ))}
      {people.data ? (
        <AsyncForm
          submitLabel="Add person"
          onSubmit={async (d) => {
            await send(`/enterprise/api/conversations/${id}/members`, {
              userId: d.get("userId"),
            });
            members.reload();
          }}
        >
          <Field label="Project member">
            <select name="userId" required defaultValue="">
              <option value="" disabled>
                Select a person
              </option>
              {people.data?.items
                .filter((u) => !members.data?.items.some((m) => m.id === u.id))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name || u.email}
                  </option>
                ))}
            </select>
          </Field>
        </AsyncForm>
      ) : null}
    </Modal>
  );
}
