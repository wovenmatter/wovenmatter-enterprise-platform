import type { Database } from "./index.js";
export async function migrateFoundation(db: Database) {
  await db.migrate(
    "foundation-v1",
    `
CREATE TABLE organizations(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE users(id TEXT PRIMARY KEY, org_id TEXT REFERENCES organizations(id), email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','member')), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), password_hash TEXT, created_at TEXT NOT NULL, CHECK((role='owner' AND org_id IS NULL) OR (role<>'owner' AND org_id IS NOT NULL)));
CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE invitations(id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, accepted_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE projects(id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'provisioning', access TEXT NOT NULL DEFAULT 'write' CHECK(access IN ('read','write')), created_at TEXT NOT NULL);
CREATE INDEX projects_org ON projects(org_id);
CREATE TABLE project_members(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,access TEXT NOT NULL CHECK(access IN ('read','write')),created_at TEXT NOT NULL,PRIMARY KEY(project_id,user_id));
CREATE TABLE jobs(id TEXT PRIMARY KEY,org_id TEXT REFERENCES organizations(id),project_id TEXT REFERENCES projects(id),type TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT NOT NULL,lease_until TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,lease_token TEXT,idempotency_key TEXT,UNIQUE(org_id,type,idempotency_key));
CREATE INDEX jobs_ready ON jobs(status,available_at);
CREATE TABLE audit_events(id TEXT PRIMARY KEY,org_id TEXT REFERENCES organizations(id),user_id TEXT REFERENCES users(id),action TEXT NOT NULL,entity_id TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX audit_org ON audit_events(org_id,created_at);
`,
  );
  await db.migrate(
    "foundation-v2",
    `CREATE UNIQUE INDEX users_one_owner ON users(role) WHERE role='owner'; CREATE UNIQUE INDEX jobs_idempotency ON jobs(COALESCE(org_id,''),type,idempotency_key) WHERE idempotency_key IS NOT NULL; CREATE INDEX sessions_expiry ON sessions(expires_at);`,
  );
  await db.migrate(
    "foundation-v3-user-profile-reset",
    `
ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'green' CHECK(theme IN ('green','cognac'));
CREATE TABLE password_reset_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,used_at TEXT,created_at TEXT NOT NULL,request_ip_hash TEXT);
CREATE INDEX password_reset_tokens_user ON password_reset_tokens(user_id,created_at);
CREATE INDEX password_reset_tokens_expiry ON password_reset_tokens(expires_at);
`,
  );
}
