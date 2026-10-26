import { ConversationHTML } from "./ConversationHTML";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleDot,
  Copy,
  ListChecks,
  LoaderCircle,
  Search,
  Sparkles,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { api, errorMessage } from "../api";
import { Modal } from "../components/ui";
import { Icon } from "../components/controls";
import { RichText } from "../components/RichText";
import { useCopyFeedback } from "../components/useCopyFeedback";
import {
  mergeActivities,
  workParts,
  type Activity,
  type ActivityPage,
} from "../activity-state";

/** Work disclosure indicator: follows its label, right closed and down open. */
function WorkChevron({ size = 11 }: { size?: number }) {
  return (
    <Icon icon={ChevronRight} size={size} weight="search" className="work-chevron" />
  );
}
export function useConversationActivities(id: string) {
  const [items, setItems] = useState<Activity[]>([]);
  const activeId = useRef(id);
  activeId.current = id;
  const [error, setError] = useState("");
  const [before, setBefore] = useState<number | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const trigger = useRef<() => void>(() => {});
  const reload = useCallback(() => trigger.current(), []);
  useEffect(() => {
    const abort = new AbortController();
    let cursor: string | undefined,
      busy = false,
      again = false;
    setItems([]);
    setError("");
    setBefore(null);
    setHasOlder(false);
    async function read() {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          const initial = cursor === undefined;
          const page: ActivityPage = await api(
            "/enterprise/api/conversations/" +
              id +
              "/activities" +
              (cursor === undefined
                ? ""
                : "?after=" + encodeURIComponent(cursor)),
            { signal: abort.signal },
          );
          if (abort.signal.aborted) return;
          setItems((previous) => mergeActivities(previous, page.items));
          if (initial) {
            setBefore(page.nextBefore);
            setHasOlder(page.hasMore);
          }
          cursor = page.cursor;
          if (!initial && page.hasMore) again = true;
          setError("");
        } while (again && !abort.signal.aborted);
      } catch (e) {
        if (!abort.signal.aborted) setError(errorMessage(e));
      } finally {
        busy = false;
      }
    }
    trigger.current = () => {
      void read();
    };
    void read();
    return () => {
      abort.abort();
      trigger.current = () => {};
    };
  }, [id]);
  const loadOlder = useCallback(async () => {
    if (before === null) return;
    const page = await api<ActivityPage>(
      "/enterprise/api/conversations/" + id + "/activities?before=" + before,
    );
    if (activeId.current !== id) return;
    setItems((previous) => mergeActivities(previous, page.items));
    setBefore(page.nextBefore);
    setHasOlder(page.hasMore);
  }, [id, before]);
  const loadRun = useCallback(
    async (runId: string) => {
      let after = 0;
      for (;;) {
        const page = await api<{
          items: Activity[];
          hasMore: boolean;
          nextAfter: number;
        }>(
          `/enterprise/api/conversations/${id}/activities?runId=${encodeURIComponent(runId)}&runAfter=${after}`,
        );
        if (activeId.current !== id) return;
        setItems((previous) => mergeActivities(previous, page.items));
        if (!page.hasMore) return;
        after = page.nextAfter;
      }
    },
    [id],
  );
  return { items, error, reload, loadOlder, loadRun, hasOlder };
}
type Detail = {
  stale: boolean;
  revision: number;
  text?: string;
  nextOffset?: number;
  hasMore?: boolean;
};
const detailCache = new Map<string, string>();
function remember(key: string, value: string) {
  if (value.length > 262144) return;
  detailCache.delete(key);
  detailCache.set(key, value);
  while (detailCache.size > 32)
    detailCache.delete(detailCache.keys().next().value!);
}
function useDetail(id: string, item: Activity, enabled: boolean) {
  const [state, setState] = useState({
    text: "",
    nextOffset: 0,
    hasMore: false,
    revision: 0,
    error: "",
  });
  const [requested, setRequested] = useState(32768);
  const endpoint =
    "/enterprise/api/conversations/" +
    id +
    "/activities/" +
    encodeURIComponent(item.runId) +
    "/" +
    encodeURIComponent(item.key);
  const cacheKey = id + "/" + item.runId + "/" + item.key + "/" + item.revision;
  useEffect(() => {
    if (!enabled) return;
    const cached = detailCache.get(cacheKey);
    if (cached !== undefined) {
      setState({
        text: cached,
        nextOffset: [...cached].length,
        hasMore: false,
        revision: item.revision,
        error: "",
      });
      return;
    }
    const abort = new AbortController();
    void (async () => {
      let text = "",
        offset = 0,
        hasMore = true;
      try {
        while (hasMore && offset < requested && !abort.signal.aborted) {
          const page = await api<Detail>(
            endpoint + "?offset=" + offset + "&revision=" + item.revision,
            { signal: abort.signal },
          );
          if (page.stale) return;
          text += page.text ?? "";
          offset = page.nextOffset ?? offset;
          hasMore = Boolean(page.hasMore);
          if (!abort.signal.aborted)
            setState({
              text,
              nextOffset: offset,
              hasMore,
              revision: item.revision,
              error: "",
            });
        }
        if (
          !hasMore &&
          !["running", "working", "cancelling"].includes(item.status)
        )
          remember(cacheKey, text);
      } catch (e) {
        if (!abort.signal.aborted)
          setState((previous) => ({ ...previous, error: errorMessage(e) }));
      }
    })();
    return () => abort.abort();
  }, [enabled, cacheKey, endpoint, item.revision, item.status, requested]);
  return {
    ...state,
    loadMore: () => setRequested((value) => value + 32768),
    endpoint,
  };
}
function useVisible<T extends HTMLElement>() {
  const ref = useRef<T>(null),
    [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries[0]?.isIntersecting ?? false),
      { rootMargin: "160px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, visible };
}
const TextActivity = memo(function TextActivity({
  id,
  item,
}: {
  id: string;
  item: Activity;
}) {
  const { ref, visible } = useVisible<HTMLDivElement>();
  const detail = useDetail(id, item, visible);
  const { copyState, copy: copyFeedback } = useCopyFeedback(`${id}:${item.key}:${item.revision}`);
  async function copy() {
    await copyFeedback(async () => {
      let offset = 0,
        complete = "";
      for (;;) {
        const page = await api<Detail>(
          detail.endpoint + "?offset=" + offset + "&revision=" + item.revision,
        );
        if (page.stale)
          throw new Error("The response changed. Try Copy again.");
        complete += page.text ?? "";
        if (!page.hasMore) break;
        offset = page.nextOffset!;
      }
      await navigator.clipboard.writeText(complete);
    });
  }
  return (
    <div
      ref={ref}
      className={
        "native-response " +
        (item.kind === "final" ? "native-final" : "native-commentary")
      }
    >
      <RichText>{detail.text || item.preview}</RichText>
      {detail.error ? <small className="danger">{detail.error}</small> : null}
      {detail.hasMore ? (
        <button type="button" className="text-button" onClick={detail.loadMore}>
          Show more
        </button>
      ) : null}
      {item.kind === "final" ? (
        <div className="response-actions">
          <button
            type="button"
            className="icon-button small"
            aria-label="Copy response"
            title="Copy complete response"
            onClick={() => void copy()}
          >
            <Icon
              icon={copyState === "Copied" ? Check : Copy}
              size={12}
              weight="control"
            />
          </button>
          <small role="status">{copyState}</small>
        </div>
      ) : null}
    </div>
  );
});
const ActivityDetails = memo(function ActivityDetails({
  id,
  item,
  onInspect,
}: {
  id: string;
  item: Activity;
  onInspect(): void;
}) {
  const [open, setOpen] = useState(false),
    { ref, visible } = useVisible<HTMLDetailsElement>();
  const detail = useDetail(id, item, open && visible);
  return (
    <details
      ref={ref}
      className="native-work-item"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (next) onInspect();
      }}
    >
      <summary data-status={item.status}>
        <span className="work-title">
          {item.title || (item.kind === "thinking" ? "Thinking" : "Work")}
        </span>
        <WorkChevron size={10} />
        <small>{item.status}</small>
        {item.kind === "subagent" && item.metadata.model ? (
          <small>{String(item.metadata.model)}</small>
        ) : null}
      </summary>
      {open ? (
        <div className="native-work-detail">
          {detail.error ? <p className="danger">{detail.error}</p> : null}
          <pre>{detail.text || item.preview || "Loading details…"}</pre>
          {detail.hasMore ? (
            <button
              type="button"
              className="text-button"
              onClick={detail.loadMore}
            >
              Load more details
            </button>
          ) : null}
        </div>
      ) : null}
    </details>
  );
});
function WorkGroup({
  id,
  items,
  onInspect,
}: {
  id: string;
  items: Activity[];
  onInspect(): void;
}) {
  const tools = items.filter((item) => item.kind === "tool").length;
  const commands = items.filter(
    (item) => item.kind === "tool" && item.metadata.toolKind === "execute",
  ).length;
  const working = items.some((item) =>
    ["running", "working", "cancelling", "pending"].includes(item.status),
  );
  const failed = items.some((item) => item.status === "failed");
  const thoughtOnly = items.every((item) => item.kind === "thinking");
  const [open, setOpen] = useState(false);
  const label = tools
    ? commands === tools
      ? (working ? "Running " : "Ran ") +
        tools +
        (tools === 1 ? " command" : " commands")
      : (working ? "Using " : "Used ") +
        tools +
        (tools === 1 ? " tool" : " tools")
    : items.some((item) => item.kind === "subagent")
      ? "Subagent activity"
      : "Thinking";
  return (
    <details
      className="native-work-group"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open) onInspect();
      }}
    >
      <summary
        className={failed && !working ? "is-failed" : thoughtOnly ? "is-thought" : ""}
      >
        <span className="work-icon">
          <Icon
            icon={
              working
                ? LoaderCircle
                : failed
                  ? TriangleAlert
                  : thoughtOnly
                    ? Sparkles
                    : Wrench
            }
            size={12}
            weight="control"
            className={working ? "spin" : undefined}
          />
        </span>
        <span className="work-title">{label}</span>
        <WorkChevron size={10} />
        {working ? <span className="sr-only">Working</span> : null}
      </summary>
      {open
        ? items.map((item) => (
            <ActivityDetails
              key={item.key}
              id={id}
              item={item}
              onInspect={onInspect}
            />
          ))
        : null}
    </details>
  );
}
export const ConversationRunWork = memo(function ConversationRunWork({
  id,
  items,
  status,
  startedAt,
  completedAt,
  onInspect,
}: {
  id: string;
  items: Activity[];
  status?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  onInspect(): void;
}) {
  const parts = useMemo(() => workParts(items), [items]);
  const [expanded, setExpanded] = useState(false);
  const inspect = useCallback(() => {
    setExpanded(true);
    onInspect();
  }, [onInspect]);
  const settled = Boolean(
    status &&
      !["queued", "dispatching", "running", "cancelling"].includes(status),
  );
  const final = parts.find(
    (part) => part.kind === "text" && part.item.kind === "final",
  );
  const visuals=parts.filter(part=>part.kind==="activity"&&part.item.kind==="html");
  const work = parts.filter((part) => part !== final && !visuals.includes(part));
  const duration =
    startedAt && completedAt
      ? Math.max(
          0,
          Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000),
        )
      : undefined;
  const render = (part: (typeof parts)[number]) =>
    part.kind === "text" ? (
      <TextActivity key={part.item.key} id={id} item={part.item} />
    ) : part.kind === "activity" && part.item.kind==="html" ? (
      <ConversationHTML key={part.item.key} conversationId={id} item={part.item}/>
    ) : part.kind === "activity" ? (
      <ActivityDetails
        key={part.item.key}
        id={id}
        item={part.item}
        onInspect={inspect}
      />
    ) : (
      <WorkGroup key={part.id} id={id} items={part.items} onInspect={inspect} />
    );
  return (
    <div className="native-transcript">
      {work.length ? (
        <details
          className={"native-completed-work" + (settled ? "" : " is-active")}
          open={!settled || expanded}
          onToggle={(event) => {
            if (settled) {
              setExpanded(event.currentTarget.open);
              if (event.currentTarget.open) onInspect();
            }
          }}
        >
          <summary className={status === "completed" || status === "cancelled" ? "" : "is-failed"}>
            {status === "completed" || status === "cancelled" ? null : (
              <Icon icon={TriangleAlert} size={13} weight="search" />
            )}
            <span>
              {status === "completed"
                ? "Worked"
                : status === "cancelled"
                  ? "Stopped"
                  : "Work interrupted"}
              {duration === undefined ? "" : " for " + duration + "s"}
            </span>
            <WorkChevron />
          </summary>
          {work.map(render)}
        </details>
      ) : null}
      {settled && !expanded
        ? items
            .filter(
              (item) =>
                !item.deleted &&
                item.status === "failed" &&
                !["message", "final", "checklist"].includes(item.kind),
            )
            .map((item) => (
              <ActivityDetails
                key={"failed:" + item.key}
                id={id}
                item={item}
                onInspect={onInspect}
              />
            ))
        : null}
      {visuals.map(render)}
      {final ? render(final) : null}
    </div>
  );
});
export function NativeChecklist({
  items,
  activeRunIds,
}: {
  items: Activity[];
  activeRunIds: Set<string>;
}) {
  const tasks = items
    .filter(
      (item) =>
        !item.deleted &&
        item.kind === "checklist" &&
        activeRunIds.has(item.runId),
    )
    .flatMap((item) =>
      Array.isArray(item.metadata.items)
        ? (item.metadata.items as {
            id: string;
            content: string;
            status: string;
          }[])
        : [],
    );
  const [expanded, setExpanded] = useState(false);
  if (!tasks.length) return null;
  const done = tasks.filter((item) => item.status === "completed").length;
  const current =
    tasks.find((item) => item.status === "in_progress") ??
    tasks.find((item) => item.status !== "completed") ??
    tasks.at(-1);
  const statusName = (status: string) =>
    status === "completed"
      ? "Completed"
      : status === "in_progress"
        ? "Running"
        : status === "cancelled"
          ? "Cancelled"
          : "Pending";
  return (
    <div className="native-task-badge">
      <button
        type="button"
        className="task-summary"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse tasks" : "Tasks"}: ${done} of ${tasks.length} complete. Current task: ${current?.content ?? ""}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="task-icon">
          <Icon icon={ListChecks} size={12} weight="control" />
        </span>
        <span className="task-label">Tasks</span>
        <span className="task-current">{current?.content}</span>
        <span className={`task-count${done === tasks.length ? " complete" : ""}`}>
          {done}/{tasks.length}
        </span>
        {tasks.length >= 2 && tasks.length <= 10 ? (
          <span className="task-segments" aria-hidden="true">
            {tasks.map((item, index) => (
              <span key={item.id + ":" + index} data-status={item.status} />
            ))}
          </span>
        ) : null}
        <Icon icon={ChevronUp} size={10} weight="search" className="task-chevron" />
      </button>
      {expanded ? (
        <ul aria-label={`Task list. ${done} of ${tasks.length} complete.`}>
          {tasks.map((item, index) => (
            <li
              key={item.id + ":" + index}
              data-status={item.status}
              aria-label={`${statusName(item.status)}: ${item.content}`}
            >
              <span className="task-icon" aria-hidden="true">
                <Icon
                  icon={
                    item.status === "completed"
                      ? Check
                      : item.status === "in_progress"
                        ? CircleDot
                        : Circle
                  }
                  size={11}
                  weight="search"
                />
              </span>
              <span>{item.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
function HistoryRecord({
  id,
  ordinal,
  kind,
  createdAt,
}: {
  id: string;
  ordinal: number;
  kind: string;
  createdAt: string;
}) {
  const [open, setOpen] = useState(false),
    [payload, setPayload] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void api<{ payload: string }>(
      "/enterprise/api/conversations/" + id + "/archive/" + ordinal,
      { signal: abort.signal },
    )
      .then((record) => {
        if (!abort.signal.aborted) setPayload(record.payload);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorMessage(e));
      });
    return () => abort.abort();
  }, [id, ordinal, open]);
  return (
    <details
      className="history-record"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <span>
          {kind} · {new Date(createdAt).toLocaleString()}
        </span>
        <WorkChevron size={10} />
      </summary>
      {open ? <pre>{error || payload || "Loading capture…"}</pre> : null}
    </details>
  );
}
export function NativeHistory({
  id,
  opened,
  onClose,
}: {
  id: string;
  opened?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [error, setError] = useState("");
  const [page, setPage] = useState<{
    items: {
      ordinal: number;
      kind: string;
      payload: string;
      createdAt: string;
    }[];
    cursor: number;
    hasMore: boolean;
  }>();
  const searchRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    setOpen(false);
    setPage(undefined);
    setQuery("");
    setError("");
    return () => searchRequest.current?.abort();
  }, [id]);
  async function search(more = false) {
    searchRequest.current?.abort();
    const request = new AbortController();
    searchRequest.current = request;
    try {
      const next = await api<NonNullable<typeof page>>(
        "/enterprise/api/conversations/" +
          id +
          "/archive?q=" +
          encodeURIComponent(query) +
          "&after=" +
          (more ? (page?.cursor ?? 0) : 0),
        { signal: request.signal },
      );
      if (request.signal.aborted) return;
      setPage((previous) =>
        more && previous
          ? { ...next, items: [...previous.items, ...next.items] }
          : next,
      );
      setError("");
    } catch (e) {
      if (!request.signal.aborted) setError(errorMessage(e));
    }
  }
  useEffect(() => {
    if (opened) void search();
  }, [opened, id]);
  return (
    <div className="native-history">
      {opened === undefined ? (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setOpen(true);
            void search();
          }}
        >
          Native history
        </button>
      ) : null}
      {(opened ?? open) ? (
        <Modal
          title="Native history"
          onClose={() => {
            setOpen(false);
            onClose?.();
          }}
        >
          <form
            className="history-search"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <label className="sr-only" htmlFor={"history-" + id}>
              Search native history
            </label>
            <input
              id={"history-" + id}
              value={query}
              maxLength={500}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search captured history"
            />
            <button
              type="submit"
              className="icon-button"
              aria-label="Search history"
            >
              <Icon icon={Search} size={14} weight="search" />
            </button>
            <a
              className="secondary button-link"
              href={"/enterprise/api/conversations/" + id + "/archive/export"}
            >
              Export
            </a>
          </form>
          {error ? (
            <p className="danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="native-history-results">
            {page?.items.map((item) => (
              <HistoryRecord
                key={item.ordinal}
                id={id}
                ordinal={item.ordinal}
                kind={item.kind}
                createdAt={item.createdAt}
              />
            ))}
            {page?.hasMore ? (
              <button
                type="button"
                className="text-button"
                onClick={() => void search(true)}
              >
                Load more captures
              </button>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
