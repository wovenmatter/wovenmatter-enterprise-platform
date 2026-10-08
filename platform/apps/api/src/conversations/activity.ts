import { randomUUID } from "node:crypto";
import type { Database, Statement } from "../db/index.js";

export const activitySchema = [
  "CREATE TABLE conversation_activity_clock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);",
  "INSERT INTO conversation_activity_clock VALUES(1,0);",
  "CREATE TABLE conversation_activity(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id),run_id TEXT NOT NULL REFERENCES conversation_runs(id),activity_key TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,preview TEXT NOT NULL DEFAULT '',metadata TEXT NOT NULL DEFAULT '{}',revision INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(run_id,activity_key));",
  "CREATE INDEX conversation_activity_revision ON conversation_activity(conversation_id,revision);",
  "CREATE INDEX conversation_activity_order ON conversation_activity(conversation_id,ordinal);",
  "CREATE TABLE conversation_activity_content(run_id TEXT NOT NULL,activity_key TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',PRIMARY KEY(run_id,activity_key));",
  "CREATE TABLE conversation_activity_snapshots(run_id TEXT NOT NULL,snapshot_key TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(run_id,snapshot_key));",
  "CREATE TABLE conversation_activity_state(run_id TEXT PRIMARY KEY REFERENCES conversation_runs(id),message_number INTEGER NOT NULL DEFAULT 0,message_open INTEGER NOT NULL DEFAULT 0);",
  "CREATE TABLE conversation_native_records(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id),run_id TEXT NOT NULL REFERENCES conversation_runs(id),source_id TEXT NOT NULL,record_id TEXT NOT NULL,revision TEXT NOT NULL,native_session_id TEXT,kind TEXT NOT NULL,search_text TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(run_id,source_id,record_id,revision));",
  "CREATE INDEX conversation_native_records_page ON conversation_native_records(conversation_id,ordinal);",
].join("\n");

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as ObjectValue)
    : {};
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const label = (v: unknown, max = 240): string => text(v).slice(0, max);
const currentRevision =
  "(SELECT revision FROM conversation_activity_clock WHERE id=1)";
