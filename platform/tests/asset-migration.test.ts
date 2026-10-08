import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../apps/api/src/db/index.js";
import { schema } from "../apps/api/src/conversations/schema.js";
import { migrateAssetConversations } from "../apps/api/src/assets/schema.js";
import type { AppContext } from "../apps/api/src/context.js";
test("populated conversation rebuild preserves every child, cursor, authority fence and fixed-mode constraint", async (t) => {
  const db = await createDatabase(":memory:");
  t.after(() => db.close());
  await db.migrate(
    "fixture-foundation",
    `
CREATE TABLE organizations(id TEXT PRIMARY KEY);
CREATE TABLE users(id TEXT PRIMARY KEY);
CREATE TABLE projects(id TEXT PRIMARY KEY);
CREATE TABLE reports(id TEXT PRIMARY KEY);
INSERT INTO organizations VALUES('org');
INSERT INTO users VALUES('owner');
INSERT INTO projects VALUES('project');
`,
  );
  await db.migrate("fixture-conversations", schema);
  await db.migrate(
    "fixture-populated-history",
    `CREATE TABLE conversation_run_sources(run_id TEXT NOT NULL REFERENCES conversation_runs(id),file_id TEXT NOT NULL,path TEXT NOT NULL,version_id TEXT NOT NULL,PRIMARY KEY(run_id,file_id,path));
CREATE INDEX conversation_runs_capacity ON conversation_runs(status,org_id);
ALTER TABLE conversation_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';
CREATE TABLE conversation_inputs(sequence INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id),request_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES conversation_messages(id),run_id TEXT REFERENCES conversation_runs(id),delivery TEXT NOT NULL,error TEXT,UNIQUE(conversation_id,request_id));
CREATE TRIGGER conversation_fixed_mode BEFORE UPDATE OF mode ON conversations WHEN NEW.mode<>OLD.mode BEGIN SELECT RAISE(ABORT,'Thread mode is fixed'); END;
ALTER TABLE conversations ADD COLUMN runtime_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_runs ADD COLUMN runtime_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_runs ADD COLUMN runtime_initial TEXT NOT NULL DEFAULT '[]';
CREATE TABLE conversation_runtime_owners(conversation_id TEXT NOT NULL REFERENCES conversations(id),user_id TEXT NOT NULL REFERENCES users(id),generation INTEGER NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(conversation_id,user_id));
CREATE TABLE conversation_runtime_stops(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),project_id TEXT NOT NULL,generation INTEGER NOT NULL);
ALTER TABLE conversation_runs ADD COLUMN runtime_ack INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_runs ADD COLUMN runtime_generation INTEGER NOT NULL DEFAULT 0;
INSERT INTO conversations(id,org_id,project_id,creator_id,title,mode,harness,model,created_at,updated_at,runtime_generation) VALUES('thread','org','project','owner','Fixture conversation','write','codex','fixture','now','now',3);
INSERT INTO conversation_members VALUES('thread','owner','owner','now');
INSERT INTO conversation_messages(id,conversation_id,run_id,role,author_id,content,created_at) VALUES('user-message','thread','run','user','owner','fixture prompt','now'),('answer','thread','run','assistant',NULL,'fixture answer','now');
INSERT INTO conversation_runs(id,conversation_id,org_id,project_id,user_id,request_id,user_message_id,assistant_message_id,status,mode,harness,model,created_at,runtime_cursor,runtime_ack,runtime_generation) VALUES('run','thread','org','project','owner','request','user-message','answer','completed','write','codex','fixture','now',4,3,3);
INSERT INTO conversation_run_sources VALUES('run','file','fixture.txt','version');
INSERT INTO conversation_events(conversation_id,run_id,type,data,created_at) VALUES('thread','run','assistant_delta','{}','now');
INSERT INTO conversation_inputs(conversation_id,request_id,message_id,run_id,delivery) VALUES('thread','request','user-message','run','accepted');
INSERT INTO conversation_runtime_owners VALUES('thread','owner',3,'signature');
INSERT INTO conversation_runtime_stops VALUES('thread','project',4);
`,
  );

  const tables = [
    "conversation_members",
    "conversation_messages",
    "conversation_run_sources",
    "conversation_events",
    "conversation_inputs",
    "conversation_runtime_owners",
    "conversation_runtime_stops",
  ];
  const before = Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        await db.all("SELECT * FROM " + table),
      ]),
    ),
  );
  await migrateAssetConversations({ db } as AppContext);
  for (const table of tables)
    assert.deepEqual(await db.all("SELECT * FROM " + table), before[table]);
  assert.equal(
    (await db.get<{ runtime_generation: number }>(
      "SELECT runtime_generation FROM conversations WHERE id='thread'",
    ))!.runtime_generation,
    3,
  );
  assert.equal(
    (await db.get<{ runtime_cursor: number }>(
      "SELECT runtime_cursor FROM conversation_runs WHERE id='run'",
    ))!.runtime_cursor,
    4,
  );
  assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
  await assert.rejects(
    db.run("UPDATE conversations SET mode='read' WHERE id='thread'"),
    /Thread mode is fixed/,
  );
  await assert.rejects(
    db.run(
      "INSERT INTO conversation_members VALUES('missing','owner','owner','now')",
    ),
    /FOREIGN KEY/,
  );
  await assert.rejects(
    db.migrate("deliberately-invalid-rebuild", "DROP TABLE projects", {
      rebuild: true,
    }),
    /foreign keys/,
  );
  assert.equal(
    (await db.get<{ id: string }>(
      "SELECT id FROM projects WHERE id='project'",
    ))!.id,
    "project",
  );
  assert.equal(
    (await db.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))!
      .foreign_keys,
    1,
  );
  assert.equal(
    await db.get(
      "SELECT name FROM schema_migrations WHERE name='deliberately-invalid-rebuild'",
    ),
    undefined,
  );
  await migrateAssetConversations({ db } as AppContext);
  assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
});

test("a busy BEGIN restores FK enforcement on the same worker before any subsequent request", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "wme-migration-busy-"));
  const filename = join(root, "state.sqlite");
  const db = await createDatabase(filename);
  const other = new DatabaseSync(filename);
  t.after(async () => {
    other.close();
    await db.close();
    await rm(root, { recursive: true, force: true });
  });
  await db.migrate(
    "parents",
    "CREATE TABLE parents(id TEXT PRIMARY KEY);CREATE TABLE children(parent_id TEXT REFERENCES parents(id));",
  );
  await db.run("PRAGMA busy_timeout=20");
  other.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(
      db.migrate("busy-rebuild", "ALTER TABLE parents ADD COLUMN name TEXT", {
        rebuild: true,
      }),
      { code: "database_busy" },
    );
    assert.equal(
      (await db.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))!
        .foreign_keys,
      1,
    );
  } finally {
    other.exec("ROLLBACK");
  }
  await assert.rejects(
    db.run("INSERT INTO children VALUES('missing')"),
    /FOREIGN KEY/,
  );
  assert.equal(
    await db.get(
      "SELECT name FROM schema_migrations WHERE name='busy-rebuild'",
    ),
    undefined,
  );
  await db.migrate("busy-rebuild", "ALTER TABLE parents ADD COLUMN name TEXT", {
    rebuild: true,
  });
  assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
});
