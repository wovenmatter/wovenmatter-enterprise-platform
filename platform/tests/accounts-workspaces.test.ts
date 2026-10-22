import test from "node:test";
import assert from "node:assert/strict";
import { platformFixture } from "./fixtures/platform.js";
import { createDatabase, migrateFoundation } from "../apps/api/src/db/index.js";
import { migrateNativeHarnesses } from "../apps/api/src/conversations/native-schema.js";
import { uploadFile, shareFile, revokeShare, readCurrentFile } from "../apps/api/src/files/service.js";

test("owner alone manages platform identities and pending accounts can join multiple organizations safely", async (t) => {
  const f = await platformFixture(t);
  for (const actor of ["admin", "full", "read", "other"]) {
    for (const path of ["/enterprise/api/accounts", "/enterprise/api/platform/settings"])
      assert.equal((await f.request(actor, "GET", path)).statusCode, 403);
    assert.equal((await f.request(actor, "POST", "/enterprise/api/accounts", { email: "denied@example.test" })).statusCode, 403);
  }
  for (const actor of ["full", "read"])
    assert.equal((await f.request(actor, "GET", `/enterprise/api/organizations/${f.orgA}/members`)).statusCode, 403);
  assert.equal((await f.request("admin", "GET", `/enterprise/api/organizations/${f.orgA}/members`)).statusCode, 200);
  const created = await f.request("owner", "POST", "/enterprise/api/accounts", { email: "New@Example.test", name: "New account" });
  assert.equal(created.statusCode, 202, created.body);
  const pending = created.json();
  assert.equal(pending.user.orgId, null);
  assert.deepEqual(pending.user.memberships, []);
  const oldToken = new URL(pending.activationUrl).searchParams.get("token");
  const denied = await f.request("admin", "POST", `/enterprise/api/organizations/${f.orgA}/invitations`, { email: "new@example.test" });
  assert.equal(denied.statusCode, 409);
  const first = await f.request("owner", "POST", "/enterprise/api/accounts", { email: "new@example.test", orgId: f.orgA, role: "admin" });
  assert.equal(first.statusCode, 202, first.body);
  const second = await f.request("owner", "POST", "/enterprise/api/accounts", { email: "NEW@example.test", orgId: f.orgB });
  assert.equal(second.statusCode, 202, second.body);
  assert.equal(second.json().user.id, pending.user.id);
  assert.equal(second.json().user.memberships.length, 2);
  assert.equal((await f.request("owner", "POST", "/enterprise/api/activate", { token: oldToken, password: "Synthetic-password-123!" })).statusCode, 400);
  const token = new URL(second.json().activationUrl).searchParams.get("token");
  assert.equal((await f.request("owner", "POST", "/enterprise/api/activate", { token, password: "Synthetic-password-123!" })).statusCode, 200);
  const reuse = await f.request("owner", "POST", "/enterprise/api/accounts", { email: "new@example.test", orgId: f.orgA, role: "member" });
  assert.equal(reuse.statusCode, 201);
  assert.equal(reuse.json().activationUrl, undefined);
  assert.equal(reuse.json().user.memberships.find((m: any) => m.orgId === f.orgA).role, "admin");
  assert.equal((await f.request("owner", "PATCH", `/enterprise/api/accounts/${f.users.owner.id}`, { enabled: false })).statusCode, 409);
  assert.equal((await f.request("owner", "POST", "/enterprise/api/accounts", { email: "escalation@example.test", role: "owner" })).statusCode, 400);
  assert.equal((await f.request("admin", "PATCH", `/enterprise/api/accounts/${pending.user.id}`, { enabled: false })).statusCode, 403);
  await f.request("owner", "PATCH", `/enterprise/api/accounts/${pending.user.id}`, { enabled: false });
  assert.equal((await f.db.get<any>("SELECT enabled FROM users WHERE id=?", [pending.user.id]))!.enabled, 0);
  assert.equal((await f.db.get<any>("SELECT COUNT(*) AS count FROM sessions WHERE user_id=?", [pending.user.id]))!.count, 0);
});

