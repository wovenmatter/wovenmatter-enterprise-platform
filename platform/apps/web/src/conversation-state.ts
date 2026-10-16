export type PendingMessage = {
  id: string;
  content: string;
  kind?: "message" | "comment";
};
export function emptyAssistantLabel(status?: string) {
  if (status === "queued") return "Queued";
  if (status === "dispatching" || status === "running") return "Working…";
  if (status === "cancelling") return "Stopping…";
  return "No response generated.";
}

// Coalesce events while a read is in flight. Continuous fast events must not
// abort slow successful reads, and only one follow-up is needed for dirty state.
export function coalescedReader(read: () => Promise<void>) {
  let inFlight = false;
  let dirty = false;
  let disposed = false;
  async function trigger() {
    if (disposed) return;
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    try {
      await read();
    } finally {
      inFlight = false;
      if (dirty && !disposed) {
        dirty = false;
        void trigger();
      }
    }
  }
  return {
    trigger: () => {
      void trigger();
    },
    dispose: () => {
      disposed = true;
      dirty = false;
    },
  };
}
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tabStorage(): StorageLike | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

// This is message content and an idempotency identity, never an inference credential.
// Keys include the signed-in user and conversation so another account cannot pick it up.
export function loadPendingMessage(
  key: string,
  storage = tabStorage(),
): PendingMessage | undefined {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return;
    const candidate = value as Partial<PendingMessage>;
    if (
      typeof candidate.id !== "string" ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(candidate.id)
    )
      return;
    if (
      typeof candidate.content !== "string" ||
      candidate.content.length > 100_000
    )
      return;
    return {
      id: candidate.id,
      content: candidate.content,
      ...(candidate.kind === "comment" ? { kind: "comment" as const } : {}),
    };
  } catch {
    return;
  }
}
export function savePendingMessage(
  key: string,
  message: PendingMessage,
  storage = tabStorage(),
) {
  try {
    storage?.setItem(key, JSON.stringify(message));
  } catch {
    /* In-memory retry identity remains valid if browser storage is unavailable. */
  }
}
export function clearPendingMessage(key: string, storage = tabStorage()) {
  try {
    storage?.removeItem(key);
  } catch {
    /* Restricted browser storage may be unavailable. */
  }
}
export function mergeMessages<T extends { id: string; createdAt: string }>(
  previous: T[],
  latest: T[],
): T[] {
  const merged = new Map(previous.map((message) => [message.id, message]));
  for (const message of latest) merged.set(message.id, message);
  return [...merged.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}
export function safeContentUrl(url: string): string | undefined {
  if (/[\u0000-\u0020\\]/.test(url) || url.startsWith("//")) return;
  if (url.startsWith("/") || url.startsWith("#")) return url;
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol)
      ? parsed.href
      : undefined;
  } catch {
    return;
  }
}

export function loadConversationDraft(
  key: string,
  storage = tabStorage(),
): { content: string; kind: "message" | "comment" } | undefined {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? "null");
    if (
      value &&
      typeof value.content === "string" &&
      value.content.length <= 100000 &&
      ["message", "comment"].includes(value.kind)
    )
      return { content: value.content, kind: value.kind };
  } catch {
    /* Restricted storage must not prevent composing. */
  }
}
export function saveConversationDraft(
  key: string,
  content: string,
  kind: "message" | "comment",
  storage = tabStorage(),
) {
  try {
    if (content) storage?.setItem(key, JSON.stringify({ content, kind }));
    else storage?.removeItem(key);
  } catch {
    /* The current draft remains available in memory. */
  }
}

// A POST can settle after its component unmounts. Do not erase a newer draft
// or another request's receipt when its older acknowledgement arrives.
export function settleConversationInput(
  pendingKey: string,
  draftKey: string,
  pending: PendingMessage,
  storage = tabStorage(),
) {
  if (loadPendingMessage(pendingKey, storage)?.id !== pending.id) return;
  const draft = loadConversationDraft(draftKey, storage);
  if (
    draft?.content === pending.content &&
    draft.kind === (pending.kind ?? "message")
  )
    try {
      storage?.removeItem(draftKey);
    } catch {
      /* Restricted storage. */
    }
  clearPendingMessage(pendingKey, storage);
}
