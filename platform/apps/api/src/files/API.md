# Files API

The file registrar exports `registerFiles(app, ctx)` and runs migration `workspace-files-v1`.
All endpoints use the session cookie and all mutations use the common CSRF header.
IDs below are opaque. A file keeps its identity after ordinary rename/move and retains immutable prior versions. A copy receives a new identity. Native edits are reconciled at listing/read/dispatch and after runtime completion, including cancellation. Only observed versions are retained; this is not a recording of every intermediate native write.

```json
{
  "scope": {
    "orgId": "required organization id",
    "projectId": "optional project id"
  },
  "record": {
    "id": "file id",
    "orgId": "organization id",
    "projectId": "project id or null",
    "name": "basename",
    "path": "relative/path",
    "kind": "file|folder",
    "size": 0,
    "updatedAt": "ISO8601",
    "access": "read|write",
    "versionId": "immutable version id or null",
    "needsAttention": "optional size or version storage explanation",
    "sharedFrom": {
      "fileId": "source root id",
      "orgId": "organization id",
      "path": "source/path",
      "access": "read|write"
    }
  },
  "routes": [
    {
      "method": "GET",
      "path": "/enterprise/api/files",
      "query": {
        "orgId": "required",
        "projectId": "optional",
        "path": "directory; defaults empty"
      },
      "response": {
        "items": ["record"],
        "access": "read|write for current directory"
      }
    },
    {
      "method": "POST",
      "path": "/enterprise/api/files/upload",
      "encoding": "multipart/form-data",
      "fields": {
        "orgId": "required",
        "projectId": "optional",
        "path": "destination directory; defaults empty",
        "paths": "optional JSON string array matching file order, preserving relative folder paths",
        "files": "one or more file parts"
      },
      "response": {
        "items": ["record"],
        "errors": [
          {
            "path": "failed/path",
            "code": "error_code",
            "message": "explanation"
          }
        ]
      },
      "partialSuccessStatus": 207
    },
    {
      "method": "POST",
      "path": "/enterprise/api/files/folders",
      "body": {
        "orgId": "required",
        "projectId": "optional",
        "path": "full new/folder/path"
      },
      "response": "record"
    },
    {
      "method": "PATCH",
      "path": "/enterprise/api/files/:fileId",
      "query": {
        "projectId": "required when accessing through a project share"
      },
      "body": { "name": "new basename" },
      "response": "record"
    },
    {
      "method": "POST",
      "path": "/enterprise/api/files/:fileId/transfer",
      "query": { "projectId": "source project context when shared" },
      "body": {
        "destination": {
          "orgId": "required",
          "projectId": "optional",
          "path": "destination directory; defaults empty"
        },
        "operation": "copy|move"
      },
      "response": "record"
    },
    {
      "method": "DELETE",
      "path": "/enterprise/api/files/:fileId",
      "query": { "projectId": "source project context when shared" },
      "responseStatus": 204
    },
    {
      "method": "GET",
      "path": "/enterprise/api/files/:fileId/content",
      "query": {
        "projectId": "source project context when shared",
        "versionId": "optional exact prior version"
      },
      "response": "binary attachment",
      "headers": [
        "X-File-Version",
        "Content-Disposition",
        "Cache-Control: private, no-store"
      ]
    },
    {
      "method": "GET",
      "path": "/enterprise/api/files/:fileId/versions",
      "query": { "projectId": "source project context when shared" },
      "response": {
        "items": [
          {
            "id": "version id",
            "size": 0,
            "name": "original name",
            "createdAt": "ISO8601"
          }
        ]
      }
    },
    {
      "method": "GET",
      "path": "/enterprise/api/files/:fileId/shares",
      "access": "organization admin",
      "response": {
        "items": [
          {
            "projectId": "id",
            "projectName": "name",
            "access": "read|write",
            "name": "visible project name"
          }
        ]
      }
    },
    {
      "method": "POST",
      "path": "/enterprise/api/files/:fileId/shares",
      "access": "organization admin",
      "body": {
        "projectId": "required",
        "access": "read|write",
        "name": "optional project basename"
      },
      "responseStatus": 204
    },
    {
      "method": "DELETE",
      "path": "/enterprise/api/files/:fileId/shares/:projectId",
      "access": "organization admin",
      "responseStatus": 204
    },
    {
      "method": "GET",
      "path": "/enterprise/api/files/:fileId/grants",
      "access": "organization admin",
      "response": {
        "items": [
          {
            "userId": "id",
            "name": "name",
            "email": "email",
            "access": "read|write"
          }
        ]
      }
    },
    {
      "method": "POST",
      "path": "/enterprise/api/files/:fileId/grants",
      "access": "organization admin",
      "body": { "userId": "organization member", "access": "read|write" },
      "responseStatus": 204
    },
    {
      "method": "DELETE",
      "path": "/enterprise/api/files/:fileId/grants/:userId",
      "access": "organization admin",
      "responseStatus": 204
    }
  ]
}
```

