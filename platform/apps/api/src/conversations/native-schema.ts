import { AppError, type AppContext } from "../context.js";

export function nativeOptions(value: unknown): {thinking?: string; permission?: string} {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([key, item]) =>
    !["thinking", "permission"].includes(key) || typeof item !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(item)))
    throw new AppError(400, "invalid_native_settings", "Choose an advertised native setting.");
  return value;
}

/** FK-checked rebuild preserves every chat, message, native session and SDK choice.
 * Old read namespaces are fenced; their private storage lineage remains unchanged. */
export async function migrateNativeHarnesses(ctx: AppContext) {
  await ctx.db.migrate("workspace-agent-settings-v1", "CREATE TABLE workspace_agent_settings(project_id TEXT PRIMARY KEY REFERENCES projects(id),settings TEXT NOT NULL DEFAULT '{}',updated_at TEXT NOT NULL,updated_by TEXT NOT NULL REFERENCES users(id));");
  await ctx.db.migrate("conversation-five-native-harnesses-v1", `
CREATE TABLE conversations_native (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), project_id TEXT REFERENCES projects(id),
 creator_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('read','write')),
 harness TEXT NOT NULL CHECK(harness IN ('pi','codex','claude_code','grok_build','opencode')), model TEXT NOT NULL, connection_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,runtime_generation INTEGER NOT NULL DEFAULT 0,
 asset_id TEXT UNIQUE REFERENCES reports(id),folder_id TEXT REFERENCES project_folders(id),working_directory TEXT,directory_device TEXT,directory_inode TEXT,scratch_name TEXT,
 workspace_locked INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,pi_options TEXT NOT NULL DEFAULT '{}',
 native_options TEXT NOT NULL DEFAULT '{}',native_storage_mode TEXT NOT NULL DEFAULT 'write' CHECK(native_storage_mode IN ('read','write')),
 CHECK(project_id IS NOT NULL OR asset_id IS NOT NULL)
);
INSERT INTO conversations_native SELECT *, '{}', mode FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_native RENAME TO conversations;
INSERT INTO conversation_runtime_stops(conversation_id,project_id,generation)
 SELECT id,COALESCE(project_id,'asset-'||asset_id),runtime_generation+1 FROM conversations WHERE mode='read'
 ON CONFLICT(conversation_id) DO UPDATE SET generation=MAX(generation,excluded.generation);
UPDATE conversations SET runtime_generation=runtime_generation+1,mode='write' WHERE mode='read';
UPDATE conversation_runs SET status='interrupted',error_code='access_mode_migrated',error_message='The workspace now has full access. Interrupted work was not replayed.',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE mode='read' AND status IN ('dispatching','running','cancelling');
UPDATE conversation_runs SET mode='write',runtime_generation=(SELECT runtime_generation FROM conversations WHERE id=conversation_id) WHERE mode='read' AND status='queued';
CREATE TRIGGER conversation_full_access_insert AFTER INSERT ON conversations WHEN NEW.mode='read' BEGIN UPDATE conversations SET mode='write' WHERE id=NEW.id; END;
CREATE TRIGGER conversation_full_access_update AFTER UPDATE OF mode ON conversations WHEN NEW.mode='read' BEGIN UPDATE conversations SET mode='write' WHERE id=NEW.id; END;
ALTER TABLE conversation_inputs ADD COLUMN native_response TEXT;
`, {rebuild: true});
}
