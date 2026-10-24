import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { purgeExpiredProject } from "../apps/api/src/projects/trash.js";
import { platformFixture } from "./fixtures/platform.js";
import { nextOccurrence, WorkspaceScheduler } from "../apps/api/src/workspace-content/scheduler.js";
import { sharedLinks } from "../apps/api/src/workspace-content/library.js";

test("workspace notes share edits and versions with conflict detection and boundary revalidation", async t => {
  const f = await platformFixture(t), base = `/enterprise/api/projects/${f.projectA}/workspace-content`;
  const created = await f.request("full", "POST", base, { kind: "note", title: "Design", body: "First" });
  assert.equal(created.statusCode, 201);
  const note = created.json();
  assert.equal((await f.request("read", "GET", base)).json().items[0].id, note.id);
  const responses = await Promise.all(["full", "read"].map(actor => f.request(actor, "PATCH", `${base}/${note.id}`, { expectedRevision: 1, body: actor })));
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 409]);
  const versions = (await f.request("read", "GET", `${base}/${note.id}/versions`)).json().items;
  assert.deepEqual(versions.map((v: any) => v.revision), [2, 1]);
  const restored = await f.request("read", "POST", `${base}/${note.id}/restore`, { expectedRevision: 2, revision: 1 });
  assert.equal(restored.statusCode, 200); assert.equal(restored.json().body, "First");
  assert.equal((await f.request("other", "GET", `${base}/${note.id}`)).statusCode, 404);
  assert.equal((await f.request("other", "GET", `${base}/${note.id}/versions`)).statusCode, 404);
  await f.db.run("DELETE FROM project_members WHERE project_id=? AND user_id=?", [f.projectA, f.users.read!.id]);
  assert.equal((await f.request("read", "GET", `${base}/${note.id}`)).statusCode, 404);
  assert.equal((await f.request("full", "DELETE", `${base}/${note.id}?revision=3`)).statusCode, 200);
  assert.equal((await f.request("full", "GET", `${base}/${note.id}`)).statusCode, 404);
});

test("workspace content validates folder scope, active URLs and calendar semantics", async t => {
  const f = await platformFixture(t), base = `/enterprise/api/projects/${f.projectA}/workspace-content`;
  const folder = await f.request("other", "POST", `/enterprise/api/projects/${f.projectB}/folders`, { name: "Other" });
  assert.equal(folder.statusCode, 201);
  assert.equal((await f.request("full", "POST", base, { kind: "note", title: "No", folderId: folder.json().id })).statusCode, 409);
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.test"]) {
    assert.equal((await f.request("full", "POST", base, { kind: "library", title: "No", data: { type: "link", url } })).statusCode, 400);
  }
  assert.equal((await f.request("full", "POST", base, { kind: "event", title: "No", data: { startsAt: "2026-10-23T12:00:00Z", endsAt: "2026-10-22T12:00:00Z" } })).statusCode, 400);
  const event = await f.request("full", "POST", base, { kind: "event", title: "Planning", data: { startsAt: "2026-10-23T12:00:00Z", timeZone: "America/New_York", recurrence: { unit: "week", interval: 1 } } });
  assert.equal(event.statusCode, 201);
  assert.equal(event.json().data.timeZone, "America/New_York");
});