## Semantics

- Folder upload uses each browser File's `webkitRelativePath` in the `paths` array, with file parts in matching order. Parents are created automatically. Existing files are atomically replaced and versioned. Existing folders are never overwritten by files. Batch uploads can partially succeed; the UI must display the returned errors.
- Shared entries expose the source ID plus `sharedFrom`; pass the viewing project ID on content/version/change requests. Project access is the intersection of session mode, project/member permission, and share permission. Organization per-user grants apply to organization browsing, not to project shares. All project members receive a share within their project ceiling.
- Sharing only goes organization → project. Move/copy operate both ways, within one organization. Copy requires source read and destination write; move requires both write. The destination path is a directory; the source basename is retained. Name collisions return `409`.
- A share gets a reserved, single-component name at the project root. Its placeholder is excluded from file listings and has no content; runtime mounts cover it with the actual source. Sharing the same source again updates access. To change its visible name, unshare then reshare. Unsharing revokes access before removing an empty placeholder; populated placeholders are never silently deleted.
- Org folder grants inherit through descendants. A more permissive explicit or inherited grant permits write. Users can see ancestor folder names needed to reach their granted descendants. They cannot read other contents.
- Files, grants, and shares are checked against current membership. Existing version reads still require current access. Exact historical versions of a deleted project file remain accessible to current project members; deleting a file does not delete its archived bytes. Revoking access blocks those reads too.
- Defaults: 64 MiB per file, 128 MiB per upload request, 500 file parts per request, 20,000 entries per scope, 32 path segments, 10 GiB live-file allowance plus 10 GiB retained-version allowance per scope. API config can set `maxFileBytes`, `storageQuotaBytes`, and `versionQuotaBytes`. Native files over size/version allowance are listed with `needsAttention` and cannot be downloaded/snapshotted through this API until the limit is resolved. Exact existing historical versions remain readable. Production needs filesystem capacity limits for native agent writes independently of HTTP quotas.
- Symlinks, hard-linked files, traversal names, special devices, and absolute paths are rejected. Linux opens each parent directory with `O_NOFOLLOW` and descriptor-relative paths to prevent concurrent parent replacement escaping API roots. macOS uses a development-only checked path implementation; untrusted runtimes are Linux only.
- Raw agent storage lives in `stateDir/workspaces/{projects|organizations}/ID/files`. Immutable snapshots live in `stateDir/file-versions`; SQLite, snapshots, and the private `stateDir/file-staging` tree are never mounted writable in agents. These directories must share one filesystem so transfer staging can publish via an atomic rename. API file mutations are serialized within the single application process; this is not a multi-replica filesystem writer design.

## Service interfaces

```ts
resolveProjectMounts(ctx, user, projectId, mode: 'read' | 'write')
// -> [{source: absoluteHostPath, target: '/workspace[/SharedName]', readOnly, fileId?}]
reconcileProjectFiles(ctx, projectId) // after every run outcome
captureProjectManifest(ctx, user, projectId)
// -> [{fileId, path: projectVisiblePath, versionId}]; availability snapshot, not citation proof
resolveFileMount(ctx, user, {fileId, projectId?, mode?: 'read' | 'write'})
// -> {source,target,readOnly,fileId,orgId,projectId}
snapshotFileTree(ctx, user, {fileId, versionId?, projectId?})
// -> {files:[{path,bytes:Buffer,versionId}],sourceVersionId,orgId,projectId}
readFileVersion(ctx, user, fileId, {projectId?,versionId?})
// -> {bytes:Buffer,name,versionId,size}
```

Shared-mount revocation invokes `ctx.onAccessChanged`; the conversation manager must cancel affected running tasks and the project supervisor must stop scheduled work using revoked data mounts. Supervisors should revalidate paths/mount plans at dispatch. Linux mount sources must be checked immediately before each isolated execution.
