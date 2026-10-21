# Security maintenance — October 21, 2026

The [Node.js October security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
requires Node 24.22.1 on the supported 24.x line. Updating npm packages alone
does not patch the runtime. All application, supervisor, project-runner and
build image stages now select that release by immutable image digest; CI and
the documented developer toolchain use the same version.

This maintenance also refreshes all direct npm dependencies to current stable
releases, retaining Node 24-compatible type definitions. The resolved lockfile
updates transitive packages within those upstream contracts. Principal changes
include Fastify 5.12.7, Nodemailer 10.1.7, React 19.3.1, Vite 8.3.5,
Pi 1.3.0, Claude Agent SDK 0.3.306 and Playwright 1.64.1. The lockfile and
[third-party inventory](../../third-party/npm-inventory.tsv) contain the complete
versions and declared licenses.

Document tools update pypdf to 6.21.2, lxml to 6.1.3 and typing-extensions to
4.16.0. The image now checks the pinned Python dependency closure with
`pip check`. Debian packages receive available updates when images are built.
The supervisor's Docker CLI is 29.9.2. The inference service advances to
CLIProxyAPI v8.0.38 at `0db19025571684b198a2ef508f99b41c717337e8`, built with
Go 1.27.3. The upstream graph still had ten reachable Go advisories; the
checked-in Go module overlay updates Git, SSH, HTTP/2, text and compression
dependencies with their required closure. CI builds the patched service,
tests storage/network compatibility and synthetic provider transports, and
runs govulncheck v1.9.0.
GitHub Actions use current reviewed release commits.

Bounded compatibility adaptations preserve existing behavior: the Pi
adapter supplies Durable 1.3's tool-output field and model-task discriminator;
the inference adapter reserves an exclusive private credential file containing
an empty JSON object, as required by the new upstream Codex merge-on-save
implementation. It retains exclusive creation, 0600 permissions, bounded
transport, durable completion and the existing authorization boundaries. The
Go storage adapter recognizes the updated dependency's precise missing-pack
error while preserving fail-closed recovery and unrelated I/O failures.

## Review and deployment

This source update does not deploy itself. CODEOWNERS approval and the hosted
checks remain required before merge. A deployment must separately verify the
actual Node version and image identity of the API, supervisor and every project
runner. Tailnet-only access limits public exposure but does not remove risks
from authenticated requests, uploaded documents, stored credentials or the
supervisor's Docker authority.

The lockfile and embedded runtime determine the bundled SDK generation ID.
Before replacing images, retain a verified backup and every approved generation
still selected by an existing conversation, including its complete locked
dependency closure. Publish and verify the new generation with the
[SDK catalog workflow](PI_DURABLE_PORT.md#maintaining-and-adopting-sdk-updates).
Keep API, supervisor and runner generations consistent. Existing conversations
adopt a reviewed generation explicitly while idle; retain prior generations for
rollback. Do not silently replace the code behind an existing generation ID.

Required validation includes the Linux build/tests, browser workflows, kernel
and container isolation acceptance, all deployment image builds, npm audit,
Python release advisories and Go vulnerability analysis. These checks use
synthetic provider fixtures; they do not establish live-provider or subscription
acceptance. A clean advisory scan is a point-in-time result, not proof that a
dependency has no undisclosed flaws.