test("workspace content writes lose authority when membership is revoked after the initial read", async t => {
  for (const operation of ["create", "update", "delete"] as const) await t.test(operation, async sub => {
    const f = await platformFixture(sub), service = f.workspaceContent.service;
    const user = f.users.read!;
    const note = await service.create(f.users.full!, f.projectA, { kind: "note", title: "Retained", body: "Original" });
    const batch = f.db.batch.bind(f.db), run = f.db.run.bind(f.db);
    let revoked = false;
    const revoke = async () => {
      if (revoked) return;
      revoked = true;
      await run("DELETE FROM project_members WHERE project_id=? AND user_id=?", [f.projectA, user.id]);
    };
    f.db.batch = async statements => {
      if (statements.some(s => /^(INSERT INTO|UPDATE) workspace_content\b/.test(s.sql))) await revoke();
      return batch(statements);
    };
    f.db.run = async (sql, params) => {
      if (sql.startsWith("UPDATE workspace_content SET deleted_at=")) await revoke();
      return run(sql, params);
    };
    const attempt = operation === "create" ? service.create(user, f.projectA, { kind: "note", title: "Denied" })
      : operation === "update" ? service.update(user, f.projectA, note.id, { expectedRevision: 1, body: "Denied" })
      : service.remove(user, f.projectA, note.id, 1);
    await assert.rejects(attempt, (error: any) => error.statusCode === 404 || error.status === 404);
    assert.equal(revoked, true);
    const rows = await f.db.all<any>("SELECT title,body,revision,deleted_at FROM workspace_content WHERE project_id=?", [f.projectA]);
    assert.deepEqual(rows, [{ title: "Retained", body: "Original", revision: 1, deleted_at: null }]);
    assert.equal((await service.versions(f.users.full!, f.projectA, note.id)).items.length, 1);
  });
});

test("calendar recurrence preserves month anchor, DST wall time and skips missed intervals", () => {
  assert.equal(nextOccurrence("2026-01-31T12:00:00Z", { unit: "month", interval: 1 }, "UTC", new Date("2026-02-28T12:00:00Z")), "2026-03-31T12:00:00.000Z");
  assert.equal(nextOccurrence("2026-03-07T14:00:00Z", { unit: "day", interval: 1 }, "America/New_York", new Date("2026-03-07T14:00:00Z")), "2026-03-08T13:00:00.000Z");
  assert.equal(nextOccurrence("2026-03-07T07:30:00Z", { unit: "day", interval: 1 }, "America/New_York", new Date("2026-03-08T06:00:00Z")), "2026-03-08T07:30:00.000Z");
  assert.equal(nextOccurrence("2020-01-01T12:00:00Z", { unit: "day", interval: 1 }, "UTC", new Date("2026-10-22T13:00:00Z")), "2026-10-23T12:00:00.000Z");
  assert.equal(nextOccurrence("2026-01-01T12:00:00Z", null, "UTC", new Date()), null);
});

test("scheduled tasks admit once through native conversation receipts and do not replay uncertain claims", async t => {
  const f = await platformFixture(t), service = f.workspaceContent.service;
  const due = "2026-10-22T12:00:00.000Z";
  const task = await service.create(f.users.full!, f.projectA, { kind: "task", title: "Update", data: { startsAt: due, prompt: "Update shared summary", harness: "pi", recurrence: { unit: "day", interval: 1 } } });
  let sends = 0;
  const scheduler = new WorkspaceScheduler(f.ctx, {
    user: id => f.conversations.user(id), create: (...args) => f.conversations.create(...args),
    admit: (async () => { sends++; throw new Error("Simulated uncertain provider admission"); }) as any,
  });
  await Promise.all([scheduler.tick(new Date(due)), scheduler.tick(new Date(due))]);
  await scheduler.tick(new Date(due));
  assert.equal(sends, 1);
  assert.equal((await f.db.get<any>("SELECT COUNT(*) n FROM workspace_task_runs WHERE content_id=?", [task.id]))!.n, 1);
  const next = (await f.db.get<any>("SELECT next_at FROM workspace_task_state WHERE content_id=?", [task.id]))!.next_at;
  assert.equal(next, "2026-10-23T12:00:00.000Z");
  await f.db.run("INSERT INTO workspace_task_runs(id,content_id,occurrence,status,created_at) VALUES(?,?,?,'admitting',?)", [randomUUID(), task.id, "2026-10-21T12:00:00.000Z", due]);
  await scheduler.tick(new Date(due));
  assert.equal(sends, 1);
  assert.equal((await f.db.get<any>("SELECT COUNT(*) n FROM workspace_task_runs WHERE status='uncertain'"))!.n, 2);
  await f.db.run("DELETE FROM project_members WHERE project_id=? AND user_id=?", [f.projectA, f.users.full!.id]);
  await scheduler.tick(new Date(next));
  assert.equal(sends, 1, "removed creator may not dispatch unattended work");
});

