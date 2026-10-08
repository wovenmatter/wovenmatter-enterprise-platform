import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "../apps/api/src/db/index.ts";
import {
  activitySchema,
  projectNativeUpdate,
  captureNativeBatch,
  settleActivity,
  readActivities,
  readActivityDetail,
  nativeArchivePage,
} from "../apps/api/src/conversations/activity.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "wme-activity-"));
  let db = await createDatabase(join(root, "test.sqlite"));
  t.after(async () => {
    await db.close();
    await rm(root, { recursive: true, force: true });
  });
  await db.migrate(
    "base",
    "CREATE TABLE conversations(id TEXT PRIMARY KEY); CREATE TABLE conversation_runs(id TEXT PRIMARY KEY, runtime_cursor INTEGER NOT NULL DEFAULT 0); INSERT INTO conversations VALUES('c'); INSERT INTO conversation_runs(id) VALUES('r');",
  );
  await db.migrate("activity", activitySchema);
  let sequence = 0;
  const run = { id: "r", conversation_id: "c" };
  return {
    get db() {
      return db;
    },
    run,
    async update(update: Record<string, unknown>) {
      await db.batch(await projectNativeUpdate(db, run, update, ++sequence));
    },
    async reopen() {
      await db.close();
      db = await createDatabase(join(root, "test.sqlite"));
    },
  };
}
test("activity keeps chronological text/tool boundaries and reopens complete paged details", async (t) => {
  const f = await fixture(t);
  const chunk = (text: string) => ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
  await f.update(chunk("I will inspect the file."));
  await f.update({ sessionUpdate: "woven_assistant_boundary" });
  await f.update({
    sessionUpdate: "tool_call",
    toolCallId: "read-1",
    title: "Read file",
    status: "in_progress",
    rawInput: { path: "report.txt" },
  });
  const output = "🌿".repeat(40_000) + "\nEND";
  await f.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "read-1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: output } }],
  });
  await f.update(chunk("Here is the answer."));
  await f.db.batch(settleActivity(f.run, "completed"));
  await f.reopen();
  const page = await readActivities(f.db, "c");
  assert.deepEqual(
    page.items.map((x) => x.kind),
    ["message", "tool", "final"],
  );
  assert.equal(page.items[1].status, "completed");
  assert.ok(
    JSON.stringify(page).length < 5000,
    "compact reads must exclude complete output",
  );
  let full = "",
    offset = 0;
  for (;;) {
    const detail = await readActivityDetail(
      f.db,
      "c",
      "r",
      "tool:read-1",
      offset,
      page.items[1].revision,
    );
    assert.ok(detail && !detail.stale);
    full += detail.text;
    if (!detail.hasMore) break;
    assert.ok(detail.nextOffset > offset);
    offset = detail.nextOffset;
  }
  assert.ok(full.includes(output));
  assert.equal(
    await readActivityDetail(
      f.db,
      "another-conversation",
      "r",
      "tool:read-1",
      0,
    ),
    undefined,
  );
  assert.deepEqual((await readActivities(f.db, "c", page.cursor)).items, []);
});
test("incremental cursor pages a shared settlement revision without dropping rows", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 205; i++)
    await f.update({
      sessionUpdate: "tool_call",
      toolCallId: "call-" + i,
      title: "Command",
      status: "in_progress",
    });
  const first = await readActivities(f.db, "c");
  assert.equal(first.items.length, 200);
  assert.equal(first.hasMore, true);
  const older = await readActivities(f.db, "c", undefined, first.nextBefore!);
  assert.equal(older.items.length, 5);
  await f.db.batch(settleActivity(f.run, "cancelled"));
  const changed = await readActivities(f.db, "c", first.cursor);
  assert.equal(changed.items.length, 200);
  assert.equal(changed.hasMore, true);
  const remaining = await readActivities(f.db, "c", changed.cursor);
  assert.equal(remaining.items.length, 5);
  assert.equal(
    new Set([...changed.items, ...remaining.items].map((x) => x.key)).size,
    205,
  );
  assert.ok(
    [...changed.items, ...remaining.items].every(
      (x) => x.status === "cancelled",
    ),
  );
});
test("only native checklists drive progress and replacement, merge and clear are retained", async (t) => {
  const f = await fixture(t);
  await f.update({
    sessionUpdate: "plan",
    entries: [{ content: "A proposed plan", status: "pending" }],
  });
  assert.deepEqual(
    (await readActivities(f.db, "c")).items.map((item) => item.kind),
    ["plan"],
  );
  // Proposal content does not become execution progress.
  await f.db.batch([
    { sql: "DELETE FROM conversation_activity WHERE kind='plan'" },
  ]);
  const plan = (entries: unknown[], operation = "replace") => ({
    sessionUpdate: "plan",
    entries,
    _meta: { wovenPlanKind: "checklist", wovenPlanOperation: operation },
  });
  await f.update(plan([{ id: "one", content: "Read", status: "in_progress" }]));
  await f.update(
    plan([{ id: "two", content: "Verify", status: "pending" }], "merge"),
  );
  let page = await readActivities(f.db, "c");
  assert.equal((page.items[0].metadata.items as unknown[]).length, 2);
  await f.update(plan([{ id: "two", content: "Verify", status: "completed" }]));
  page = await readActivities(f.db, "c");
  assert.equal((page.items[0].metadata.items as unknown[]).length, 1);
  await f.update(plan([], "clear"));
  page = await readActivities(f.db, "c");
  assert.deepEqual(page.items[0].metadata.items, []);
  await f.update({
    sessionUpdate: "woven_subagents",
    subagents: [
      { id: 3, name: "Research", state: "working", modelId: "model" },
    ],
  });
  assert.ok(
    (await readActivities(f.db, "c")).items.some((x) => x.key === "child:3"),
  );
});
test("canonical native revisions remain immutable and cursor transaction rollback is atomic", async (t) => {
  const f = await fixture(t);
  const batch = {
    sourceID: "native",
    nativeSessionID: "s",
    records: [
      {
        id: "record",
        revision: "1",
        kind: "pi.assistant",
        text: "needle",
        payload: '{"complete":"original"}',
      },
    ],
  };
  await f.db.batch(captureNativeBatch(f.run, batch));
  await f.db.batch(captureNativeBatch(f.run, batch));
  await f.db.batch(
    captureNativeBatch(f.run, {
      ...batch,
      records: [
        {
          ...batch.records[0],
          revision: "2",
          payload: '{"complete":"correction"}',
        },
      ],
    }),
  );
  const page = await nativeArchivePage(f.db, "c", 0, "needle");
  assert.equal(page.items.length, 2);
  assert.equal(
    JSON.parse(page.items[0].payload).payload,
    '{"complete":"original"}',
  );
  const statements = await projectNativeUpdate(
    f.db,
    f.run,
    { sessionUpdate: "tool_call", toolCallId: "rolled-back", title: "Command" },
    99,
  );
  await assert.rejects(
    f.db.batch([
      {
        sql: "UPDATE conversation_runs SET runtime_cursor=99 WHERE id='r' AND runtime_cursor=98",
        expectChanges: 1,
      },
      ...statements,
    ]),
  );
  assert.equal((await readActivities(f.db, "c")).items.length, 0);
  assert.equal((await nativeArchivePage(f.db, "c", 0)).items.length, 2);
});

