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
its own fixture server and refuses to reuse an existing listener. Screenshots and request/console evidence remain
under `WME_E2E_OUTPUT` (default `/tmp/wme-e2e-evidence`).

## Local application

`npm run build && npm start` serves the browser and API together under `/enterprise` at the configured
portal origin (default localhost:4100). Set `WME_STATE_DIR` to a disposable state
directory. Bootstrap an owner through the stdin/file workflow in the deployment
README; there are no default credentials. Without a supervisor, ordinary account,
file and asset draft/publication workflows work while agent preparation reports unavailable.

For separate Vite/API development, see the [frontend guide](frontend/README.md).
Never point test fixtures or a second coordinator at a running installation's state.

## Dependencies and acceptance

Root npm dependencies use the committed lockfile; Python document
readers use `runtime/document-requirements.txt`. Review advisories for those exact
versions when updating pins. Run `npm audit --audit-level=high` at the root. Pin changes need native protocol/document/build checks
on Linux as well as application checks.

GitHub CI runs application, browser and container-boundary jobs. The container
script verifies reviewed preinstalled AppArmor profiles and builds images: use a dedicated acceptance
host or hosted CI, not an unreviewed invocation on a shared production host.
Synthetic protocol checks do not prove live-provider entitlement, real SMTP
receipt, public DNS/TLS, production migration or a full restore. Those remain
explicit acceptance gates in the [deployment guide](../deploy/README.md).

## Native asset browser acceptance

After building an exact candidate runtime image and satisfying the documented
Linux/AppArmor prerequisites, the same rendered asset tests can use installed
Codex, Claude, Grok and Pi SDK against a deterministic local provider fixture:

```sh
WME_E2E_AGENT_IMAGE=local-agent-acceptance:checked \
WME_E2E_OUTPUT=/tmp/wme-asset-acceptance \
WME_E2E_PORT=4156 \
node platform/e2e/native-acceptance.mjs --grep 'asset conversation reconnects|Claude Grok and Pi|organization assets start'
```

Use a fresh evidence directory and an unused private subnet pool
(`WME_E2E_NETWORK_POOL`, default `10.253.241.0/24`). The fixture uses real runtime
containers and the production scoped draft operation. It never starts provider
login or calls a real inference service. The runner checks recorded allocation
labels and bind roots before cleanup, including idle assets whose containers are
already gone. A root-run fixture explicitly creates UID10001 workspace leaves
to match production's API UID. No host policies or firewall rules are installed.

Playwright tracing is disabled because its snapshot scripts generate blocked
script errors inside the deliberately script-free preview iframe. Console and
page-error assertions stay enabled, alongside checks of actual preview content,
no executable elements, desktop/mobile interactions and screenshots. Synthetic
transport/unit tests do not establish kernel isolation; run the public container
acceptance separately on the exact runtime image. Actual provider entitlement and
inference acceptance remain a human-owned check.
