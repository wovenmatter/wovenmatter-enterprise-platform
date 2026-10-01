# Deployment and recovery

Examples describe a fresh self-hosted installation. They do not import another application's accounts or data. Use immutable image revisions, a private configuration directory and an explicitly authorized Linux host. Actual owner email, provider sign-in, DNS/edge changes and production provisioning belong to the operator.

Build the application, supervisor, persistent runtime and pinned inference images from the repository root:

```sh
docker build -t wovenmatter-enterprise:REVISION .
docker build --target supervisor -t wovenmatter-enterprise-supervisor:REVISION .
docker build -f platform/runtime/Dockerfile -t wovenmatter-enterprise-runner:REVISION .
docker build -f platform/deploy/Dockerfile.inference -t wovenmatter-enterprise-inference:REVISION .
```

The API runs as UID10001 and never receives the Docker socket. The trusted host supervisor controls only configured storage roots, project allocations and organization inference services. Persistent project containers contain a trusted namespace launcher; untrusted native tools run as UID10001 with mandatory independent kernel boundaries. See [runtime security](../runtime/README.md).

Use `node platform/scripts/init-candidate.mjs NEW_CANDIDATE_ROOT` once to create private layout and a random supervisor credential. Supply reviewed images, origin and private paths in a copy of `candidate.env.example` outside Git. Check ports, host routes, existing container/network names and the configured private network pool before provisioning. Do not use an existing deployment's data or services as fixtures. No default credentials exist. Bootstrap the first owner with `platform/dist/apps/api/src/cli.js bootstrap-owner`, `WME_OWNER_EMAIL`, `WME_OWNER_NAME`, `WME_STATE_DIR` and `--password-stdin` (or `WME_BOOTSTRAP_PASSWORD_FILE`); never put the password in command arguments.

Load the reviewed `wme-project-supervisor` and `wme-platform-agent` AppArmor profiles on the authorized host before starting project containers. Supervisor-only netlink/net_admin permission constructs isolated loopback interfaces; tools retain zero capabilities. Never replace an unrelated host profile. Provision the existing scoped inference firewall using `install-inference-firewall.sh` only on an explicitly authorized deployment lane. Its boot-specific attestation is required before inference service provisioning; never flush unrelated rules. Project tools have private network namespaces plus scoped relays even when public egress is enabled.