test("tool output replacements and Unicode paging preserve display text independently of captures", async (t) => {
  const f = await fixture(t);
  await f.update({
    sessionUpdate: "tool_call",
    toolCallId: "tool",
    title: "Command",
    rawInput: { command: "pwd" },
  });
  await f.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool",
    rawOutput: { output: { set: "first" } },
  });
  await f.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool",
    rawOutput: { output: { trimStart: 2, append: " second" } },
  });
  const detail = await readActivityDetail(f.db, "c", "r", "tool:tool", 0);
  assert.ok(detail && !detail.stale);
  assert.match(detail.text!, /rst second$/);
  await f.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool",
    rawOutput: { output: { set: "" } },
  });
  const empty = await readActivityDetail(f.db, "c", "r", "tool:tool", 0);
  assert.ok(empty && !empty.stale);
  assert.ok(!empty.text!.includes("second"));
  assert.equal((await nativeArchivePage(f.db, "c", 0)).items.length, 4);
  await f.update({
    sessionUpdate: "agent_message_chunk",
    content: { text: "discard" },
  });
  await f.update({
    sessionUpdate: "agent_message_chunk",
    content: { text: "" },
    _meta: { wovenAssistantSnapshot: true },
  });
  const cleared = await readActivityDetail(f.db, "c", "r", "message:0", 0);
  assert.ok(cleared && !cleared.stale);
  assert.equal(cleared.text, "");
});

test("large framed replacements commit atomically without partial visible text", async (t) => {
  const f = await fixture(t);
  await f.update({
    sessionUpdate: "agent_message_chunk",
    content: { text: "previous response" },
  });
  const before = await readActivities(f.db, "c");
  const chunk = "🌿 ".repeat(12000),
    count = 40;
  for (let index = 0; index < count; index++) {
    await f.update({
      sessionUpdate: "agent_message_chunk",
      content: { text: chunk },
      _meta: {
        wovenAssistantSnapshot: true,
        wovenSnapshotStart: index === 0,
        wovenSnapshotEnd: index === count - 1,
      },
    });
    if (index < count - 1)
      assert.equal(
        (await readActivities(f.db, "c")).items[0].revision,
        before.items[0].revision,
      );
  }
  let recovered = "",
    offset = 0;
  for (;;) {
    const page = await readActivityDetail(f.db, "c", "r", "message:0", offset);
    assert.ok(page && !page.stale);
    recovered += page.text;
    if (!page.hasMore) break;
    offset = page.nextOffset!;
  }
  assert.equal(recovered, chunk.repeat(count));
  assert.equal((await readActivities(f.db, "c")).items.length, 1);
  await assert.rejects(
    f.update({
      sessionUpdate: "agent_message_chunk",
      content: { text: "orphan" },
      _meta: {
        wovenAssistantSnapshot: true,
        wovenSnapshotStart: false,
        wovenSnapshotEnd: true,
      },
    }),
    /matching start/,
  );
});

test("interrupted commentary stays in work while native checklist mutations do not displace a final reply", async (t) => {
  const f = await fixture(t);
  await f.update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "I will run the command." },
  });
  await f.update({
    sessionUpdate: "tool_call",
    toolCallId: "bad",
    title: "Command",
    status: "in_progress",
  });
  await f.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "bad",
    status: "failed",
    content: [{ text: "Command failed" }],
  });
  await f.db.batch(settleActivity(f.run, "failed"));
  let page = await readActivities(f.db, "c");
  assert.deepEqual(
    page.items.map((item) => item.kind),
    ["message", "tool"],
  );
  assert.equal(page.items[1].status, "failed");
  await f.update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "The command failed." },
  });
  await f.update({
    sessionUpdate: "plan",
    entries: [],
    _meta: { wovenPlanKind: "checklist", wovenPlanOperation: "clear" },
  });
  await f.db.batch(settleActivity(f.run, "completed"));
  page = await readActivities(f.db, "c");
  assert.equal(
    page.items.find((item) => item.preview === "The command failed.")?.kind,
    "final",
  );
});
