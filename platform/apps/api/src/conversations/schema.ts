export const schema = `
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), project_id TEXT NOT NULL REFERENCES projects(id),
 creator_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('read','write')),
 harness TEXT NOT NULL CHECK(harness = 'pi'), model TEXT NOT NULL, connection_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS conversation_members (
 conversation_id TEXT NOT NULL REFERENCES conversations(id), user_id TEXT NOT NULL REFERENCES users(id),
 added_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE IF NOT EXISTS conversation_messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), run_id TEXT,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')), author_id TEXT REFERENCES users(id), content TEXT NOT NULL,
 citations TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_runs (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), org_id TEXT NOT NULL REFERENCES organizations(id),
 project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
 user_message_id TEXT NOT NULL REFERENCES conversation_messages(id), assistant_message_id TEXT NOT NULL REFERENCES conversation_messages(id),
 status TEXT NOT NULL CHECK(status IN ('queued','dispatching','running','cancelling','completed','failed','cancelled','interrupted')),
 mode TEXT NOT NULL, harness TEXT NOT NULL, model TEXT NOT NULL, connection_id TEXT, native_session_id TEXT,
 error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
 UNIQUE(conversation_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_active_run ON conversation_runs(conversation_id)
 WHERE status IN ('dispatching','running','cancelling');
CREATE INDEX IF NOT EXISTS conversation_runs_queue ON conversation_runs(conversation_id,status,created_at);
CREATE INDEX IF NOT EXISTS conversation_messages_order ON conversation_messages(conversation_id,created_at);
CREATE TABLE IF NOT EXISTS conversation_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id), run_id TEXT,
 type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_events_replay ON conversation_events(conversation_id,id);
`;
