import type { User } from "../context.js";

export type Access = "read" | "write";
export interface Scope {
  orgId: string;
  projectId?: string | null;
}
export interface FileRow {
  id: string;
  org_id: string;
  project_id: string | null;
  scope_key: string;
  path: string;
  kind: "file" | "folder";
  size: number;
  hash: string | null;
  fs_key: string | null;
  version_id: string | null;
  updated_at: string;
  deleted_at: string | null;
}
export interface ShareRow {
  file_id: string;
  project_id: string;
  name: string;
  access: Access;
  created_at: string;
}
export interface FileRecord {
  id: string;
  orgId: string;
  projectId: string | null;
  name: string;
  path: string;
  kind: "file" | "folder";
  size: number;
  updatedAt: string;
  access: Access;
  versionId: string | null;
  needsAttention?: string;
  sharedFrom?: { fileId: string; orgId: string; path: string; access: Access };
}
export interface RuntimeMount {
  source: string;
  target: string;
  readOnly: boolean;
  fileId?: string;
}
export interface AuthorizedFile {
  row: FileRow;
  access: Access;
  share?: ShareRow;
  scope: Scope;
  user: User;
}
