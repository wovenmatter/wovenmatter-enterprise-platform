import type { AppContext } from "../context.js";

/** Add explicit asset ownership; never synthesize a project or import a private thread. */
export async function migrateAssetAgents(ctx: AppContext) {
  await ctx.db.migrate(
    "asset-agent-storage-v1",
    `
CREATE TABLE asset_workspaces(asset_id TEXT PRIMARY KEY REFERENCES reports(id),host_id TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','ready','releasing')),last_activity INTEGER NOT NULL,user_id TEXT NOT NULL REFERENCES users(id));
CREATE TABLE asset_sources(asset_id TEXT NOT NULL REFERENCES reports(id),file_id TEXT NOT NULL REFERENCES workspace_files(id),PRIMARY KEY(asset_id,file_id));
CREATE TABLE asset_output_files(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES reports(id),path TEXT NOT NULL,version_id TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(asset_id,path));
CREATE TABLE asset_output_versions(id TEXT PRIMARY KEY,file_id TEXT NOT NULL REFERENCES asset_output_files(id),hash TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE asset_agent_saves(run_id TEXT NOT NULL,operation_id TEXT NOT NULL,asset_id TEXT NOT NULL REFERENCES reports(id),fingerprint TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(run_id,operation_id));
`,
  );
}

/** An atomic, explicitly FK-validated rebuild keeps populated histories intact while
 * removing the obsolete project-only constraint. No account or file is rewritten. */
export async function migrateAssetConversations(ctx: AppContext) {
  await ctx.db.migrate(
    "asset-conversations-v1",
    `
CREATE TABLE conversations_next (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), project_id TEXT REFERENCES projects(id),
 creator_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('read','write')),
 harness TEXT NOT NULL CHECK(harness = 'pi'), model TEXT NOT NULL, connection_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,runtime_generation INTEGER NOT NULL DEFAULT 0,
 asset_id TEXT UNIQUE REFERENCES reports(id),CHECK(project_id IS NOT NULL OR asset_id IS NOT NULL)
);
INSERT INTO conversations_next SELECT *,NULL FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_next RENAME TO conversations;
CREATE TRIGGER conversation_fixed_mode BEFORE UPDATE OF mode ON conversations WHEN NEW.mode<>OLD.mode BEGIN SELECT RAISE(ABORT,'Thread mode is fixed'); END;
CREATE TABLE conversation_runs_next (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), org_id TEXT NOT NULL REFERENCES organizations(id),
 project_id TEXT REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
 user_message_id TEXT NOT NULL REFERENCES conversation_messages(id), assistant_message_id TEXT NOT NULL REFERENCES conversation_messages(id),
 status TEXT NOT NULL CHECK(status IN ('queued','dispatching','running','cancelling','completed','failed','cancelled','interrupted')),
 mode TEXT NOT NULL, harness TEXT NOT NULL, model TEXT NOT NULL, connection_id TEXT, native_session_id TEXT,
 error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
 runtime_cursor INTEGER NOT NULL DEFAULT 0,runtime_initial TEXT NOT NULL DEFAULT '[]',runtime_ack INTEGER NOT NULL DEFAULT 0,runtime_generation INTEGER NOT NULL DEFAULT 0,
 asset_id TEXT REFERENCES reports(id),UNIQUE(conversation_id,request_id),CHECK(project_id IS NOT NULL OR asset_id IS NOT NULL)
);
INSERT INTO conversation_runs_next SELECT *,NULL FROM conversation_runs;
DROP TABLE conversation_runs;
ALTER TABLE conversation_runs_next RENAME TO conversation_runs;
CREATE UNIQUE INDEX conversation_one_active_run ON conversation_runs(conversation_id) WHERE status IN ('dispatching','running','cancelling');
CREATE INDEX conversation_runs_queue ON conversation_runs(conversation_id,status,created_at);
CREATE INDEX conversation_runs_capacity ON conversation_runs(status,org_id);
`,
    { rebuild: true },
  );
}
export function workspaceId(row: {
  project_id: string | null;
  asset_id?: string | null;
}): string {
  if (row.project_id) return row.project_id;
  if (!row.asset_id) throw new Error("Workspace ownership is missing");
  return "asset-" + row.asset_id;
}