const tick: Statement = {
  sql: "UPDATE conversation_activity_clock SET revision=revision+1 WHERE id=1",
};
export interface ActivityRun {
  id: string;
  conversation_id: string;
}
export interface ActivitySummary {
  ordinal: number;
  runId: string;
  key: string;
  kind: string;
  title: string;
  status: string;
  preview: string;
  metadata: ObjectValue;
  revision: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
interface Row {
  ordinal: number;
  run_id: string;
  activity_key: string;
  kind: string;
  title: string;
  status: string;
  preview: string;
  metadata: string;
  revision: number;
  deleted: number;
  created_at: string;
  updated_at: string;
}
const summaryColumns =
  "ordinal,run_id,activity_key,kind,title,status,preview,metadata,revision,deleted,created_at,updated_at";
const summary = (r: Row): ActivitySummary => ({
  ordinal: r.ordinal,
  runId: r.run_id,
  key: r.activity_key,
  kind: r.kind,
  title: r.title,
  status: r.status,
  preview: r.preview,
  metadata: object(JSON.parse(r.metadata)),
  revision: r.revision,
  deleted: Boolean(r.deleted),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
function upsert(
  run: ActivityRun,
  key: string,
  kind: string,
  title: string,
  status: string,
  preview: string,
  metadata: ObjectValue,
  at: string,
): Statement[] {
  return [
    tick,
    {
      sql:
        "INSERT INTO conversation_activity(conversation_id,run_id,activity_key,kind,title,status,preview,metadata,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?," +
        currentRevision +
        ",?,?) ON CONFLICT(run_id,activity_key) DO UPDATE SET kind=excluded.kind,title=excluded.title,status=excluded.status,preview=excluded.preview,metadata=excluded.metadata,revision=excluded.revision,deleted=0,updated_at=excluded.updated_at",
      params: [
        run.conversation_id,
        run.id,
        key,
        kind,
        title,
        status,
        preview.slice(0, 500),
        JSON.stringify(metadata),
        at,
        at,
      ],
    },
  ];
}
function content(
  runId: string,
  key: string,
  value: string,
  append = false,
): Statement {
  return {
    sql:
      "INSERT INTO conversation_activity_content(run_id,activity_key,content) VALUES(?,?,?) ON CONFLICT(run_id,activity_key) DO UPDATE SET content=" +
      (append
        ? "conversation_activity_content.content||excluded.content"
        : "excluded.content"),
    params: [runId, key, value],
  };
}
function rawRecord(
  run: ActivityRun,
  sourceId: string,
  recordId: string,
  revision: string,
  kind: string,
  payload: unknown,
  searchable: string,
  at: string,
  sessionId?: string,
): Statement {
  return {
    sql: "INSERT OR IGNORE INTO conversation_native_records(conversation_id,run_id,source_id,record_id,revision,native_session_id,kind,search_text,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    params: [
      run.conversation_id,
      run.id,
      sourceId,
      recordId,
      revision,
      sessionId ?? null,
      kind,
      searchable,
      JSON.stringify(payload),
      at,
    ],
  };
}

/** Statements join the coordinator's cursor transaction: capture and projection commit before publication. */
export async function projectNativeUpdate(
  db: Database,
  run: ActivityRun,
  update: ObjectValue,
  sequence: number | undefined,
  at = new Date().toISOString(),
): Promise<Statement[]> {
  const type = text(update.sessionUpdate);
  const meta = object(update._meta);
  const identity = sequence === undefined ? randomUUID() : String(sequence);
  const statements: Statement[] = [
    rawRecord(
      run,
      "presentation",
      identity,
      "1",
      type,
      update,
      searchableText(update),
      at,
    ),
    {
      sql: "INSERT OR IGNORE INTO conversation_activity_state(run_id) VALUES(?)",
      params: [run.id],
    },
  ];
  const snapshot =
    meta.wovenAssistantSnapshot === true || meta.wovenThoughtSnapshot === true;
  if (
    snapshot &&
    (meta.wovenSnapshotStart !== undefined ||
      meta.wovenSnapshotEnd !== undefined)
  ) {
    const key =
      type === "agent_message_chunk"
        ? "assistant"
        : "thought:" + label(meta.wovenThoughtID, 512);
    const start = meta.wovenSnapshotStart === true,
      end = meta.wovenSnapshotEnd === true;
    const fragment = text(object(update.content).text);
    if (
      !start &&
      !(await db.get(
        "SELECT 1 FROM conversation_activity_snapshots WHERE run_id=? AND snapshot_key=?",
        [run.id, key],
      ))
    )
      throw new Error("Snapshot continuation has no matching start.");
    if (!end) {
      statements.push({
        sql:
          "INSERT INTO conversation_activity_snapshots(run_id,snapshot_key,content) VALUES(?,?,?) ON CONFLICT(run_id,snapshot_key) DO UPDATE SET content=" +
          (start
            ? "excluded.content"
            : "conversation_activity_snapshots.content||excluded.content"),
        params: [run.id, key, fragment],
      });
      return statements;
    }
    const prior = start
      ? ""
      : (await db.get<{ content: string }>(
          "SELECT content FROM conversation_activity_snapshots WHERE run_id=? AND snapshot_key=?",
          [run.id, key],
        ))!.content;
    update = {
      ...update,
      content: { ...object(update.content), text: prior + fragment },
    };
    statements.push({
      sql: "DELETE FROM conversation_activity_snapshots WHERE run_id=? AND snapshot_key=?",
      params: [run.id, key],
    });
  }
  const state = (await db.get<{ message_number: number; message_open: number }>(
    "SELECT message_number,message_open FROM conversation_activity_state WHERE run_id=?",
    [run.id],
  )) ?? { message_number: 0, message_open: 0 };
  const closeMessage = () => {
    if (state.message_open)
      statements.push({
        sql: "UPDATE conversation_activity_state SET message_number=message_number+1,message_open=0 WHERE run_id=?",
        params: [run.id],
      });
  };
  if (type === "woven_assistant_boundary") {
    closeMessage();
  } else if (type === "agent_message_chunk") {
    const value = text(object(update.content).text);
    if (!value && !meta.wovenAssistantSnapshot && !meta.nativeMessageSnapshot)
      return statements;
    const nativeId = label(meta.nativeMessageID, 1024);
    const key = nativeId
      ? "native-message:" + nativeId
      : "message:" + state.message_number;
    const messageMeta = nativeId ? { nativeMessageID: nativeId } : {};
    const existing = await db.get<Row>(
      "SELECT " +
        summaryColumns +
        " FROM conversation_activity WHERE run_id=? AND activity_key=?",
      [run.id, key],
    );
    if (meta.wovenAssistantSnapshot) {
      // Snapshot reconciliation is deliberately rare and separate from compact refreshes.
      const previous = await db.all<{ activity_key: string; content: string }>(
        "SELECT a.activity_key,c.content FROM conversation_activity a JOIN conversation_activity_content c ON c.run_id=a.run_id AND c.activity_key=a.activity_key WHERE a.run_id=? AND a.kind IN ('message','final') ORDER BY a.ordinal",
        [run.id],
      );
      let offset = 0;
      for (const item of previous) {
        if (item.activity_key === key) break;
        const replacement = value.slice(offset, offset + item.content.length);
        offset += item.content.length;
        statements.push(tick, content(run.id, item.activity_key, replacement), {
          sql:
            "UPDATE conversation_activity SET preview=?,revision=" +
            currentRevision +
            ",updated_at=? WHERE run_id=? AND activity_key=?",
          params: [replacement.slice(0, 500), at, run.id, item.activity_key],
        });
      }
      const replacement = value.slice(offset);
      statements.push(
        ...upsert(run, key, "message", "", "running", replacement, {}, at),
        content(run.id, key, replacement),
      );
    } else if (meta.nativeMessageSnapshot) {
      statements.push(
        ...upsert(run, key, "message", "", "running", value, messageMeta, at),
        content(run.id, key, value),
      );
    } else {
      statements.push(
        ...upsert(
          run,
          key,
          "message",
          "",
          "running",
          (existing?.preview ?? "") + value,
          messageMeta,
          at,
        ),
        content(run.id, key, value, true),
      );
    }
    statements.push({
      sql: "UPDATE conversation_activity_state SET message_open=1 WHERE run_id=?",
      params: [run.id],
    });
  } else if (type === "agent_thought_chunk") {
    const key =
      "thought:" +
      (label(meta.wovenThoughtID, 512) || String(state.message_number));
    const value = text(object(update.content).text);
    const existing = await db.get<Row>(
      "SELECT " +
        summaryColumns +
        " FROM conversation_activity WHERE run_id=? AND activity_key=?",
      [run.id, key],
    );
    statements.push(
      ...upsert(
        run,
        key,
        "thinking",
        "Thinking",
        meta.wovenThoughtStatus === "completed" ? "completed" : "running",
        meta.wovenThoughtSnapshot ? value : (existing?.preview ?? "") + value,
        {},
        at,
      ),
      content(run.id, key, value, !meta.wovenThoughtSnapshot),
    );
  } else if (type === "tool_call" || type === "tool_call_update") {
    const toolId = text(update.toolCallId);
    if (!toolId || toolId.length > 1024) return statements;
    if (type === "tool_call") closeMessage();
    const key = "tool:" + toolId;
    const existing = await db.get<Row>(
      "SELECT " +
        summaryColumns +
        " FROM conversation_activity WHERE run_id=? AND activity_key=?",
      [run.id, key],
    );
    const priorMeta = object(existing ? JSON.parse(existing.metadata) : {});
    const input =
      update.rawInput === undefined
        ? ""
        : (typeof update.rawInput === "string"
            ? update.rawInput
            : JSON.stringify(update.rawInput, null, 2)) + "\n\n";
    const metadata = {
      ...priorMeta,
      toolCallId: toolId,
      toolKind: label(update.kind) || priorMeta.toolKind,
      inputLength:
        type === "tool_call"
          ? [...input].length
          : Number(priorMeta.inputLength ?? 0),
    };
    const status = ["completed", "failed", "cancelled"].includes(
      text(update.status),
    )
      ? text(update.status)
      : "running";
    const output = object(object(update.rawOutput).output);
    const exposed = Array.isArray(update.content)
      ? update.content
          .map((part) => {
            const wrapped = object(part),
              value = object(wrapped.content);
            return text(value.text) || text(wrapped.text);
          })
          .join("\n")
      : "";
    statements.push(
      ...upsert(
        run,
        key,
        "tool",
        label(update.title) || existing?.title || "Tool",
        status,
        exposed ||
          text(output.set) ||
          text(output.append) ||
          existing?.preview ||
          "",
        metadata,
        at,
      ),
    );
    if (type === "tool_call") statements.push(content(run.id, key, input));
    else {
      statements.push({
        sql: "INSERT OR IGNORE INTO conversation_activity_content(run_id,activity_key,content) VALUES(?,?,?)",
        params: [run.id, key, ""],
      });
      // Display the exposed output, with its native replacement/append semantics.
      // The unmodified event is independently preserved in the canonical archive.
      const replacement =
        exposed || (typeof output.set === "string" ? output.set : undefined);
      const prefix = Number(metadata.inputLength);
      if (replacement !== undefined)
        statements.push({
          sql: "UPDATE conversation_activity_content SET content=substr(content,1,?)||? WHERE run_id=? AND activity_key=?",
          params: [prefix, replacement, run.id, key],
        });
      else if (
        typeof output.append === "string" ||
        typeof output.trimStart === "number"
      )
        statements.push({
          sql: "UPDATE conversation_activity_content SET content=substr(content,1,?)||substr(content,?)||? WHERE run_id=? AND activity_key=?",
          params: [
            prefix,
            prefix + Math.max(0, Number(output.trimStart ?? 0)) + 1,
            text(output.append),
            run.id,
            key,
          ],
        });
    }
  } else if (type === "plan") {
    // Proposed plans remain content; only a native checklist can drive execution progress.
    const entries = Array.isArray(update.entries) ? update.entries : [];
    const items = entries.map((entry, index) => {
      const item = object(entry);
      return {
        id: label(item.id, 128) || String(index),
        content: label(item.content, 1024),
        status: label(item.status, 40),
      };
    });
    if (meta.wovenPlanKind !== "checklist") {
      const value = items.map((item) => item.content).join("\n");
      statements.push(
        ...upsert(
          run,
          "proposal",
          "plan",
          "Proposed plan",
          "completed",
          value,
          {},
          at,
        ),
        content(run.id, "proposal", value),
      );
      return statements;
    }
    const key = "checklist:" + (label(meta.wovenPlanOwner, 128) || "root");
    const existing = await db.get<Row>(
      "SELECT " +
        summaryColumns +
        " FROM conversation_activity WHERE run_id=? AND activity_key=?",
      [run.id, key],
    );
    let merged = items;
    if (meta.wovenPlanOperation === "merge") {
      const prior = object(existing ? JSON.parse(existing.metadata) : {}).items;
      const map = new Map<string, unknown>();
      for (const item of Array.isArray(prior) ? prior : [])
        map.set(text(object(item).id), item);
      for (const item of items) map.set(item.id, item);
      merged = [...map.values()] as typeof items;
    }
    if (meta.wovenPlanOperation === "clear") merged = [];
    statements.push(
      ...upsert(
        run,
        key,
        "checklist",
        "Tasks",
        "running",
        "",
        { items: merged },
        at,
      ),
      content(run.id, key, JSON.stringify(update)),
    );
  } else if (type === "woven_subagents") {
    for (const value of Array.isArray(update.subagents)
      ? update.subagents
      : []) {
      const child = object(value),
        id = String(
          child.id ?? child.childID ?? child.nativeConversationID ?? "",
        ).slice(0, 128);
      if (!id) continue;
      statements.push(
        ...upsert(
          run,
          "child:" + id,
          "subagent",
          label(child.name) || "Subagent",
          label(child.state, 40) || "working",
          label(child.task ?? child.result, 500),
          {
            id,
            model: label(child.modelID ?? child.modelId),
            connection: label(child.connectionLabel ?? child.accountLabel),
            nativeConversationID: child.nativeConversationID,
            nativeSessionID: child.nativeSessionID,
          },
          at,
        ),
        content(run.id, "child:" + id, JSON.stringify(child, null, 2)),
      );
    }
  }
  return statements;
}
function searchableText(update: ObjectValue): string {
  const values: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 12) return;
    if (typeof value === "string") {
      values.push(value);
      return;
    }
    if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (!/token|authorization|credential|secret|api.?key/i.test(key))
          walk(item, depth + 1);
      }
  };
  walk(update, 0);
  return values.join("\n");
}

