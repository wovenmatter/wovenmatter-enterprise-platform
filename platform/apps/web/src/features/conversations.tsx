import { useEffect, useRef, useState } from "react";
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
type Model = { id: string; name: string; provider: string };
type Conversation = {
  id: string;
  title: string;
  mode: "read" | "write";
  effectiveMode?: "read" | "write";
  harness: string;
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
  error?: { code: string; message: string } | null;
  createdAt: string;
};
type Messages = List<Message> & { hasMore: boolean; nextBefore: string | null };
const activeStatuses = new Set([
  "queued",
  "dispatching",
  "running",
  "cancelling",
]);
export function ConversationsPage({ project }: { project: Project }) {
  const { org } = useWorkspace();
  const list = useResource<List<Conversation>>(
    `/api/projects/${project.id}/conversations`,
  );
  const models = useResource<List<Model>>(
    `/api/organizations/${org.id}/inference/models`,
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
                        ? "Read only for you"
                        : c.mode === "write"
                          ? "Full access"
                          : "Read only"}
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
            models={models.data?.items ?? []}
            modelsError={models.error}
            onCancel={() => setCreating(false)}
            onSave={async (body) => {
              const c = await send<Conversation>(
                `/api/projects/${project.id}/conversations`,
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
function ConversationForm({
  project,
  models,
  modelsError,
  conversation,
  onSave,
  onCancel,
}: {
  project: Project;
  models: Model[];
  modelsError?: string;
  conversation?: Conversation;
  onSave: (body: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <AsyncForm
      submitLabel={conversation ? "Save changes" : "Create conversation"}
      onCancel={onCancel}
      onSubmit={async (d) =>
        onSave({
          title: d.get("title"),
          mode: d.get("mode"),
          harness: d.get("harness") || null,
          model: d.get("model"),
        })
      }
    >
      <Field label="Title">
        <input
          name="title"
          defaultValue={conversation?.title ?? "New conversation"}
          maxLength={200}
          required
          autoFocus
        />
      </Field>
      <Field
        label="Session permissions"
        hint="Full access lets the agent change files within your project permissions."
      >
        <select name="mode" defaultValue={conversation?.mode ?? "read"}>
          <option value="read">Read only</option>
          {project.access === "write" ? (
            <option value="write">Full access</option>
          ) : null}
        </select>
      </Field>
      <Field label="Model">
        <select name="model" required defaultValue={conversation?.model ?? ""}>
          <option value="" disabled>
            Select a model
          </option>
          {models.map((m) => (
            <option key={`${m.provider}:${m.id}`} value={m.id}>
              {m.name || m.id}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Agent">
        <select name="harness" defaultValue={conversation?.harness ?? ""}>
          <option value="">Provider default</option>
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
          <option value="grok">Grok Build</option>
          <option value="pi">Pi</option>
        </select>
      </Field>
      {!models.length ? (
        <p className="muted">
          No models are available. An administrator needs to connect an
          inference account.
        </p>
      ) : null}
      <ErrorNotice message={modelsError} />
    </AsyncForm>
  );
}
function Thread({
  id,
  project,
  models,
  refresh,
  onDeleted,
}: {
  id: string;
  project: Project;
  models: Model[];
  refresh: () => void;
  onDeleted: () => void;
}) {
  const { user, orgBase } = useWorkspace();
  const detail = useResource<Conversation>(`/api/conversations/${id}`);
  const messages = useResource<Messages>(`/api/conversations/${id}/messages`);
  const runs = useResource<List<Run>>(`/api/conversations/${id}/runs`);
  const [older, setOlder] = useState<Message[]>([]);
  const [history, setHistory] = useState<Message[]>([]);
  const pendingKey = `wme:pending:${user.id}:${id}`;
  const [restored] = useState(() => loadPendingMessage(pendingKey));
  const [before, setBefore] = useState<string | null>(null);
  const [olderLoaded, setOlderLoaded] = useState(false);
  const [draft, setDraft] = useState(restored?.content ?? "");
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState(Boolean(restored));
  const request = useRef<{ id: string; content: string } | undefined>(restored);
  const [error, setError] = useState("");
  const [streamState, setStreamState] = useState("Connecting…");
  const [initialCursor, setInitialCursor] = useState<number>();
  const [tool, setTool] = useState("");
  const [editing, setEditing] = useState(false);
  const [members, setMembers] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const active =
    runs.data?.items.filter((r) => activeStatuses.has(r.status)) ?? [];
  const creator = detail.data?.createdBy === user.id;
  useEffect(() => {
    if (detail.data && initialCursor === undefined)
      setInitialCursor(detail.data.lastEventId ?? 0);
  }, [detail.data, initialCursor]);
  useEffect(() => {
    if (initialCursor === undefined) return;
    let timer: number | undefined;
    let disposed = false;
    const source = new EventSource(
      `/api/conversations/${id}/events?after=${initialCursor}`,
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
      let event: { type: string; data?: Record<string, unknown> };
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
      if (event.type === "members.changed") detail.reload();
      if (event.type === "run.queued" || event.type === "run.started")
        detail.reload();
      if (
        event.type.startsWith("run.") &&
        !["run.queued", "run.started", "run.session"].includes(event.type)
      ) {
        setTool("");
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
      "assistant.citation",
      "files.reconciliation_failed",
      "tool.started",
      "tool.completed",
      "run.completed",
      "run.failed",
      "run.cancelled",
      "run.interrupted",
      "members.changed",
      "access.revoked",
    ])
      source.addEventListener(name, update);
    source.onopen = () => {
      setStreamState("Connected");
      reload();
    };
    source.onerror = () => setStreamState("Reconnecting…");
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [id, initialCursor, messages.reload, runs.reload, detail.reload, refresh]);
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages.data, tool]);
  useEffect(() => {
    if (messages.data)
      setHistory((previous) => mergeMessages(previous, messages.data!.items));
  }, [messages.data]);
  async function submit() {
    if (sending || (!draft.trim() && !request.current)) return;
    setSending(true);
    setError("");
    const pending = request.current ?? {
      id: crypto.randomUUID(),
      content: draft,
    };
    request.current = pending;
    savePendingMessage(pendingKey, pending);
    try {
      await send(`/api/conversations/${id}/messages`, {
        content: pending.content,
        requestId: pending.id,
      });
      request.current = undefined;
      clearPendingMessage(pendingKey);
      setUncertain(false);
      setDraft("");
      messages.reload();
      runs.reload();
      refresh();
      follow.current = true;
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
        `/api/conversations/${id}/messages?before=${encodeURIComponent(before ?? messages.data?.nextBefore ?? "")}`,
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
              ? "Read only for you"
              : detail.data?.mode === "write"
                ? "Full access"
                : "Read only"}{" "}
            · {detail.data?.harness} · {detail.data?.model}
          </small>
        </div>
        <div className="row-actions">
          <button
            className="icon-button"
            aria-label="Conversation members"
            onClick={() => setMembers(true)}
          >
            <Users size={18} />
          </button>
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
              <button
                className="icon-button danger"
                aria-label="Delete conversation"
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={17} />
              </button>
            </>
          ) : null}
        </div>
      </header>
      <ErrorNotice
        message={detail.error || messages.error || runs.error || error}
      />
      <div
        className="transcript"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el)
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 90;
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
        {messages.loading && !messages.data ? (
          <Loading />
        ) : !combined.length ? (
          <Empty title="What would you like to work on?">
            Your agent can use the files available in this project.
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
                  m.content ? (
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
                    c.url?.startsWith("/api/files/") ? (
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
            <span className="connection-state">
              {active.length
                ? `${active.length} ${active.length === 1 ? "run" : "runs"} in progress`
                : streamState}
            </span>
            <div className="row-actions">
              {active.length ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    try {
                      await send(`/api/conversations/${id}/cancel`, {});
                      runs.reload();
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                >
                  <Square size={14} />
                  Stop
                </button>
              ) : null}
              <button
                type="submit"
                className="send-button"
                aria-label={uncertain ? "Retry message" : "Send message"}
                disabled={sending || (!draft.trim() && !uncertain)}
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
            models={models}
            conversation={detail.data}
            onCancel={() => setEditing(false)}
            onSave={async (body) => {
              await send(`/api/conversations/${id}`, body, "PATCH");
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
          project={project}
          creator={creator}
          onClose={() => setMembers(false)}
        />
      ) : null}
      {deleting ? (
        <Confirm
          title="Delete conversation?"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api(`/api/conversations/${id}`, { method: "DELETE" });
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
  project,
  creator,
  onClose,
}: {
  id: string;
  project: Project;
  creator: boolean;
  onClose: () => void;
}) {
  const members = useResource<List<User & { isCreator?: boolean }>>(
    `/api/conversations/${id}/members`,
  );
  const people = useResource<List<User>>(`/api/projects/${project.id}/members`);
  const [error, setError] = useState("");
  return (
    <Modal title="Conversation members" onClose={onClose}>
      <p className="muted">
        Conversations are private until you add people. Everyone here can read
        and send messages.
      </p>
      <ErrorNotice message={members.error || people.error || error} />
      {members.data?.items.map((u) => (
        <div className="setting-row" key={u.id}>
          <div>
            {u.name || u.email}
            <small>{u.email}</small>
          </div>
          {creator && !u.isCreator ? (
            <button
              className="text-button danger"
              onClick={async () => {
                try {
                  await api(`/api/conversations/${id}/members/${u.id}`, {
                    method: "DELETE",
                  });
                  members.reload();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
      {creator ? (
        <AsyncForm
          submitLabel="Add person"
          onSubmit={async (d) => {
            await send(`/api/conversations/${id}/members`, {
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
