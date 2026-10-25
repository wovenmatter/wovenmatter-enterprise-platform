import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { platformFixture } from "./fixtures/platform.js";
import { normalizeConversationTools, withConversationTools } from "../apps/api/src/conversations/conversation-tools.js";
import type { Harness } from "../apps/api/src/conversations/types.js";

async function fixture(t: any, harness: Harness = "pi") {
  const f = await platformFixture(t, { startConversations: false });
  const chat = await f.conversations.create(f.users.full!, f.projectA, { title: "Tool policy fixture", harness });
  const run = randomUUID(), message = randomUUID(), assistant = randomUUID(), token = "wme_run_" + randomUUID(), at = new Date().toISOString();
  for (const [id, role] of [[message, "user"], [assistant, "assistant"]])
    await f.db.run("INSERT INTO conversation_messages(id,conversation_id,role,author_id,content,created_at) VALUES(?,?,?,?,?,?)", [id!, chat.id, role!, f.users.full!.id, "Synthetic tool input", at]);
  await f.db.run("INSERT INTO conversation_runs(id,conversation_id,org_id,project_id,user_id,request_id,user_message_id,assistant_message_id,status,mode,harness,model,created_at) VALUES(?,?,?,?,?,?,?,?,'running','write',?,'fixture',?)", [run, chat.id, f.orgA, f.projectA, f.users.full!.id, randomUUID(), message, assistant, harness, at]);
  await f.db.run("INSERT INTO inference_gateway_tokens(token_hash,org_id,project_id,user_id,run_id,conversation_id,model,harness,expires_at,revoked) VALUES(?,?,?,?,?,?,'fixture',?,?,0)", [createHash("sha256").update(token).digest("hex"), f.orgA, f.projectA, f.users.full!.id, run, chat.id, harness, new Date(Date.now() + 60000).toISOString()]);
  const endpoint = `/enterprise/api/conversations/${chat.id}/tools`;
  const tool = (operation: string, payload = {}, project = f.projectA) => f.app.inject({ method: "POST", url: `/enterprise/api/runtime/inference/${project}/workspace/${operation}`, headers: { host: "portal.test", authorization: `Bearer ${token}` }, payload });
  const set = (group: string, enabled: boolean, actor = "read") => f.request(actor, "PATCH", endpoint, { group, enabled });
  return { ...f, chat, message, run, token, endpoint, tool, set };
}

test("tool settings validate supported groups and retain enabled defaults for existing chats", async t => {
  assert.deepEqual(normalizeConversationTools(), { notes: true, history: true, usage: true, calendar: true, library: true });
  for (const bad of [null, [], { notes: "false" }, { executor: true }, { sessions: true }, { databases: true }]) assert.throws(() => normalizeConversationTools(bad));
  const f = await fixture(t);
  const initial = await f.request("full", "GET", f.endpoint);
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json().groups.map((group: any) => group.id), ["notes", "history", "usage", "calendar", "library"]);
  assert.equal(initial.json().groups.find((group: any) => group.id === "notes").description.includes("databases"), true);
  const created = await f.request("full", "POST", `/enterprise/api/projects/${f.projectA}/conversations`, { tools: { notes: false, history: false } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().tools.notes, false);
  assert.equal(created.json().tools.history, false);
  assert.equal(created.json().tools.library, true);
  for (const tools of [{ notes: 0 }, { computer: true }]) assert.equal((await f.request("full", "POST", `/enterprise/api/projects/${f.projectA}/conversations`, { tools })).statusCode, 400);
  for (const payload of [{ group: "notes", enabled: "false" }, { group: "sessions", enabled: false }, { group: "notes", enabled: false, arbitrary: true }])
    assert.equal((await f.request("full", "PATCH", f.endpoint, payload)).statusCode, 400);
});

