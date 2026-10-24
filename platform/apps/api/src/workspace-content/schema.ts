// Ported contracts: wovenmatter 04fe05090e107df92c498a4563b742978c91d933,
// WorkspaceDatabase+Notes.swift, WorkspaceCalendar.swift and WorkspaceLibrary.swift.
export const schema = `
CREATE TABLE workspace_content (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 kind TEXT NOT NULL CHECK(kind IN ('note','artifact','event','task','library')),
 title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', folder_id TEXT REFERENCES project_folders(id),
 data TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX workspace_content_scope ON workspace_content(project_id,kind,updated_at);
CREATE TABLE workspace_content_versions (
 content_id TEXT NOT NULL REFERENCES workspace_content(id), revision INTEGER NOT NULL,
 title TEXT NOT NULL, body TEXT NOT NULL, folder_id TEXT, data TEXT NOT NULL,
 updated_by TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
 PRIMARY KEY(content_id,revision)
);
CREATE TABLE workspace_task_state (
 content_id TEXT PRIMARY KEY REFERENCES workspace_content(id), next_at TEXT,
 conversation_id TEXT REFERENCES conversations(id), last_status TEXT, last_error TEXT
);
CREATE TABLE workspace_task_runs (
 id TEXT PRIMARY KEY, content_id TEXT NOT NULL REFERENCES workspace_content(id),
 occurrence TEXT NOT NULL, conversation_id TEXT REFERENCES conversations(id),
 run_id TEXT REFERENCES conversation_runs(id), status TEXT NOT NULL, error TEXT,
 created_at TEXT NOT NULL, UNIQUE(content_id,occurrence)
);
`;
