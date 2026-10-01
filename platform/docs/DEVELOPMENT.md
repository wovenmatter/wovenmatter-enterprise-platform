# Development and validation

Use Node 24.21.0, npm 12.2.0 and the root npm lockfile.
Run commands from the repository root:

```sh
npm ci
npm run check
npm run test:coverage
npm run test:e2e
```

`check` builds the API/runtime and browser, then runs the Node suite once.
The server build removes `platform/dist` first so deleted or moved code/tests
cannot survive in generated output. Both TypeScript configurations reject unused
locals and parameters. `test` and `test:coverage` rebuild the server themselves;
build the browser before running E2E independently.

## Tests and coverage

- `platform/tests`: API/domain integration tests and pure browser state helpers.
- `platform/packages/runtime/test`: protocol, mount, network and execution tests.
- `platform/runtime/fixture-cleanup.test.mjs`: cleanup ownership boundaries.
- `platform/e2e`: real API/SQLite/browser workflows using disposable synthetic
  accounts and pre-established sessions. It never operates user sign-in UI.

`test:coverage` prints Node's line, branch and function coverage and writes
`coverage/lcov.info`. It includes executed application, runtime, deployment,
fixture-cleanup and SQLite-backup modules, excluding test fixtures and dependencies.
Node reports loaded modules only: this is not whole-repository or React component
coverage. Keep the same runtime, platform and include patterns for comparisons.
Browser workflows and Linux native/container acceptance are separate evidence.

On macOS some Linux filesystem/socket regressions skip. Use Linux for release
validation. E2E uses localhost:4155 by default and installed Chrome on macOS or
Playwright Chromium on Linux; CI installs Chromium. Set `WME_E2E_PORT` to an unused test port when needed. The suite always starts
its own fixture server and refuses to reuse an existing listener. Screenshots/traces remain
in ignored `test-results/` on failure.

## Local application

`npm run build && npm start` serves the browser and API together at the configured
portal origin (default localhost:4100). Set `WME_STATE_DIR` to a disposable state
directory. Bootstrap an owner through the stdin/file workflow in the deployment
README; there are no default credentials. Without a supervisor, ordinary account,
file and static-library workflows work while agent execution reports unavailable.

For separate Vite/API development, see the [frontend guide](frontend/README.md).
Never point test fixtures or a second coordinator at a running installation's state.

## Dependencies and acceptance

Root and runner-toolkit npm dependencies use committed lockfiles; Python document
readers use `runtime/document-requirements.txt`. Review advisories for those exact
versions when updating pins. Run `npm audit --audit-level=high` at the root and in
`platform/runtime/toolkit`. Pin changes need native protocol/document/build checks
on Linux as well as application checks.

GitHub CI runs application, browser and container-boundary jobs. The container
script installs an AppArmor profile and builds images: use a dedicated acceptance
host or hosted CI, not an unreviewed invocation on a shared production host.
Synthetic protocol checks do not prove live-provider entitlement, real SMTP
receipt, public DNS/TLS, production migration or a full restore. Those remain
explicit acceptance gates in the [deployment guide](../deploy/README.md).