for (const harness of ["pi", "codex", "claude_code", "grok_build", "opencode"] as const) {
  test(`${harness} uses the same live broker policy without changing native authority or files`, async t => {
    const f = await fixture(t, harness);
    const note = await f.workspaceContent.service.create(f.users.full!, f.projectA, { kind: "note", title: "Shared note", body: "Retained" });
    assert.equal((await f.tool("read", { id: note.id })).statusCode, 200);
    assert.equal((await f.set("notes", false)).statusCode, 200, "A current collaborator can change shared chat settings");
    const denied = await f.tool("read", { id: note.id, kind: "event" });
    assert.equal(denied.statusCode, 403, "The stored kind controls policy, not caller-supplied kind");
    assert.equal(denied.json().error.code, "tool_disabled");
    assert.equal((await f.tool("databases", { action: "list" })).statusCode, 403);
    assert.equal((await f.tool("create", { kind: "note", title: "Denied" })).statusCode, 403);
    assert.equal((await f.tool("list", { kind: "note" })).statusCode, 403);
    assert.deepEqual((await f.tool("list")).json().items, []);
    assert.equal((await f.request("read", "GET", `/enterprise/api/projects/${f.projectA}/workspace-content/${note.id}`)).statusCode, 200, "Tools switches do not remove member access");
    assert.equal((await f.set("notes", true)).statusCode, 200);
    assert.equal((await f.tool("read", { id: note.id })).statusCode, 200);
    assert.equal((await f.db.get<any>("SELECT harness,mode,runtime_generation FROM conversations WHERE id=?", [f.chat.id]))!.harness, harness);
  });
}

test("every content operation and supported group is checked through the trusted broker", async t => {
  const f = await fixture(t);
  const note = await f.workspaceContent.service.create(f.users.full!, f.projectA, { kind: "note", title: "Note" });
  const artifact = await f.workspaceContent.service.create(f.users.full!, f.projectA, { kind: "artifact", title: "Artifact" });
  const event = await f.workspaceContent.service.create(f.users.full!, f.projectA, { kind: "event", title: "Event", data: { startsAt: "2026-10-23T12:00:00Z" } });
  const task = await f.workspaceContent.service.create(f.users.full!, f.projectA, { kind: "task", title: "Task", data: { startsAt: "2026-10-23T12:00:00Z", prompt: "Fixture task" } });
  const library = await f.workspaceContent.service.create(f.users.full!, f.projectA, { kind: "library", title: "Library", data: { type: "link", url: "https://example.test" } });
  for (const group of ["notes", "calendar", "library", "usage"]) await f.set(group, false);
  for (const record of [note, artifact, event, task, library]) {
    for (const operation of ["read", "update", "delete", "versions", "restore"])
      assert.equal((await f.tool(operation, { id: record.id, expectedRevision: 1, revision: 1, title: "Changed" })).statusCode, 403, `${record.kind}/${operation}`);
    assert.equal((await f.tool("create", { kind: record.kind, title: "New" })).statusCode, 403);
  }
  for (const operation of ["library", "usage", "databases"]) assert.equal((await f.tool(operation)).statusCode, 403, operation);
  await f.set("calendar", true);
  assert.deepEqual((await f.tool("list")).json().items.map((item: any) => item.kind).sort(), ["event", "task"]);
  assert.equal((await f.tool("read", { id: event.id })).statusCode, 200);
  assert.equal((await f.tool("create", { kind: "unsupported" })).statusCode, 400);
  assert.equal((await f.tool("enable", { group: "notes", enabled: true })).statusCode, 400);
});

