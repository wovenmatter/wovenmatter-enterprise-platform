import {
  ConversationRunWork,
  NativeChecklist,
  NativeHistory,
  useConversationActivities,
} from "./ConversationWork";
import type { Activity } from "../activity-state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  MessageSquare,
  Plus,
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
} from "../api";
import { useWorkspace } from "../workspace";
import { RichText } from "../components/RichText";
import { sourcePathFromContentUrl } from "../source-preview";
import {
  mergeMessages,
  emptyAssistantLabel,
  loadPendingMessage,
  savePendingMessage,
  clearPendingMessage,
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
export type Model = {
  id: string;
  name: string;
  provider: string;
  thinkingLevels?: string[];
};
export type Conversation = {
  id: string;
  title: string;
  mode: "read" | "write";
  effectiveMode?: "read" | "write";
  harness: string;
  pi?: {
    codeMode?: string;
    subagentConcurrency?: number;
    thinking?: string;
    sdkGeneration?: string;
  };
  model: string;
  createdBy: string;
  lastEventId?: number;
  activeRun?: Run | null;
  members?: User[];
};
type Message = {
  id: string;
  role: "user" | "assistant";
  authorId: string;
  authorName: string;
  content: string;
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
type Run = {
  id: string;
  status: string;
  error?: {
    code: string;
    message: string;
  } | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
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
  const { org } = useWorkspace();
  const list = useResource<List<Conversation>>(
    `/enterprise/api/projects/${project.id}/conversations`,
  );
  const models = useResource<List<Model>>(
    `/enterprise/api/organizations/${org.id}/inference/models`,
  );
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const conversationId =
    selected && list.data?.items.some((c) => c.id === selected)
      ? selected
      : undefined;
  return (
    <div className="conversation-layout">
      <aside className="conversation-rail">
        <button className="primary" onClick={() => setCreating(true)}>
          <Plus size={17} />
          New conversation
        </button>
        <label className="sr-only" htmlFor="conversation-search">
          Search conversations
        </label>
        <input
          id="conversation-search"
          type="search"
          placeholder="Search conversations…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ErrorNotice message={list.error} />
        {list.loading && !list.data ? (
          <Loading />
        ) : !list.data?.items.length ? (
          <p className="rail-empty">No conversations yet.</p>
        ) : (
          <div className="conversation-list">
            {list.data.items
              .filter((c) =>
                c.title.toLowerCase().includes(search.toLowerCase()),
              )
              .map((c) => (
                <button
                  key={c.id}
                  className={`conversation-link ${conversationId === c.id ? "selected" : ""}`}
                  onClick={() => setSelected(c.id)}
                >
                  <MessageSquare size={16} />
                  <span>
                    {c.title}
                    <small>
                      {c.mode === "write" && c.effectiveMode === "read"
                        ? "Read-only for you"
                        : c.mode === "write"
                          ? "Full access"
                          : "Read-only"}
                      {c.activeRun ? " · Working" : ""}
                    </small>
                  </span>
                </button>
              ))}
          </div>
        )}
      </aside>
      <div className="conversation-main">
        {conversationId ? (
          <Thread
            key={conversationId}
            id={conversationId}
            project={project}
            models={models.data?.items ?? []}
            refresh={list.reload}
            onDeleted={() => {
              setSelected(undefined);
              list.reload();
            }}
          />
        ) : (
          <Empty
            title="Start a conversation"
            action={
              <button className="primary" onClick={() => setCreating(true)}>
                New conversation
              </button>
            }
          >
            Ask a question, analyze your files, or work through ideas.
          </Empty>
        )}
      </div>
      {creating ? (
        <Modal title="New conversation" onClose={() => setCreating(false)}>
          <ConversationForm
            project={project}
            modelsError={models.error}
            onCancel={() => setCreating(false)}
            onSave={async (body) => {
              const c = await send<Conversation>(
                `/enterprise/api/projects/${project.id}/conversations`,
                body,
              );
              setSelected(c.id);
              list.reload();
              setCreating(false);
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
          <select name="mode" defaultValue="read" autoFocus>
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
  );
  const activity = useConversationActivities(id);
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
  const [draft, setDraft] = useState(restored?.content ?? "");
  const [kind, setKind] = useState<"message" | "comment">(
    restored?.kind ?? "message",
  );
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
    if (sending || modelSaving || (!draft.trim() && !request.current)) return;
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
      clearPendingMessage(pendingKey);
      setUncertain(false);
      setDraft("");
      messages.reload();
      runs.reload();
      refresh();
      follow.current = true;
      setFollowing(true);
    } catch (e) {
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
        <div>
          <h2>{detail.data?.title ?? "Conversation"}</h2>
          <small>
            {detail.data?.mode === "write" &&
            detail.data?.effectiveMode === "read"
              ? "Read-only for you"
              : detail.data?.mode === "write"
                ? "Full access"
                : "Read-only"}{" "}
            · Pi Durable · {detail.data?.model || "No model selected"}
          </small>
        </div>
        <div className="row-actions">
          {!asset ? (
            <button
              className="icon-button"
              aria-label="Conversation members"
              onClick={() => setMembers(true)}
            >
              <Users size={18} />
            </button>
          ) : null}
          {creator ? (
            <>
              <button
                className="icon-button"
                aria-label="Conversation settings"
                disabled={active.length > 0}
                onClick={() => setEditing(true)}
              >
                <Settings size={18} />
              </button>
              {!asset ? (
                <button
                  className="icon-button danger"
                  aria-label="Delete conversation"
                  onClick={() => setDeleting(true)}
                >
                  <Trash2 size={17} />
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
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
                  ) : m.content ? (
                    <RichText>{m.content}</RichText>
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
        <NativeHistory id={id} />
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
            id="message"
            placeholder="Message your agent…"
            value={draft}
            maxLength={100000}
            readOnly={uncertain}
            disabled={sending}
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
            <label>
              Send as{" "}
              <select
                aria-label="Message mode"
                value={kind}
                disabled={sending || uncertain}
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
              canEdit={creator}
              onSaving={setModelSaving}
              onSaved={() => {
                detail.reload();
                refresh();
              }}
              onError={setError}
            />
            <span className="connection-state">
              {kind === "comment"
                ? "Saved for later agent context. "
                : active.length
                  ? "Messages steer the active run. "
                  : ""}
              {active.length
                ? `${active.length} ${active.length === 1 ? "run" : "runs"} in progress`
                : streamState}
            </span>
            <div className="row-actions">
              <button
                type="button"
                className="secondary"
                title="Stop this thread's current work and background processes. Other threads keep running."
                onClick={async () => {
                  try {
                    await send(
                      `/enterprise/api/conversations/${id}/cancel`,
                      {},
                    );
                    runs.reload();
                  } catch (e) {
                    setError(errorMessage(e));
                  }
                }}
              >
                <Square size={14} />
                {active.length ? "Stop" : "Stop background work"}
              </button>
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
                  sending || modelSaving || (!draft.trim() && !uncertain)
                }
              >
                {uncertain ? "Retry" : <ArrowUp size={20} />}
              </button>
            </div>
          </div>
        </form>
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
        <ThreadMembers id={id} onClose={() => setMembers(false)} />
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
function ThreadMembers({ id, onClose }: { id: string; onClose: () => void }) {
  const members = useResource<
    List<
      User & {
        isCreator?: boolean;
      }
    >
  >(`/enterprise/api/conversations/${id}/members`);
  const people = useResource<List<User>>(
    `/enterprise/api/conversations/${id}/eligible-members`,
  );
  return (
    <Modal title="Conversation members" onClose={onClose}>
      <p className="muted">
        Conversations are private until you add people. Everyone here can read
        and send messages. Everyone inherits this thread’s access mode,
        including full access to direct edits when enabled.
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