test("all workspace members share every conversation and draft while revocation removes current access", async (t) => {
  const f = await platformFixture(t);
  const create = await f.request("full", "POST", `/enterprise/api/projects/${f.projectA}/conversations`, { title: "Shared conversation" });
  assert.equal(create.statusCode, 201, create.body);
  const chat = create.json(), path = `/enterprise/api/conversations/${chat.id}`;
  assert.equal((await f.db.get<any>("SELECT access FROM project_members WHERE project_id=? AND user_id=?", [f.projectA, f.users.read.id]))!.access, "write");
  assert.equal((await f.request("read", "GET", `/enterprise/api/projects/${f.projectA}/conversations`)).json().items.some((c: any) => c.id === chat.id), true);
  for (const suffix of ["", "/messages", "/export", "/members"])
    assert.equal((await f.request("read", "GET", path + suffix)).statusCode, 200, suffix);
  const members = (await f.request("read", "GET", path + "/members")).json().items;
  assert.equal(members.some((m: any) => m.id === f.users.read.id), true);
  assert.equal(members.some((m: any) => m.id === f.users.full.id && m.isCreator), true);
  assert.equal((await f.request("read", "PATCH", path, { title: "Edited by collaborator" })).statusCode, 200);
  assert.equal((await f.request("read", "DELETE", path)).statusCode, 200);
  assert.equal((await f.request("full", "GET", `/enterprise/api/projects/${f.projectA}/conversations?trash=1`)).json().items.some((c: any) => c.id === chat.id), true);
  assert.equal((await f.request("read", "POST", path + "/restore", {})).statusCode, 200);
  const assetResponse = await f.request("full", "POST", `/enterprise/api/organizations/${f.orgA}/assets`, { name: "Shared draft", projectId: f.projectA, document: { version: 1, blocks: [{ type: "text", text: "Initial" }] } });
  assert.equal(assetResponse.statusCode, 201, assetResponse.body);
  const asset = assetResponse.json();
  assert.equal((await f.request("read", "GET", `/enterprise/api/assets/${asset.id}`)).json().canEdit, true);
  // Removing the creator does not orphan workspace-owned content.
  await f.request("admin", "DELETE", `/enterprise/api/projects/${f.projectA}/members/${f.users.full.id}`);
  assert.equal((await f.request("full", "GET", path)).statusCode, 404);
  assert.equal((await f.request("read", "GET", path)).statusCode, 200);
  assert.equal((await f.request("read", "PATCH", `/enterprise/api/assets/${asset.id}`, { name: "Still shared", expectedRevision: asset.revision })).statusCode, 200);
  assert.equal((await f.request("read", "GET", asset.url + "/preview")).statusCode, 200);
  assert.equal((await f.request("other", "GET", path)).statusCode, 404);
  assert.equal((await f.request("other", "GET", `/enterprise/api/assets/${asset.id}`)).statusCode, 404);
  await f.request("admin", "DELETE", `/enterprise/api/projects/${f.projectA}/members/${f.users.read.id}`);
  for (const suffix of ["", "/messages", "/export", "/members"])
    assert.equal((await f.request("read", "GET", path + suffix)).statusCode, 404, suffix);
  assert.equal((await f.request("read", "GET", `/enterprise/api/assets/${asset.id}`)).statusCode, 404);
});

test("owner can enroll an existing pending identity across organizations without leaving an earlier activation usable", async (t) => {
  const f = await platformFixture(t), email = "pending-shared@example.test";
  const first = await f.request("admin", "POST", `/enterprise/api/organizations/${f.orgA}/invitations`, { email });
  assert.equal(first.statusCode, 202);
  const second = await f.request("owner", "POST", `/enterprise/api/organizations/${f.orgB}/invitations`, { email });
  assert.equal(second.statusCode, 202, second.body);
  assert.equal(second.json().user.id, first.json().user.id);
  assert.equal((await f.request("admin", "POST", `/enterprise/api/organizations/${f.orgA}/invitations`, { email })).statusCode, 409);
  assert.equal((await f.request("owner", "POST", "/enterprise/api/activate", {
    token: new URL(first.json().activationUrl).searchParams.get("token"), password: "Synthetic-password-123!",
  })).statusCode, 400);
  assert.equal((await f.request("owner", "POST", "/enterprise/api/activate", {
    token: new URL(second.json().activationUrl).searchParams.get("token"), password: "Synthetic-password-123!",
  })).statusCode, 200);
  assert.equal((await f.db.all("SELECT * FROM organization_memberships WHERE user_id=?", [first.json().user.id])).length, 2);
});

