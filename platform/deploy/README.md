# WovenMatter Enterprise Platform v2 deployment

These examples describe an opt-in, isolated self-hosted installation with fresh state. They are not preconfigured for an existing host or account. The canonical application Dockerfile is the repository-root `Dockerfile`; its default target is the unprivileged application. `supervisor` is an explicit separate target.

## Boundaries

- Node 24 is supplied by images; the host's Node installation need not change. SQLite is local disk only, never NFS. The API's database connections run in a dedicated worker.
- Run exactly **one API coordinator per SQLite installation**. Atomic SQL claims and global/per-organization limits protect admission; they do not make horizontal API replicas supported. Defaults are `WME_MAX_CONCURRENT_RUNS=8` and `WME_MAX_CONCURRENT_RUNS_PER_ORGANIZATION=4`, counting uncertain stopping executions until cleanup is confirmed. Increase limits only after measuring host/container capacity.
- API UID/GID 10001 owns `state`. Only the supervisor receives Docker authority. It uses a Unix socket plus a random 256-bit bearer secret; no TCP control endpoint is exposed.
- The trusted supervisor uses host networking solely to reach isolated live applications at their private bridge addresses. Its image/root filesystem is read-only. Container source mount paths are identical inside supervisor/API and on the host.
- Every agent execution gets its own internal network. Only that run and the API inference gateway join it; generated tools cannot directly reach other runs, external networks, or central credential services. Optional public HTTP/S access uses an authenticated internal proxy and an active run credential. Scoped host INPUT rules also reject newly initiated connections from the `br-wmerun*` and `br-wmeapp*` bridges to host services. Native sessions live outside editable project storage.
- Each live application gets its own internal network, bounded resources, a read-only source snapshot, optional read-only data mounts, and a persistent `/data` directory under `state/library-data/<assetId>`. Viewers enter through the authenticated library proxy; no application port is published on the host.
- Set `WME_ISOLATED_NETWORK_POOL` to an unused private IPv4 pool after checking host routes and existing Docker subnets. Agents and live applications share an allocator that reserves separate `/28` networks through Docker's atomic overlap check. It never consumes Docker's large default subnet pool or removes another network. The example `10.253.0.0/16` provides 4,096 slots; select a different private pool if it overlaps a host, VPN, or existing container route.
- Each organization gets a separate pinned CLIProxyAPI container and separate credential/config directories. The API sees only endpoint credentials over the supervisor socket. Agents receive per-run application gateway credentials, never these central secrets.
- The inference bridge has host firewall rules blocking private/link-local/host destinations for proxy egress. This matters for custom provider URLs that can change DNS after validation. The API is the sole reserved `.2` address; proxy containers occupy other addresses. IPv6 is disabled. Proxy processes use `restart=no` so they cannot come up before the firewall on reboot. The supervisor checks a current-boot firewall attestation before provisioning/restarting one.

## Candidate setup on a Linux Docker host

Use an isolated checkout and unique immutable image tags. Use a dedicated Linux Docker host. Check available CPU/memory/disk, existing port 4180, subnet 172.31.251.0/24, names `wme-candidate-api`, `wme-inference`, and bridge `br-wmeinference` before proceeding. If any are owned by another deployment, use a separate host or consistently change the network/address configuration and firewall rules.

From the repository root:

```sh
docker build --target application -t wovenmatter-enterprise:CANDIDATE .
docker build --target supervisor -t wovenmatter-enterprise-supervisor:CANDIDATE .
docker build -f platform/runtime/Dockerfile -t wovenmatter-enterprise-runner:CANDIDATE .
docker build -f platform/deploy/Dockerfile.library -t wovenmatter-enterprise-library:CANDIDATE .
docker build -f platform/deploy/Dockerfile.inference -t wovenmatter-enterprise-inference:acdace936fa7df2905500c7f5e0a97d683138dea .
```

The supervisor is built from the same application revision. CLIProxyAPI is fetched at the exact pinned commit, verified before compilation. Record image IDs/digests in the review evidence. The image preserves the upstream license; see the root third-party notices for additional distribution obligations.