test("scheduled task status reflects native delivery instead of treating every receipt as acceptance", async t => {
  const f = await platformFixture(t), due = "2026-10-22T12:00:00.000Z";
  for (const delivery of ["rejected", "uncertain", "pending"] as const) {
    const task = await f.workspaceContent.service.create(f.users.full!, f.projectA, { kind: "task", title: delivery, data: { startsAt: due, prompt: "Synthetic scheduled input", harness: "pi" } });
    let sends = 0;
    const scheduler = new WorkspaceScheduler(f.ctx, {
      user: id => f.conversations.user(id), create: (...args) => f.conversations.create(...args),
      admit: (async () => { sends++; return { message: { delivery }, run: null }; }) as any,
    });
    await scheduler.tick(new Date(due));
    assert.equal((await f.db.get<any>("SELECT status FROM workspace_task_runs WHERE content_id=?", [task.id]))!.status, delivery === "pending" ? "submitted" : delivery);
    await scheduler.tick(new Date(due));
    assert.equal(sends, 1, "a non-accepted receipt must not replay the occurrence");
  }
});

test("desktop library is distinct from organization files and discovers only explicit shared links", async t => {
  assert.deepEqual(sharedLinks("[Public](https://example.test/doc) ```[secret](https://secret.test)``` /etc/passwd <https://other.test>"), [{ url: "https://example.test/doc", title: "Public" }, { url: "https://other.test/", title: "other.test" }]);
  const f = await platformFixture(t), base = `/enterprise/api/projects/${f.projectA}`;
  const chat = await f.conversations.create(f.users.full!, f.projectA, { title: "Shared" });
  await f.db.run("INSERT INTO conversation_messages(id,conversation_id,role,author_id,content,created_at) VALUES(?,?,'user',?,?,?)", [randomUUID(), chat.id, f.users.full!.id, "[Source](https://example.test)", new Date().toISOString()]);
  await f.request("full", "POST", `${base}/workspace-content`, { kind: "library", title: "Saved", data: { type: "link", url: "https://saved.test" } });
  const library = await f.request("read", "GET", `${base}/workspace-library`);
  assert.equal(library.statusCode, 200); assert.equal(library.json().items.length, 2);
  assert.equal((await f.request("other", "GET", `${base}/workspace-library`)).statusCode, 404);
  assert.deepEqual((await f.request("read", "GET", `${base}/usage`)).json().totals, { runs: 0, completed: 0, failed: 0 });
});

test("managed workspace databases execute real SQL, deny host capabilities, retain snapshots and enforce workspace access", async t => {
  const f = await platformFixture(t), endpoint = `/enterprise/api/projects/${f.projectA}/databases`;
  const created = await f.request("full", "POST", endpoint, { action: "create", name: "Research" });
  assert.equal(created.statusCode, 200, created.body);
  const databaseID = created.json().id;
  assert.equal(created.json().url, undefined);
  assert.equal((await f.request("read", "POST", endpoint, { action: "execute", databaseID, sql: "CREATE TABLE findings(title TEXT); INSERT INTO findings VALUES ('Verified');" })).statusCode, 200);
  const query = await f.request("full", "POST", endpoint, { action: "query", databaseID, sql: "SELECT title FROM findings" });
  assert.deepEqual(query.json().query, { contractVersion: 1, columns: ["title"], rows: [["Verified"]] });
  for (const sql of ["ATTACH DATABASE '/etc/passwd' AS host", "SELECT load_extension('/tmp/no')", "PRAGMA writable_schema=ON", "VACUUM INTO '/tmp/wme-escape.sqlite'"]) {
    const bad = await f.request("full", "POST", endpoint, { action: "execute", databaseID, sql });
    assert.equal(bad.statusCode, 400, sql);
    assert.ok(!bad.body.includes("/etc/passwd"));
  }
  const snapshot = (await f.request("full", "POST", endpoint, { action: "snapshot", databaseID })).json();
  const copy = await f.request("read", "POST", endpoint, { action: "copy", name: "Copy", snapshot });
  assert.equal(copy.statusCode, 200);
  assert.equal((await f.request("other", "POST", endpoint, { action: "list" })).statusCode, 404);
  assert.equal((await f.request("full", "POST", endpoint, { action: "query", databaseID: "../../control/platform", sql: "SELECT 1" })).statusCode, 400);
});