test("populated foundation migration preserves identities, grants, invitations and child foreign keys", async (t) => {
  const db = await createDatabase(":memory:");
  t.after(() => db.close());
  await migrateFoundation({ ...db, migrate: (name, sql, options) => name === "platform-accounts-workspaces-v2" ? Promise.resolve() : db.migrate(name, sql, options) });
  await db.run("INSERT INTO organizations(id,name,created_at) VALUES('org','Organization','now')");
  await db.run("INSERT INTO users(id,org_id,email,name,role,created_at) VALUES('owner',NULL,'owner@example.test','Owner','owner','now'),('member','org','member@example.test','Member','member','now')");
  await db.run("INSERT INTO projects(id,org_id,name,created_at) VALUES('project','org','Workspace','now')");
  await db.run("INSERT INTO project_members VALUES('project','member','read','now')");
  await db.run("INSERT INTO invitations VALUES('invitation','org','member','hash','later',NULL,'now')");
  await db.run("INSERT INTO sessions VALUES('session','member','csrf','later','now')");
  const before = await db.all("SELECT * FROM users ORDER BY id");
  await migrateFoundation(db);
  assert.deepEqual(await db.all("SELECT * FROM users ORDER BY id"), before);
  assert.equal((await db.get<any>("SELECT access FROM project_members"))!.access, "write");
  assert.equal((await db.get<any>("SELECT user_id FROM sessions"))!.user_id, "member");
  assert.equal((await db.get<any>("SELECT token_hash FROM invitations"))!.token_hash, "hash");
  assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
  await assert.rejects(db.run("INSERT INTO users(id,email,name,role,created_at) VALUES('owner2','second@example.test','Second','owner','now')"), /UNIQUE/);
  await assert.rejects(db.run("UPDATE users SET role='member' WHERE id='owner'"), /cannot be disabled or demoted/);
  await assert.rejects(db.run("DELETE FROM users WHERE id='owner'"), /cannot be removed/);
  await assert.rejects(db.run("INSERT INTO project_members VALUES('missing','member','write','now')"), /FOREIGN KEY/);
  await migrateFoundation(db);
  assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
});

test("full populated upgrade retains authentication, archived native history, indexes and explicitly shared organization files", async (t) => {
  const db = await createDatabase(":memory:");
  const legacyDatabase = { ...db, migrate: (name: string, sql: string, options?: { rebuild?: boolean }) =>
    ["platform-accounts-workspaces-v2", "conversation-five-native-harnesses-v1"].includes(name)
      ? Promise.resolve() : db.migrate(name, sql, options) };
  const f = await platformFixture(t, { database: legacyDatabase, startConversations: false });
  f.ctx.onAccessChanged = undefined;
  const now = new Date().toISOString(), userId = f.users.full.id;
  await db.run("INSERT INTO invitations VALUES('pending-invite',?,?,'synthetic-token-hash','2099-01-01',NULL,?)", [f.orgA, userId, now]);
  await db.run("INSERT INTO conversations(id,org_id,project_id,creator_id,title,mode,harness,model,created_at,updated_at,runtime_generation) VALUES('legacy-chat',?,?,?,'Existing read chat','read','pi','fixture',?,?,3)", [f.orgA, f.projectA, userId, now, now]);
  await db.run("INSERT INTO conversation_members VALUES('legacy-chat',?,?,?)", [userId, userId, now]);
  await db.run("INSERT INTO conversation_messages(id,conversation_id,run_id,role,author_id,content,created_at) VALUES('legacy-user','legacy-chat','legacy-run','user',?,'Synthetic prompt',?),('legacy-answer','legacy-chat','legacy-run','assistant',NULL,'Synthetic retained answer',?)", [userId, now, now]);
  await db.run("INSERT INTO conversation_runs(id,conversation_id,org_id,project_id,user_id,request_id,user_message_id,assistant_message_id,status,mode,harness,model,native_session_id,created_at,runtime_cursor,runtime_ack,runtime_generation) VALUES('legacy-run','legacy-chat',?,?,?,'legacy-request','legacy-user','legacy-answer','completed','read','pi','fixture','native-retained-id',?,8,8,3)", [f.orgA, f.projectA, userId, now]);
  await db.run("INSERT INTO conversation_runtime_owners VALUES('legacy-chat',?,3,'retained-authority')", [userId]);
  await db.run("INSERT INTO conversation_events(conversation_id,run_id,type,data,created_at) VALUES('legacy-chat','legacy-run','assistant_delta',?,?)", [JSON.stringify({ delta: "Synthetic retained answer" }), now]);
  await db.run("INSERT INTO conversation_native_records(conversation_id,run_id,source_id,record_id,revision,native_session_id,kind,search_text,payload,created_at) VALUES('legacy-chat','legacy-run','pi','record-one','1','native-retained-id','message','Synthetic retained answer','{}',?)", [now]);
  const shared = await uploadFile(f.ctx, f.users.admin, { orgId: f.orgA }, "Shared.json", Buffer.from('[{"name":"Preserved source"}]'));
  await shareFile(f.ctx, f.users.admin, shared.id, f.projectA, "read", "Shared.json");
  await db.run("INSERT INTO workspace_file_grants VALUES(?,?,'read',?)", [shared.id, userId, now]);
  await db.run("INSERT INTO conversation_run_sources VALUES('legacy-run',?,'Shared.json',?)", [shared.id, shared.versionId!]);
  const unchanged = ["users", "sessions", "organization_memberships", "invitations", "conversation_members", "conversation_messages", "conversation_runs", "conversation_events", "conversation_native_records", "conversation_runtime_owners", "conversation_run_sources", "workspace_files", "workspace_file_versions", "workspace_file_shares", "workspace_file_grants"];
  const snapshots = new Map(await Promise.all(unchanged.map(async table => [table, await db.all(`SELECT * FROM ${table} ORDER BY rowid`)] as const)));
  const indexes = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name");
  await migrateFoundation(db);
  await migrateNativeHarnesses({ ...f.ctx, db });
  for (const table of unchanged) assert.deepEqual(await db.all(`SELECT * FROM ${table} ORDER BY rowid`), snapshots.get(table), table);
  for (const index of indexes) assert.ok(await db.get("SELECT name FROM sqlite_master WHERE type='index' AND name=?", [index.name]), index.name);
  assert.equal((await db.get<any>("SELECT access FROM project_members WHERE project_id=? AND user_id=?", [f.projectA, f.users.read.id]))!.access, "write");
  const chat = await db.get<any>("SELECT * FROM conversations WHERE id='legacy-chat'");
  assert.equal(chat!.mode, "write");
  assert.equal(chat!.native_storage_mode, "read");
  assert.equal(chat!.runtime_generation, 4);
  assert.equal((await db.get<any>("SELECT generation FROM conversation_runtime_stops WHERE conversation_id='legacy-chat'"))!.generation, 4);
  assert.equal((await f.request("full", "GET", "/enterprise/api/session")).json().user.id, userId);
  assert.equal((await f.request("read", "GET", "/enterprise/api/conversations/legacy-chat/export")).statusCode, 200);
  assert.equal((await readCurrentFile(f.ctx, f.users.read, shared.id, { projectId: f.projectA, maxBytes: 1024 })).toString(), '[{"name":"Preserved source"}]');
  assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
  assert.equal((await db.get<any>("PRAGMA foreign_keys"))!.foreign_keys, 1);
});

