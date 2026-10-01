# Contributing

Thank you for helping improve WovenMatter Enterprise.

## Before opening a change

- Search existing issues and keep each change focused.
- If you do not have write access, fork the repository and create a short-lived
  branch in your fork. Collaborators should also use a short-lived branch.
- Open pull requests against `main`.
- Do not include credentials, provider transcripts, personal paths, private
  hosts, generated build products, or proprietary assets.

## Local private material

Keep private worktrees in `.worktrees/` or `worktrees/`, and working files,
results, operator data and secrets in the root `workdirs/`, `results/`,
`data/`, `var/`, `secrets/` or `backups/` directories. These directories
are excluded from Git and container build contexts. Environment files and
local database/backup exports must remain private. Only reviewed generic
`*.env.example` and `*.env.*.example` files belong in source control.

## Validation

Use Node.js 24.21.0 and npm 12.2.0. Install dependencies with `npm ci`,
then run `npm run check` for the build and deterministic tests. Run
`npm run test:coverage` when checking coverage, and install Chromium with
`npx playwright install chromium` before `npm run test:e2e` for browser
workflows. See [the development guide](platform/docs/DEVELOPMENT.md).

Container acceptance installs host security policy and belongs on a dedicated
Linux acceptance host or the isolated CI runner. Do not run it against a shared
production host. Describe validation performed and any environment limitations
in your pull request.

Tests must be deterministic, require no provider credentials, and make no real
LLM calls. Dependency updates are reviewed deliberately by maintainers.

## Pull requests

Explain the behavior that changed, list validation performed, and call out
security, privacy, persistence, or third-party provenance impacts.

Every pull request targeting `main` requires approval from the code owner,
`@trey131`. New changes dismiss stale approvals. Approval after the latest
push and resolved review conversations are required. Force pushes and deletion
of `main` are blocked, with no configured bypass actors.

Pull requests receive `vouch:*` contributor-trust and `size:*` change-size labels.
External contributors begin as `vouch:unvouched`. A maintainer can add
`github:username` to `.github/VOUCHED.td` after establishing trust; collaborators
with write access are trusted automatically. Labels do not grant access or
guarantee that a pull request will be merged.

The configuration in `.github/rulesets/protect-main.json` records the live
GitHub ruleset. Editing that file does not update GitHub settings automatically.

By submitting a contribution, you agree that it is licensed under this
project's MIT License.