test("native workspace tools bind the current run, share results and deny revoked or cross-workspace capabilities", async t => {
  const f = await platformFixture(t);
  await f.conversations.close(); // Static deterministic accepted-run fixture.
  const chat = await f.conversations.create(f.users.full!, f.projectA, { title: "Tool fixture" });
  const run = randomUUID(), message = randomUUID(), assistant = randomUUID(), token = "wme_run_" + randomUUID(), at = new Date().toISOString();
  for (const [id, role] of [[message, "user"], [assistant, "assistant"]])
    await f.db.run("INSERT INTO conversation_messages(id,conversation_id,role,author_id,content,created_at) VALUES(?,?,?,?,?,?)", [id!, chat.id, role!, f.users.full!.id, "Synthetic workspace tool", at]);
  await f.db.run("INSERT INTO conversation_runs(id,conversation_id,org_id,project_id,user_id,request_id,user_message_id,assistant_message_id,status,mode,harness,model,created_at) VALUES(?,?,?,?,?,?,?,?,'running','write','pi','fixture',?)", [run, chat.id, f.orgA, f.projectA, f.users.full!.id, randomUUID(), message, assistant, at]);
  await f.db.run("INSERT INTO inference_gateway_tokens(token_hash,org_id,project_id,user_id,run_id,conversation_id,model,harness,expires_at,revoked) VALUES(?,?,?,?,?,?,'fixture','pi',?,0)", [createHash("sha256").update(token).digest("hex"), f.orgA, f.projectA, f.users.full!.id, run, chat.id, new Date(Date.now() + 60000).toISOString()]);
  const request = (project: string, operation: string, payload = {}, credential = token) => f.app.inject({ method: "POST", url: `/enterprise/api/runtime/inference/${project}/workspace/${operation}`, headers: { host: "portal.test", authorization: `Bearer ${credential}` }, payload });
  const created = await request(f.projectA, "create", { kind: "note", title: "Agent handback", body: "Shared" });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal((await f.request("read", "GET", `/enterprise/api/projects/${f.projectA}/workspace-content/${created.json().id}`)).json().body, "Shared");
  assert.equal((await request(f.projectB, "list")).statusCode, 403);
  assert.equal((await request(f.projectA, "list", {}, "invalid")).statusCode, 401);
  await f.db.run("DELETE FROM project_members WHERE project_id=? AND user_id=?", [f.projectA, f.users.full!.id]);
  assert.equal((await request(f.projectA, "list")).statusCode, 403);
  assert.equal((await f.request("read", "GET", `/enterprise/api/projects/${f.projectA}/workspace-content/${created.json().id}`)).statusCode, 200);
});

test("workspace purge removes datasets, note versions and tasks while preserving other workspace content", async t => {
  const f = await platformFixture(t);
  const first = await f.workspaceContent.service.create(f.users.full!, f.projectA, { kind: "note", title: "Private" });
  const second = await f.workspaceContent.service.create(f.users.other!, f.projectB, { kind: "note", title: "Retained" });
  await f.request("full", "POST", `/enterprise/api/projects/${f.projectA}/databases`, { action: "create", name: "Dataset" });
  await f.db.run("UPDATE projects SET status='deleted',purge_after=? WHERE id=?", ["2020-01-01T00:00:00Z", f.projectA]);
  assert.equal(await purgeExpiredProject(f.ctx, f.projectA), true);
  assert.equal(await f.db.get("SELECT id FROM workspace_content WHERE id=?", [first.id]), undefined);
  assert.equal(await f.db.get("SELECT content_id FROM workspace_content_versions WHERE content_id=?", [first.id]), undefined);
  await assert.rejects(access(join(f.stateDir, "workspace-datasets", f.projectA)));
  assert.ok(await f.db.get("SELECT id FROM workspace_content WHERE id=?", [second.id]));
});
