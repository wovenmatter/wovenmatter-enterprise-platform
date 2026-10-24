# Dependency security maintenance

The October 24, 2026 refresh keeps Node 26.12.1, npm 12.2.0 and the proven
agent/protocol versions. It updates only reported vulnerable packages and the
`qs` minimum required by body-parser 2.4.0. Both installed fast-uri major lines
remain on their compatible patched releases.

Two root overrides are qualified by the exact upstream parent version:

- Pi coding-agent 1.1.0 pins Undici 8.10.2; use 8.12.2 for
  [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c),
  [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) and
  [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472).
  The inspected upstream 1.2.0, 1.3.0 and 1.4.0 releases retain the vulnerable
  pin, so upgrading the agent does not resolve it.
- Claude ACP 0.81.2 pins Zod 4.6.5; use 4.6.6 for
  [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
  Zod validates structured data at runtime, including Claude's usage response.
  Updating the adapter to 0.95.0 would also change its protocol SDK and Claude SDK.

Remove each override when a separately validated upstream agent release uses a
patched dependency. Do not accept npm audit's suggested Pi downgrade or make an
unrelated protocol upgrade merely to remove an override.

## Pi's bundled dependencies

The npm Pi 1.1.0 archive also contains a prebuilt CLI/RPC bundle with an embedded
Undici copy. Lockfile overrides cannot change that copy. Enterprise's embedded
agent already uses the published unbundled `dist/index.js`, but shell tools can
invoke `.bin/pi`. During server builds and runner dependency installation,
`platform/tools/prepare-pi-package.mjs` replaces only `dist/bundle` with forwarding
entrypoints to the same archive's published unbundled CLI, RPC and SDK modules.
This removes the stale bundled code while preserving package bin/export paths,
upstream implementation and notices. No provider, authorization or agent policy
is changed. The preparation is guarded to Pi 1.1.0 and must be reviewed on upgrade.
Run `npm run build:server` after a fresh install before invoking those CLI paths.

The native packaging test exercises CLI/RPC startup, SDK exports and dependency
resolution. Native container acceptance exercises the configured agent protocols
with synthetic transports. Audit findings identify package versions; they do not
prove exploitability in this application, and these checks make no such claim.