test("workspace report fallback cannot borrow owner library authority before sharing or after source revocation", async (t) => {
  const f = await platformFixture(t), base = `/enterprise/api/organizations/${f.orgA}/assets`;
  const file = await uploadFile(f.ctx, f.users.admin, { orgId: f.orgA }, "Private.json", Buffer.from('[{"name":"Only explicitly shared"}]'));
  const document = { version: 1, blocks: [{ type: "table", fileId: file.id, pointer: "", columns: [{ label: "Name", key: "name" }] }] };
  // Even the platform owner cannot use organization authority to supply an
  // unshared library source inside a workspace report.
  assert.equal((await f.request("owner", "POST", base, { name: "Denied unshared source", projectId: f.projectA, document })).statusCode, 403);
  await shareFile(f.ctx, f.users.admin, file.id, f.projectA, "read", "Private.json");
  const result = await f.request("full", "POST", base, { name: "Shared report", projectId: f.projectA, document, publish: true, visibility: "public" });
  assert.equal(result.statusCode, 201, result.body);
  const asset = result.json();
  await f.request("admin", "DELETE", `/enterprise/api/organizations/${f.orgA}/members/${f.users.full.id}`);
  assert.equal((await f.request("read", "GET", asset.url + "/preview")).statusCode, 200);
  assert.equal((await f.request(undefined, "GET", asset.url)).statusCode, 200);
  assert.equal((await f.request("full", "GET", asset.url + "/preview")).statusCode, 404);
  await revokeShare(f.ctx, f.users.admin, file.id, f.projectA);
  assert.equal((await f.request(undefined, "GET", asset.url)).statusCode, 403);
  assert.equal((await f.request("read", "GET", asset.url + "/preview")).statusCode, 403);
  assert.equal((await f.request("owner", "GET", asset.url + "/preview")).statusCode, 403);
  assert.equal((await f.request("owner", "POST", `/enterprise/api/assets/${asset.id}/versions/1/restore`, { expectedRevision: asset.revision })).statusCode, 403);
});