Initialize the candidate directories using the image's Node 24 (run once; refuses to replace the secret):

```sh
sudo mkdir -p /srv/wovenmatter-enterprise-candidate
sudo docker run --rm --user 0 --entrypoint node \
  -v /srv/wovenmatter-enterprise-candidate:/srv/wovenmatter-enterprise-candidate \
  wovenmatter-enterprise:CANDIDATE platform/scripts/init-candidate.mjs /srv/wovenmatter-enterprise-candidate
sudo apparmor_parser -r platform/runtime/wme-platform-agent.apparmor
sudo sh platform/scripts/install-inference-firewall.sh /srv/wovenmatter-enterprise-candidate
```

Copy `candidate.env.example` to a private environment file outside Git. Set all image tags, `WME_CANDIDATE_ROOT`, the checked `WME_ISOLATED_NETWORK_POOL`, HTTPS portal origin, and an asset origin template on separate wildcard DNS/TLS. No provider key belongs in this file. Use `nginx.candidate.conf.example` as edge configuration guidance; preserve `Host`, support upgrades/SSE, reject unknown hosts, and never expose port 4100 directly. The asset listener must accept only UUID hosts. The application additionally restricts portal routes on asset origins and issues host-only capability cookies.

```sh
docker compose --env-file /secure/candidate.env -f platform/deploy/compose.yaml config --quiet
docker compose --env-file /secure/candidate.env -f platform/deploy/compose.yaml up -d
```

Migrations apply during API startup. They are transactional and recorded in SQLite. There are no default users or passwords. Bootstrap the owner once using stdin, with the password supplied by the operator's password manager/interactive terminal and never a shell argument or Docker environment value:

```sh
docker compose --env-file /secure/candidate.env -f platform/deploy/compose.yaml run --rm --no-deps -T \
  -e WME_OWNER_EMAIL=owner@example.com -e WME_OWNER_NAME='Platform Owner' \
  api node platform/dist/apps/api/src/cli.js bootstrap-owner --password-stdin
```

For invitation delivery, add `WME_SMTP_HOST`, `WME_SMTP_PORT`, `WME_SMTP_FROM`, optional `WME_SMTP_USER`, and `WME_SMTP_PASSWORD_FILE` to the API service through a private Compose override; bind the password file read-only. Without mail configuration invitation delivery remains explicitly unavailable; no success is fabricated. Configure the operator's email service deliberately, then verify against a test SMTP sink before any real recipients.

## Restart, rollback, and verification

### Optional public agent HTTP/S access

