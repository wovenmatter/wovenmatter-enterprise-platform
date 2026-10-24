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
ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'green' CHECK(theme IN ('green','cognac','dark'));
CREATE TABLE password_reset_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,used_at TEXT,created_at TEXT NOT NULL,request_ip_hash TEXT);
CREATE INDEX password_reset_tokens_user ON password_reset_tokens(user_id,created_at);
CREATE INDEX password_reset_tokens_expiry ON password_reset_tokens(expires_at);
`,
  );
  await db.migrate(
    "foundation-v4-user-default-model",
    "ALTER TABLE users ADD COLUMN default_model TEXT;",
  );
  await db.migrate(
    "platform-memberships-v1",
    `
CREATE TABLE organization_memberships(org_id TEXT NOT NULL REFERENCES organizations(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL CHECK(role IN ('admin','member')),library_access TEXT NOT NULL DEFAULT 'read' CHECK(library_access IN ('read','write')),created_at TEXT NOT NULL,PRIMARY KEY(org_id,user_id));
INSERT INTO organization_memberships SELECT org_id,id,role,CASE WHEN role='admin' THEN 'write' ELSE 'read' END,created_at FROM users WHERE org_id IS NOT NULL;
CREATE INDEX memberships_user ON organization_memberships(user_id);
-- Compatibility with baseline development fixtures. Legacy home/role columns are
-- retained for safe upgrades but never used as an authorization boundary.
CREATE TRIGGER legacy_user_membership AFTER INSERT ON users WHEN NEW.org_id IS NOT NULL BEGIN
 INSERT INTO organization_memberships VALUES(NEW.org_id,NEW.id,NEW.role,CASE WHEN NEW.role='admin' THEN 'write' ELSE 'read' END,NEW.created_at);
END;
ALTER TABLE organizations ADD COLUMN default_host_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE projects ADD COLUMN host_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE projects ADD COLUMN deleted_at TEXT;
ALTER TABLE projects ADD COLUMN purge_after TEXT;
`,
  );
  await db.migrate(
    "platform-accounts-workspaces-v2",
    `
DROP TRIGGER legacy_user_membership;
CREATE TABLE users_next(id TEXT PRIMARY KEY,org_id TEXT REFERENCES organizations(id),email TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),password_hash TEXT,created_at TEXT NOT NULL,theme TEXT NOT NULL DEFAULT 'green' CHECK(theme IN ('green','cognac','dark')),default_model TEXT,CHECK(role<>'owner' OR org_id IS NULL));
INSERT INTO users_next SELECT id,org_id,email,name,role,enabled,password_hash,created_at,theme,default_model FROM users;
DROP TABLE users;
ALTER TABLE users_next RENAME TO users;
CREATE UNIQUE INDEX users_one_owner ON users(role) WHERE role='owner';
CREATE TRIGGER users_keep_owner BEFORE DELETE ON users WHEN OLD.role='owner' BEGIN SELECT RAISE(ABORT,'The platform owner cannot be removed'); END;
CREATE TRIGGER users_keep_owner_authority BEFORE UPDATE OF role,enabled ON users WHEN OLD.role='owner' AND (NEW.role<>'owner' OR NEW.enabled<>1) BEGIN SELECT RAISE(ABORT,'The platform owner cannot be disabled or demoted'); END;
CREATE TRIGGER legacy_user_membership AFTER INSERT ON users WHEN NEW.org_id IS NOT NULL BEGIN
 INSERT INTO organization_memberships VALUES(NEW.org_id,NEW.id,NEW.role,CASE WHEN NEW.role='admin' THEN 'write' ELSE 'read' END,NEW.created_at);
END;
CREATE TABLE invitations_next(id TEXT PRIMARY KEY,org_id TEXT REFERENCES organizations(id),user_id TEXT NOT NULL REFERENCES users(id),token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,accepted_at TEXT,created_at TEXT NOT NULL);
INSERT INTO invitations_next SELECT * FROM invitations;
DROP TABLE invitations;
ALTER TABLE invitations_next RENAME TO invitations;
UPDATE project_members SET access='write' WHERE access='read';
UPDATE projects SET access='write' WHERE access='read';
CREATE TRIGGER workspace_members_full_insert AFTER INSERT ON project_members WHEN NEW.access='read' BEGIN UPDATE project_members SET access='write' WHERE project_id=NEW.project_id AND user_id=NEW.user_id; END;
CREATE TRIGGER workspace_members_full_update AFTER UPDATE OF access ON project_members WHEN NEW.access='read' BEGIN UPDATE project_members SET access='write' WHERE project_id=NEW.project_id AND user_id=NEW.user_id; END;
`,
    { rebuild: true },
  );
}