test("history is bounded, read-only and explicit admitted attachments grant only their exact targets", async t => {
  const f = await fixture(t);
  const target = await f.conversations.create(f.users.read!, f.projectA, { title: "Attached history" });
  const other = await f.conversations.create(f.users.read!, f.projectA, { title: "Other history" });
  const foreign = await f.conversations.create(f.users.other!, f.projectB, { title: "Foreign history" });
  for (const content of ["First", "Second", "🙂".repeat(15999) + "\0Tail"]) await f.db.run("INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user',?,?)", [randomUUID(), target.id, content, new Date().toISOString()]);
  const note = await f.workspaceContent.service.create(f.users.full!, f.projectA, { kind: "note", title: "Attached note", body: "Live authorized note" });
  const unrelated = await f.workspaceContent.service.create(f.users.full!, f.projectA, { kind: "note", title: "Other note" });
  await f.set("history", false); await f.set("notes", false);
  assert.equal((await f.tool("list", { kind: "conversation" })).statusCode, 403);
  assert.equal((await f.tool("read", { kind: "conversation", id: target.id })).statusCode, 403);
  // Text and unadmitted draft records are not authority.
  await f.db.run("UPDATE conversation_messages SET attachments=? WHERE id=?", [JSON.stringify([{ kind: "conversation", id: target.id, title: target.title }, { kind: "note", id: note.id, title: note.title }]), f.message]);
  assert.equal((await f.tool("read", { kind: "conversation", id: target.id })).statusCode, 403);
  await f.db.run("INSERT INTO conversation_inputs(conversation_id,request_id,message_id,run_id,delivery) VALUES(?,?,?,?,'pending')", [f.chat.id, randomUUID(), f.message, f.run]);
  const first = await f.tool("read", { kind: "conversation", id: target.id, limit: 1 });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().items[0].content, "First");
  const second = await f.tool("read", { kind: "conversation", id: target.id, after: first.json().nextAfter, limit: 2 });
  assert.deepEqual(second.json().items.map((item: any) => item.contentTruncated), [false, true]);
  assert.equal(second.json().nextAfter, null);
  const long = second.json().items[1];
  assert.equal(long.nextOffset, 16000);
  assert.equal(long.content.endsWith("\0"), true, "Embedded NUL is retained rather than terminating a text window");
  assert.equal(long.totalCharacters, 16004);
  const tail = await f.tool("read", { kind: "conversation", id: target.id, messageId: long.id, offset: long.nextOffset, characters: 2 });
  assert.equal(tail.json().message.content, "Ta");
  assert.equal(tail.json().message.nextOffset, 16002);
  const end = await f.tool("read", { kind: "conversation", id: target.id, messageId: long.id, offset: tail.json().message.nextOffset });
  assert.equal(end.json().message.content, "il");
  assert.equal(end.json().message.nextOffset, null);
  assert.equal((await f.tool("read", { kind: "conversation", id: target.id, messageId: f.message })).statusCode, 404, "A caller-supplied conversation cannot grant a foreign message");
  assert.equal((await f.tool("read", { kind: "conversation", id: target.id, messageId: long.id, offset: -1 })).statusCode, 400);
  assert.equal((await f.tool("read", { kind: "conversation", id: f.chat.id })).statusCode, 200, "Own public transcript remains readable");
  assert.equal((await f.tool("read", { kind: "conversation", id: other.id })).statusCode, 403);
  assert.equal((await f.tool("read", { id: note.id })).json().body, "Live authorized note");
  assert.equal((await f.tool("read", { id: unrelated.id })).statusCode, 403);
  assert.equal((await f.tool("update", { id: note.id, expectedRevision: 1, body: "No" })).statusCode, 403);
  assert.equal((await f.tool("versions", { id: note.id })).statusCode, 403);
  assert.equal((await f.tool("update", { kind: "conversation", id: target.id, title: "No" })).statusCode, 404);
  await f.set("history", true);
  assert.equal((await f.tool("read", { kind: "conversation", id: foreign.id })).statusCode, 404);
  assert.equal((await f.tool("read", { kind: "conversation", id: target.id, limit: 101 })).statusCode, 400);
  await f.conversations.remove(f.users.full!, target.id);
  assert.equal((await f.tool("read", { kind: "conversation", id: target.id })).statusCode, 404);
});

test("tool settings and broker requests preserve membership and token boundaries", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("other", "GET", f.endpoint)).statusCode, 404);
  assert.equal((await f.request("other", "PATCH", f.endpoint, { group: "notes", enabled: false })).statusCode, 404);
  assert.equal((await f.app.inject({ method: "PATCH", url: f.endpoint, headers: { host: "portal.test", authorization: `Bearer ${f.token}` }, payload: { group: "notes", enabled: true } })).statusCode, 403, "A run token cannot satisfy user-route CSRF and session authentication");
  assert.equal((await f.tool("list", {}, f.projectB)).statusCode, 403);
  await f.db.run("DELETE FROM project_members WHERE project_id=? AND user_id=?", [f.projectA, f.users.full!.id]);
  assert.equal((await f.tool("list")).statusCode, 403);
  assert.equal((await f.request("full", "GET", f.endpoint)).statusCode, 404);
  assert.equal((await f.set("notes", false)).statusCode, 200, "Another current member retains authority");
});

test("a completed disable fences later operations without abandoning an admitted API operation", async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  t.after(release);
  const operation = withConversationTools(f.ctx, f.chat.id, async () => { entered(); await blocked; });
  await started;
  let saved = false;
  const change = f.set("notes", false).then(result => { saved = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved, false);
  release(); await operation;
  assert.equal((await change).statusCode, 200);
  assert.equal((await f.tool("create", { kind: "note", title: "After disable" })).statusCode, 403);
});