`WME_EGRESS_ENABLED` defaults to `false`. Enabling it starts a separate API listener on internal port 4101; Compose never publishes this port and the edge must never route to it. Every connection requires an active project/run credential. Only public HTTP/S ports 80 and 443 are supported (CONNECT on port 80 also supports Node's native proxy client); destination DNS is pinned before dialing, private/special address ranges are denied, and revocation terminates active connections. Agents retain internal per-run networks, so bypassing the proxy does not grant public connectivity. Scoped API firewall rules additionally reject new host connections and private forwarding destinations while preserving the dedicated central inference subnet.

The API obtains fresh host-boundary metadata from the authenticated supervisor socket. It includes host interface addresses, `os.hostname()`, `WME_EGRESS_DENIED_IPS` (additional public NAT addresses), and `WME_EGRESS_DENIED_HOSTS` (names and their subdomains). Set `WME_EGRESS_INGRESS_HOSTS` to **every additional public hostname routed back to this server**, including management, reverse-proxy, CDN, or tunnel ingress. Public portal and wildcard asset origins are inferred automatically. The wildcard asset check resolves a synthetic UUID child because wildcard DNS need not define its parent apex. Reserved candidate `.test` / `.localhost` names remain denied without requiring public DNS.

Public ingress DNS addresses are also excluded, with a five-second bounded cache and fail-closed refresh. This blocks alternate destination names resolving to a server/ingress address. Shared CDN addresses may consequently block unrelated sites sharing those IPs; declare the complete boundary and accept that tradeoff rather than permitting a route back to hosted services. Dynamic host interfaces refresh on each metadata read. Configuration changes require restart. Public internet access cannot prevent access to an arbitrary external relay service; this boundary controls direct host/private/container destinations and declared ingress, without TLS interception.

### Recovery checks

Reapply the scoped inference firewall after every host boot before opening provider connections. A systemd oneshot ordered after Docker/before this Compose stack is appropriate; preserve other firewall policy. Never flush the host firewall. Supervisor startup stops uncertain native executions before reporting recovered runs; no uncertain provider request is replayed. SQLite jobs and conversations recover from durable state.

Before review, run `npm run check`, runtime `check-container.sh`, and real Linux container checks: non-root user/capabilities/mounts, per-run network isolation, read-only file enforcement, cancellation/restart, invalid-host rejection, all three library access modes, live dashboard HTTP/WebSocket traffic/revocation, isolated `/data` persistence across new versions, first-connect proxy provisioning without any provider authentication, and backup restore below. Provider-paid/live authentication tests are separate acceptance gates and require user-operated sign-in. Do not claim those from protocol mocks.

Rollback changes image tags to the previous reviewed candidate and preserves volumes. Take a verified backup before migrations; if a schema migration is not backward-compatible, restore the matching backup rather than booting an older binary against the newer database. Never delete candidate volumes to make rollback appear successful. Production cutover is a separate explicit operation.

## Backup and restore

For an online **database-only** snapshot use SQLite's online backup API, which captures committed WAL contents:

```sh
node platform/scripts/sqlite-backup.mjs backup /state/control/platform.sqlite /backup/platform-TIMESTAMP.sqlite
node platform/scripts/sqlite-backup.mjs check /backup/platform-TIMESTAMP.sqlite
```

Run through the Node 24 image if the host has an older Node. The destination must be new; backups are mode 0600 and validated by integrity/foreign-key checks. Never copy only a live `.sqlite` file, ignoring WAL.

A **full recoverable snapshot** must include `state/` (workspaces, original/version blobs, library source, SQLite, native sessions), `private/` (provider credentials/config, supervisor credential, dispatch journals), including `state/library-data/<assetId>` for every live dashboard. These contain customer data and account credentials: encrypt backups at rest and store them off-host with access controls. Keep multiple generations and a measured restore drill.

Quiesce first: stop accepting requests, stop API and supervisor, stop candidate agent containers, live apps, and organization proxy containers. Confirm none remain running. Then snapshot the candidate directory together; preserving only SQLite is insufficient. For restoration, keep candidate services stopped, restore into a **new** candidate root preserve numeric ownership (including UID 65532 for live application data), and let the supervisor recreate its path-derived `wme-storage-*` mount volumes from the new root, validate the database, set matching configuration paths, and start the reviewed images. Do not restore over a running database or start both source and restored instances against the same storage. Test a restored conversation, file version, private share, and dashboard data. Restoring provider credentials does not guarantee the provider has kept the session valid.

The full offline snapshot tool is `platform/scripts/candidate-snapshot.mjs backup CANDIDATE_ROOT NEW_SNAPSHOT_DIRECTORY`; restore uses `restore SNAPSHOT_DIRECTORY NEW_CANDIDATE_ROOT`. Run with Node 24 and Docker CLI on the host, or the supervisor image with the Docker socket and explicit source/destination mounts. It rejects running services, hashes the archive, validates SQLite, preserves numeric owners, and refuses an existing destination. It does not stop services for you. Old stopped organization proxy containers must be explicitly removed before a restored deployment starts with a new root; provisioning rejects a container whose credential mounts belong to the old root.

For the snapshot tool's container mounts, keep the quiesced source directory writable: SQLite opens the database read-only but can still need to create WAL shared-memory metadata beside it. A read-only bind mount can reject that integrity check. The tool never opens the source database for application writes.

Live dashboards require republishing their restored source revision after a restore: container identities and pinned source device/inode values belong to the original host files. Automatic replay/relaunch of old container receipts is not attempted. Verify that the republished dashboard reads the restored `state/library-data/<assetId>` contents, including any SQLite database it owns; do not replace that directory with an empty volume. Native interrupted agent turns similarly require an explicit new user request, preserving the original conversation and receipt.