The inference bridge uses an operator-selected canonical RFC1918 IPv4 `/24`: set `WME_INFERENCE_SUBNET`, `WME_INFERENCE_API_ADDRESS` (that subnet's `.2`), `WME_INFERENCE_NETWORK` and `WME_INFERENCE_BRIDGE` together. Reserve `.1` for the bridge; organization proxies use `.3` through `.254`. The default firewall script is specifically for `172.31.251.0/24` and `br-wmeinference`. A different subnet/bridge requires a separately reviewed, deployment-scoped policy with matching API exception and host/private destination denials before writing the boot attestation. Do not run the default script unchanged against a different allocation or reuse another deployment's network.

The app, API, authentication routes, static build assets and reports live under `/enterprise`. `WME_PUBLIC_ORIGIN` is the origin only, without a path. The edge must preserve `/enterprise` and Host; see `nginx.candidate.conf.example`. Other site routes are configured separately. Secure sessions use `__Host-wme_session; Secure; Path=/` without Domain, preserving host-cookie protection; development cookies use Path=/enterprise. Provider OAuth callbacks remain provider-defined remote/headless callbacks pasted into the authenticated organization connection UI; the application callback API is under `/enterprise/api`. Never expose management or runtime ports to browsers.

## Host placement

The initial host ID is `local`; organization defaults and new-project overrides are owner-only. The assigned host is persisted on every project, and changing an organization default affects only new projects. A stored project cannot be moved implicitly.

The default transport is a private Unix socket and random256-bit token. `WME_HOSTS_FILE` can supply a private JSON array of `{id,name,socketPath?,origin?,tokenFile,caFile?,certFile?,keyFile?,apiStateRoot,supervisorStateRoot,storageMode?}`. Remote entries require an HTTPS origin, pinned CA, client certificate/key, a per-host token and `storageMode:"shared"`. These files never enter browser responses; users see only ID/name labels. All entries must use the same apiStateRoot equal to WME_STATE_DIR. Independent API storage trees are rejected. Each supervisor must explicitly mount that same shared tree at its declared supervisorStateRoot; this supports a single coherent organization library and file/version/recovery paths. Before readiness, provisioning, restoration and dispatch, a random API-written storage probe must be visible to that supervisor. A missing/mismatched mount fails closed. Runtime paths are translated only within the selected root.

A TLS supervisor uses `WME_HOST_ID`, `WME_SUPERVISOR_TLS_HOST`, `WME_SUPERVISOR_TLS_PORT`, `WME_SUPERVISOR_TLS_CA_FILE`, `WME_SUPERVISOR_TLS_CERT_FILE`, `WME_SUPERVISOR_TLS_KEY_FILE` instead of `WME_SUPERVISOR_SOCKET`. It requires a client certificate and the correct host token/header. Use an operator-managed private network and unique credentials. Loopback two-supervisor tests prove wire authentication and storage validation, not physical remote-host deployment. No host purchasing, wake-up, filesystem replication or relocation service is provided.

## Optional public HTTP/S

Set `WME_EGRESS_ENABLED=true` only after defining the trusted host/ingress exclusion inventory. Port4101 stays private. The supervisor reports current interfaces, configured public origin and `WME_EGRESS_DENIED_IPS`, `WME_EGRESS_DENIED_HOSTS`, `WME_EGRESS_INGRESS_HOSTS`. DNS resolution is pinned and all answers must be public and outside that inventory. Private/link-local/metadata destinations, host services, container networks and direct connections are denied. Bounded connections, bytes, timeouts and periodic authorization checks also apply to CONNECT tunnels.

Native sessions use run credentials. Unattended scripts use separate project network capabilities checked against current project status and host; these cannot call inference. Neither is an upstream provider credential. A network capability can fetch public data but cannot guarantee a website's availability or prevent a user from intentionally using a public relay.

## Trash and recovery

Deletion blocks project access immediately and requests runtime stop before returning success. Files, native history and schedule definitions remain for30 days. Admins use Organization settings → Deleted projects to restore or recover ordinary files into the organization library. Recovery excludes live share mountpoints and rejects symlinks/devices. Expired projects are purged with no-follow filesystem operations after runtime removal. Resource cleanup verifies allocation labels and tolerates resources already removed by a previous attempt.

Runtime restart stops uncertain thread processes before releasing their leases and restarts retained project containers. Durable native history can continue with a new explicit message; uncertain input is not replayed. Operator maintenance and image replacement must preserve workspace/session/journal volumes and reconcile allocations. Do not start old code against a newer incompatible database or delete volumes to force rollback.

## Encrypted backup

`platform/scripts/backup.mjs` implements encrypted full backup and authenticated restore. No destination is selected or provisioned. Supply a private JSON configuration with `database`, named `roots` covering that database and ALL durable state on every configured host, a0600 `keyFile` containing32 random bytes as hex, `stagingDirectory`, and absolute executable/argument arrays `quiesce`, `resume`, `transport`.

The quiesce/resume hooks are operator-controlled and must coordinate every writer, including the API, project processes and inference services. Resume runs even if quiescing only partially succeeds. Include SQLite, workspaces, file-version blobs, native/tool state, schedule receipts, runtime allocation journals and private inference credentials. Unix sockets are ephemeral and excluded; devices/FIFOs fail closed. Symlinks are archived as metadata without reading targets and restored only after all ordinary files. Numeric ownership and modes are retained; control journals must not become agent-owned.

```sh
node platform/scripts/backup.mjs backup /secure/backup.json daily
node platform/scripts/backup.mjs backup /secure/backup.json pre-update
node platform/scripts/backup.mjs restore ARCHIVE /secure/backup.key NEW_DIRECTORY
```

The transport receives `put LOCAL_ENCRYPTED_ARCHIVE NAME`, then `prune ISO_30_DAY_CUTOFF`; it must provide verified off-host storage and enforce retention. The example timer runs daily only after the operator supplies a transport. The utility encrypts with AES256-GCM, includes a SQLite online snapshot of committed WAL content, propagates stream errors and removes local staging. Restore authenticates the entire archive before creating output, refuses an existing destination and validates restored SQLite integrity. Keep keys separate from archives. Restore into an isolated new root, review matching configuration/host mappings and remove stale host-boot attestation/socket references before starting reviewed services. Test actual UID10001 access, file versions, native continuation, reports, schedules and provider credential usability before cutover. Backup success is not evidence that a restore drill has passed.

Run application, browser, mTLS, backup and real container acceptance on disposable data before release. Real provider/SMTP and separately located host acceptance require separate authorization. Publishing a review PR does not authorize deployment.

## Updating persistent runtimes

Use an immutable versioned image reference. Existing projects reject a different configured image instead of silently claiming the new runtime is active. In an explicitly authorized maintenance window, stop new admissions, quiesce active work and create the encrypted `pre-update` backup. Record and verify each project's allocation labels and exact container ID, then recreate only those stopped project containers with the new image, preserving their placement journals, storage volumes, native sessions and schedule receipts. Resume through the supervisor and run the isolated acceptance checks before reopening admissions. Never delete persistent volumes or change the stored host to perform an image update. Rollback uses the recorded image and authenticated backup where needed.
