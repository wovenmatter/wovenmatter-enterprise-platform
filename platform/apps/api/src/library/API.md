# Safe reports

All application, API and report paths start with `/enterprise`. Reports use ordinary portal authorization and never execute generated code. The accepted version 1 JSON document is specified in [agent instructions](../../../../runtime/AGENTS.md). Plain text is escaped; fixed server templates render tables and SVG bar charts. Uploaded images are PNG/JPEG/WebP only. Arbitrary HTML, CSS, SVG input, scripts, forms, URLs and server entrypoints are rejected.

- `GET /enterprise/api/organizations/:orgId/assets` lists accessible reports.
- `POST /enterprise/api/organizations/:orgId/assets` accepts `{projectId,name,visibility?:"project"|"organization"|"public",document?:Report,sourceFileId?:string}`. Supply a validated document or a project report JSON file. Requires current full project access. Default visibility is project.
- `GET /enterprise/api/assets/:assetId` returns authorized metadata.
- `PATCH /enterprise/api/assets/:assetId` changes name, visibility, or document. Creator with current project access, organization admin, or owner may manage visibility. Changing the document requires full project access.
- `DELETE /enterprise/api/assets/:assetId` immediately retires the link.
- `GET /enterprise/reports/:assetId` renders authorized current data. `GET .../images/:index` repeats the same visibility and source checks. Public reports work without login. Organization reports require current membership; project reports require current project access.

A report can select only explicit columns from current JSON files in its project or current organization shares mounted into that project. Every render/resource requires the creator to retain project access. Removed membership, deleted project, unavailable source or revoked share fails closed. No raw source-data endpoint is exposed publicly. A published definition is retained until updated; selected data is re-read on each load. Already downloaded data cannot be recalled.

Responses are no-store with a restrictive CSP: sandbox, no script, no form, no base URL, no network connections. Server-generated fixed styles and validated inline data images are the only permitted resources. Filenames, captions, numeric chart geometry and text never become active markup. Each render bounds source bytes to8MiB, each source to4MiB, emitted content to8MiB and table cells to100000. Reads are sequential, descriptor checked and cached for that render. Historical executable app routes, version bundles, arbitrary HTTP/WebSocket forwarding and asset origin cookies are removed.