export function captureNativeBatch(
  run: ActivityRun,
  batch: ObjectValue,
  at = new Date().toISOString(),
): Statement[] {
  const source = text(batch.sourceID),
    session = text(batch.nativeSessionID);
  if (!source || source.length > 1024)
    throw new Error("Invalid native archive source");
  return (Array.isArray(batch.records) ? batch.records : []).map((value) => {
    const record = object(value);
    if (!text(record.id) || text(record.id).length > 1024)
      throw new Error("Invalid native archive identity");
    return rawRecord(
      run,
      source,
      text(record.id),
      String(record.revision ?? ""),
      text(record.kind),
      record,
      text(record.text),
      at,
      session,
    );
  });
}
export function settleActivity(
  run: ActivityRun,
  status: string,
  at = new Date().toISOString(),
): Statement[] {
  return [
    {
      sql: "DELETE FROM conversation_activity_snapshots WHERE run_id=?",
      params: [run.id],
    },
    tick,
    {
      sql:
        "UPDATE conversation_activity SET status=CASE WHEN status IN ('running','working','cancelling','pending') THEN ? ELSE status END,revision=" +
        currentRevision +
        ",updated_at=? WHERE run_id=?",
      params: [status, at, run.id],
    },
    {
      sql: "UPDATE conversation_activity SET kind='final' WHERE run_id=? AND kind='message' AND ordinal=(SELECT MAX(ordinal) FROM conversation_activity WHERE run_id=? AND deleted=0 AND kind!='checklist' AND NOT(kind='thinking' AND preview=''))",
      params: [run.id, run.id],
    },
  ];
}
export async function readActivities(
  db: Database,
  conversationId: string,
  after?: string,
  before?: number,
) {
  const watermark =
    (
      await db.get<{ revision: number }>(
        "SELECT revision FROM conversation_activity_clock WHERE id=1",
      )
    )?.revision ?? 0;
  const incremental = after !== undefined;
  const [afterRevision, afterOrdinal] = (after ?? "0:0").split(":").map(Number);
  const rows = await db.all<Row>(
    "SELECT " +
      summaryColumns +
      " FROM conversation_activity WHERE conversation_id=? AND revision<=? " +
      (incremental
        ? "AND (revision>? OR (revision=? AND ordinal>?)) ORDER BY revision,ordinal LIMIT 201"
        : (before ? "AND ordinal<? " : "") + "ORDER BY ordinal DESC LIMIT 201"),
    incremental
      ? [conversationId, watermark, afterRevision, afterRevision, afterOrdinal]
      : before
        ? [conversationId, watermark, before]
        : [conversationId, watermark],
  );
  const more = rows.length > 200,
    page = rows.slice(0, 200),
    last = page.at(-1);
  return {
    items: (incremental ? page : page.reverse()).map(summary),
    cursor:
      incremental && more && last
        ? last.revision + ":" + last.ordinal
        : watermark + ":" + Number.MAX_SAFE_INTEGER,
    hasMore: more,
    nextBefore: !incremental && page.length ? page[0].ordinal : null,
  };
}
export async function readActivityDetail(
  db: Database,
  conversationId: string,
  runId: string,
  key: string,
  offset: number,
  revision?: number,
) {
  const page = await db.get<{ revision: number; text: string; length: number }>(
    "SELECT a.revision,substr(c.content,?,32768) text,length(c.content) length FROM conversation_activity a LEFT JOIN conversation_activity_content c ON c.run_id=a.run_id AND c.activity_key=a.activity_key WHERE a.conversation_id=? AND a.run_id=? AND a.activity_key=?",
    [offset + 1, conversationId, runId, key],
  );
  if (!page) return undefined;
  if (revision !== undefined && page.revision !== revision)
    return { stale: true, revision: page.revision };
  const nextOffset = offset + [...(page.text ?? "")].length;
  return {
    stale: false,
    revision: page.revision,
    text: page.text ?? "",
    offset,
    nextOffset,
    hasMore: nextOffset < (page.length ?? 0),
  };
}
export async function nativeArchivePage(
  db: Database,
  conversationId: string,
  after: number,
  query = "",
  runId?: string,
  full = true,
) {
  const escaped = query.replace(/[\\%_]/g, "\\$&");
  const items = await db.all<{
    ordinal: number;
    runId: string;
    sourceId: string;
    recordId: string;
    revision: string;
    kind: string;
    payload: string;
    createdAt: string;
  }>(
    "SELECT ordinal,run_id runId,source_id sourceId,record_id recordId,revision,kind," +
      (full ? "payload" : "NULL AS payload") +
      ",created_at createdAt FROM conversation_native_records WHERE conversation_id=? AND ordinal>? " +
      (runId ? "AND run_id=? " : "") +
      (query ? "AND search_text LIKE ? ESCAPE '\\' " : "") +
      "ORDER BY ordinal LIMIT 25",
    [
      conversationId,
      after,
      ...(runId ? [runId] : []),
      ...(query ? ["%" + escaped + "%"] : []),
    ],
  );
  return {
    items,
    cursor: items.at(-1)?.ordinal ?? after,
    hasMore: items.length === 25,
  };
}

export async function nativeArchiveRecord(
  db: Database,
  conversationId: string,
  ordinal: number,
) {
  return db.get<{ payload: string }>(
    "SELECT payload FROM conversation_native_records WHERE conversation_id=? AND ordinal=?",
    [conversationId, ordinal],
  );
}
