# WovenMatter Enterprise Platform managed workspaces

This document describes the current baseline behavior. Validation commands and remaining live acceptance gates are documented in DEVELOPMENT.md.

## Product

Browser workspaces for expert teams. One organization per ordinary account; platform owner can administer all organizations. Email/password invitations. Platform owner and org admins invite/remove members; org admins create projects and scope members to read/write. Private chats by default; add existing project members to collaborate with shared authorship and ordered execution. Removing project access removes chat access. Read-only and full-access session modes obey current project/member ceilings. No published-release prerequisite or frozen conversation document snapshot.

Org and project filesystems provide ordinary upload (including folders), mkdir, rename, move, copy and delete. Move/copy operate in both directions. Org files/folders may also be shared into projects, read-only or read-write, referencing the same underlying content, available to all project members, listed on the source with revocation. No project-to-org shared link. Stable file/version identities and bounded access; raw files available to native agents immediately. Full document extraction/OCR/index pipeline and specialized document skills are explicitly out of this build.

Library includes static snapshots AND hosted live dashboards in this build. Public bearer URL, private whole-org access, or private specified org users. Revoking a share stops further access; previous copies/history not erased. Generated code is isolated from core application and provider/control-plane secrets. Static output versions retained. Live applications may use scoped source data without granting viewers access to all source files.

All inference centrally administered per organization. No employee connection setup. OpenAI/Claude/Grok subscriptions plus OpenAI/Anthropic/OpenRouter/xAI/custom compatible API keys. No consumer/business account discrimination. Multiple accounts, usage/availability/model choice and refresh centrally. Claude subscription warning: third-party proxy use may result in account restriction/suspension/termination; continued access not guaranteed. CLIProxyAPI pinned private service(s); credentials isolated per organization. Native harness defaults: Codex for OpenAI, Claude for Anthropic, Grok Build for xAI where compatible; embedded Pi alternative, including OpenRouter/custom models. Native provider compatibility must be proven and unsupported cases must be explicit, never fake responses.

## Stack and structure

React/TypeScript/Vite frontend. Node24+/TypeScript/Fastify backend. SQLite only, worker-owned connections and short transactions, WAL, durable jobs and conversation records. Core database outside agent writable mounts. Python supplies the bundled specialist document tools; native infrastructure binaries retain their own implementation languages. Core modules share a small typed context; no mandatory third-party framework for domain logic. Core API, runtime supervisor, generated-app runtimes and per-org inference gateways are separate security/process boundaries.

## Acceptance

Real UI workflows for owner/org-admin/employee, invitations, project creation and access updates; isolation between organizations and projects; file operations and sharing/revocation; private/shared conversation visibility and serialized durable runs with cancel/reconnect/restart; native adapters with deterministic protocol tests and separately identified live-provider acceptance; central account/model/usage admin with secrets redacted; static/public/private and live library viewing/revocation; durable provisioning/recovery; backup/restore; desktop/mobile browser validation. No placeholder success, canned assistant response, silently missing primary action, unsafe retry of unknown model side effects, or untested claim of production readiness.
