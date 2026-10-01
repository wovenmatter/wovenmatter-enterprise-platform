# WovenMatter Enterprise Platform

Managed AI workspaces for expert teams. React and TypeScript provide the browser application; Node.js, Fastify and SQLite own accounts, files, conversations, jobs and publishing. Isolated native agents work against each project's current filesystem through centrally managed inference accounts.

## Application

- Organization administrators invite employees, create projects and assign read or write access. The platform owner administers all organizations.
- Organization and project files support uploads, folders, move, copy and version history. Organization files can be shared into projects with read-only or read-write access and revoked later.
- Conversations are private until project members are added. Runs are durable, ordered and cancellable. Native sessions continue across completed turns; uncertain interrupted work is never automatically replayed.
- Administrators manage subscription accounts and provider API keys through private per-organization CLIProxyAPI services. Employees select available models without managing credentials.
- The library publishes static snapshots and isolated live Node.js dashboards, with public, organization or selected-person links. Each published asset has a separate origin.

Ordinary files are usable immediately with the agent's native tools. The application core is TypeScript; the runtime includes Python document-reading tools.

## Develop and test

Use Node.js 24.21.0 and npm 12.2.0.

```sh
npm ci
npm run check
npm run test:coverage
npm run test:e2e
npm start
```

Build before `npm start`. The default local portal is `http://localhost:4100`; use `WME_STATE_DIR` for an explicit state directory. Bootstrap the first owner using the documented stdin/file password workflow in [deployment operations](platform/deploy/README.md). There are no default accounts or credentials. Without a configured supervisor, file/account/library-static workflows work and attempted agent execution reports unavailable.

The [architecture map](platform/docs/ARCHITECTURE.md), [development guide](platform/docs/DEVELOPMENT.md), and [product scope](platform/docs/BUILD-SPEC.md) describe the code boundaries and validation workflow. API modules live in `platform/apps/api`, the frontend in `platform/apps/web`, native adapters in `platform/packages/runtime`, and Linux operations in `platform/deploy` and `platform/scripts`.

## Operate

[Candidate deployment and recovery](platform/deploy/README.md) covers private Linux deployment, scoped network rules, isolated content origins, native runtime images, backups and restore. The application container never receives the Docker socket or upstream inference credentials. Run real container acceptance on Linux with `WME_RUN_CONTAINER_ACCEPTANCE=1 bash platform/runtime/check-container.sh`; use a dedicated Linux acceptance host because this command installs host security policy.

Agent public HTTP/S access is available through the authenticated internal proxy. Enable `WME_EGRESS_ENABLED=true` only after configuring the host/ingress exclusion inventory and installing the deployment firewall rules. Agent containers retain private per-run networks; port 4101 is never published. See [network configuration and acceptance](platform/deploy/README.md#optional-public-agent-https-access).

Secrets, client files, databases, generated runtime state and backups stay outside Git. Examples use loopback or reserved example domains and require deliberate operator configuration before deployment. The baseline uses one organization per ordinary account, containers per agent execution, and separate origins for published applications; see the current behavior and security documentation before self-hosting.

## License

Woven Matter's original code is licensed under [MIT](LICENSE). Dependencies, native tools and container packages keep their own licenses and terms; see [third-party notices](THIRD_PARTY_NOTICES.md). The MIT license does not grant rights to third-party code, provider services or trademarks.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Changes to `main` require a pull request and approval from the code owner,
[@trey131](https://github.com/trey131). Report vulnerabilities privately using
the process in [SECURITY.md](SECURITY.md).
