import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { resolve, relative, isAbsolute } from "node:path";
import { lstat, realpath, mkdir, chown, chmod } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { isIP } from "node:net";
import {
  ensureStorageVolumes,
  storageVolumeName,
  volumeMount,
} from "../../../../packages/runtime/src/volumes.js";
import { pinMountSources } from "../../../../packages/runtime/src/mount-evidence.js";
import {
  createIsolatedNetwork,
  validateNetworkPool,
} from "../../../../packages/runtime/src/networks.js";

export interface LibraryMount {
  source: string;
  target: string;
  readOnly: true;
  expectedDevice: string;
  expectedInode: string;
}
export interface LibraryStart {
  assetId: string;
  orgId: string;
  projectId: string | null;
  versionId: string;
  sourceDir: string;
  entrypoint: string;
  publicOrigin: string;
  dataMounts: LibraryMount[];
}
export interface LibraryRuntimeState {
  id: string;
  status: "running" | "stopped" | "failed";
  origin?: string;
  headers?: Record<string, string>;
}
export interface LibraryRuntimeHost {
  start(input: LibraryStart): Promise<LibraryRuntimeState>;
  status(id: string): Promise<LibraryRuntimeState>;
  stop(id: string): Promise<void>;
  resume?(id: string): Promise<LibraryRuntimeState>;
  fetch?(id: string, path: string, init: RequestInit): Promise<Response>;
  upgrade?(
    id: string,
    path: string,
    headers: Record<string, string>,
    socket: Duplex,
    head: Buffer,
  ): Promise<void>;
}
type Exec = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;
const nativeExec: Exec = (file, args) =>
  promisify(execFile)(file, args, {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
export interface DockerLibraryOptions {
  stateDir: string;
  dataRoots: string[];
  image: string;
  docker?: string;
  execute?: Exec;
  memory?: string;
  cpus?: string;
  dataGroup?: number;
  /** Explicit operator-reserved RFC1918 pool; existing receipts do not depend on it. */
  networkPool?: string;
}
const idRx = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Instantiate only in the trusted supervisor; the API never receives the Docker socket. */
export class DockerLibraryRuntime implements LibraryRuntimeHost {
  private exec: Exec;
  constructor(private options: DockerLibraryOptions) {
    this.exec = options.execute ?? nativeExec;
  }
  private async docker(args: string[]) {
    return this.exec(this.options.docker ?? "docker", args);
  }
  private name(id: string) {
    if (!idRx.test(id)) throw new Error("Invalid runtime identity");
    return `wme-asset-${id}`;
  }
  private async boundedPath(path: string, roots: string[]) {
    const canonical = await realpath(path);
    const candidate = await lstat(path);
    if (
      candidate.isSymbolicLink() ||
      !roots.some((root) => {
        const p = relative(resolve(root), canonical);
        return p === "" || (!p.startsWith("..") && !isAbsolute(p));
      })
    )
      throw new Error("Runtime mount lies outside allowed storage");
    return canonical;
  }
  async start(input: LibraryStart): Promise<LibraryRuntimeState> {
    if (!this.options.networkPool)
      throw new Error("An explicit library network pool must be configured");
    const pool = validateNetworkPool(this.options.networkPool);
    if (
      !idRx.test(input.assetId) ||
      !idRx.test(input.orgId) ||
      !idRx.test(input.versionId)
    )
      throw new Error("Invalid asset identity");
    if (
      !/^[A-Za-z0-9_./ -]+\.(?:mjs|cjs|js)$/.test(input.entrypoint) ||
      input.entrypoint.startsWith("/") ||
      input.entrypoint
        .split("/")
        .some((x) => !x || x === ".." || x === "." || x.startsWith("."))
    )
      throw new Error("Invalid entrypoint");
    const source = await this.boundedPath(input.sourceDir, [
      resolve(this.options.stateDir, "library"),
    ]);
    const dataSources: { source: string; target: string }[] = [];
    for (const m of input.dataMounts) {
      if (!m.readOnly || !/^\/sources\/[a-zA-Z0-9_-]+$/.test(m.target))
        throw new Error("Invalid data mount");
      const src = await this.boundedPath(m.source, this.options.dataRoots);
      dataSources.push({ source: src, target: m.target });
    }
    const id = input.versionId,
      name = this.name(id),
      network = `${name}-net`;
    const data = resolve(this.options.stateDir, "library-data", input.assetId);
    await mkdir(data, { recursive: true, mode: 0o700 });
    if ((await lstat(data)).isSymbolicLink())
      throw new Error("Invalid asset data path");
    await chown(data, 65532, 65532);
    await chmod(data, 0o700);
    const roots = [
      resolve(this.options.stateDir, "library"),
      resolve(this.options.stateDir, "library-data"),
      ...this.options.dataRoots,
    ];
    const pinned = await pinMountSources(
      [
        { source, target: "/app" },
        { source: data, target: "/data" },
        ...dataSources,
      ],
      roots,
    );
    const attemptId = randomUUID();
    let networkAttempted = false;
    try {
      for (const mount of input.dataMounts) {
        const evidence = pinned.evidence.find((e) => e.target === mount.target);
        if (
          !evidence ||
          evidence.device !== mount.expectedDevice ||
          evidence.inode !== mount.expectedInode
        )
          throw new Error("Linked data changed before launch");
      }
      await ensureStorageVolumes(roots, (args) => this.docker(args));
      networkAttempted = true;
      await createIsolatedNetwork(
        {
          name: network,
          pool,
          bridgeName: `br-wmeapp${id.replaceAll("-", "").slice(0, 6)}`,
          labels: {
            "wme.kind": "library",
            "wme.asset": input.assetId,
            "wme.version": id,
            "wme.attempt": attemptId,
          },
        },
        (args) => this.docker(args),
      );
      const mounts = dataSources.flatMap((m) => [
        "--mount",
        volumeMount(m.source, m.target, roots, true),
      ]);
      await this.docker([
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        "wme.kind=library",
        "--label",
        `wme.asset=${input.assetId}`,
        "--label",
        `wme.org=${input.orgId}`,
        "--label",
        `wme.version=${input.versionId}`,
        "--label",
        `wme.attempt=${attemptId}`,
        "--restart",
        "no",
        "--network",
        network,
        "--read-only",
        "--user",
        "65532:65532",
        "--group-add",
        String(this.options.dataGroup ?? 10001),
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        "--memory",
        this.options.memory ?? "512m",
        "--cpus",
        this.options.cpus ?? "1",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--mount",
        volumeMount(data, "/data", roots, false),
        "--mount",
        volumeMount(source, "/app", roots, true),
        ...mounts,
        "--workdir",
        "/app",
        "--env",
        "HOST=0.0.0.0",
        "--env",
        "PORT=8789",
        "--env",
        "NODE_ENV=production",
        "--env",
        `PUBLIC_ORIGIN=${input.publicOrigin}`,
        "--env",
        "DATA_DIRECTORY=/data",
        "--env",
        `WME_LIBRARY_ENTRYPOINT=${input.entrypoint}`,
        "--env",
        `WME_LIBRARY_MOUNTS=${Buffer.from(JSON.stringify(pinned.evidence)).toString("base64")}`,
        this.options.image,
        "node",
        "/opt/wme/library-launcher.mjs",
      ]);
      const state = await this.status(id);
      if (state.status !== "running" || !state.origin)
        throw new Error("Application process did not start");
      // Health means an actual HTTP response, not merely a successfully accepted container start.
      let healthy = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const result = await fetch(state.origin, {
            redirect: "manual",
            signal: AbortSignal.timeout(500),
          });
          await result.body?.cancel();
          healthy = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (!healthy) throw new Error("Application did not become reachable");
      return state;
    } catch (error) {
      // A timed-out create may have succeeded. Inspect the attempt receipt
      // before cleanup, and never remove a colliding resource from another run.
      if (networkAttempted) {
        try {
          await this.removeOwned(id, attemptId);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Library startup failed; cleanup remains pending",
          );
        }
      }
      throw error;
    } finally {
      await pinned.close();
    }
  }
  async status(id: string): Promise<LibraryRuntimeState> {
    try {
      const result = await this.docker(["inspect", this.name(id)]);
      const item = JSON.parse(result.stdout)?.[0];
      if (
        item?.Config?.Labels?.["wme.kind"] !== "library" ||
        item.Config.Labels["wme.version"] !== id ||
        !idRx.test(item.Config.Labels["wme.asset"] ?? "")
      )
        throw new Error("Not a library runtime");
      if (!item.State?.Running)
        return {
          id,
          status:
            item.State?.OOMKilled ||
            item.State?.Error ||
            ![0, 130, 137, 143].includes(Number(item.State?.ExitCode ?? 0))
              ? "failed"
              : "stopped",
        };
      const networkName = `${this.name(id)}-net`;
      const attached = item.NetworkSettings?.Networks ?? {};
      if (Object.keys(attached).length !== 1 || !attached[networkName])
        throw new Error("Application has an unexpected network attachment");
      const network = JSON.parse(
        (await this.docker(["network", "inspect", networkName])).stdout,
      )?.[0];
      if (
        network?.Internal !== true ||
        !ownedNetworkReceipt(network, item, networkName, id)
      )
        throw new Error("Application network is not isolated");
      const ip = attached[networkName].IPAddress;
      if (typeof ip !== "string" || isIP(ip) !== 4 || !isPrivateV4(ip))
        throw new Error("Application has no private network address");
      // Docker internal bridges do not publish ports. Only the trusted host
      // supervisor reaches this address; browsers use its authenticated proxy.
      return { id, status: "running", origin: `http://${ip}:8789/` };
    } catch (error) {
      if (
        error instanceof Error &&
        /No such (object|container)/.test(error.message)
      )
        return { id, status: "stopped" };
      throw error;
    }
  }
  async resume(id: string): Promise<LibraryRuntimeState> {
    const name = this.name(id),
      item = JSON.parse((await this.docker(["inspect", name])).stdout)?.[0];
    if (
      item?.Config?.Labels?.["wme.kind"] !== "library" ||
      item.Config.Labels["wme.version"] !== id ||
      !idRx.test(item.Config.Labels["wme.asset"] ?? "")
    )
      throw new Error("Invalid library runtime identity");
    if (
      item.HostConfig?.RestartPolicy?.Name !== "no" ||
      item.HostConfig?.Privileged ||
      !item.HostConfig?.ReadonlyRootfs ||
      item.Config.User !== "65532:65532"
    )
      throw new Error(
        "Runtime requires republishing with current isolation settings",
      );
    const assetId = item.Config.Labels["wme.asset"],
      mounts = item.HostConfig.Mounts ?? [];
    for (const [target, root, subpath, readonly] of [
      [
        "/app",
        resolve(this.options.stateDir, "library"),
        `${assetId}/${id}`,
        true,
      ],
      ["/data", resolve(this.options.stateDir, "library-data"), assetId, false],
    ] as const) {
      const m = mounts.find((m: any) => m.Target === target);
      if (
        !m ||
        m.Type !== "volume" ||
        m.Source !== storageVolumeName(root) ||
        (m.VolumeOptions?.Subpath ?? m.VolumeOptions?.SubPath) !== subpath ||
        Boolean(m.ReadOnly) !== readonly
      )
        throw new Error(
          "Runtime belongs to a different storage root; republish restored source",
        );
    }
    const attached = item.NetworkSettings?.Networks ?? {},
      networkName = `${name}-net`;
    const network = JSON.parse(
      (await this.docker(["network", "inspect", networkName])).stdout,
    )?.[0];
    if (
      Object.keys(attached).length !== 1 ||
      !attached[networkName] ||
      network?.Internal !== true ||
      !ownedNetworkReceipt(network, item, networkName, id)
    )
      throw new Error("Runtime network is not isolated");
    // Only the trusted supervisor calls this after host firewall verification.
    // The immutable launcher rechecks the original inode evidence on every start.
    if (!item.State?.Running) await this.docker(["start", name]);
    const state = await this.status(id);
    if (state.status !== "running" || !state.origin)
      throw new Error("Application did not resume");
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await fetch(state.origin, {
          redirect: "manual",
          signal: AbortSignal.timeout(500),
        });
        await response.body?.cancel();
        return state;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("Resumed application did not become reachable");
  }
  async stop(id: string) {
    await this.removeOwned(id);
  }
  private async removeOwned(id: string, attemptId?: string) {
    const name = this.name(id),
      networkName = `${name}-net`;
    let item: any;
    try {
      item = JSON.parse((await this.docker(["inspect", name])).stdout)?.[0];
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/No such (object|container)/.test(error.message)
      )
        throw error;
    }
    const labels = item?.Config?.Labels;
    const ownedContainer =
      item &&
      labels?.["wme.kind"] === "library" &&
      labels["wme.version"] === id &&
      idRx.test(labels["wme.asset"] ?? "") &&
      (!attemptId || labels["wme.attempt"] === attemptId) &&
      /^[a-f0-9]{64}$/.test(item.Id ?? "");
    if (item && !ownedContainer && !attemptId)
      throw new Error("Refusing to remove an unowned library container");
    if (ownedContainer) await this.docker(["rm", "--force", item.Id]);
    let network: any;
    try {
      network = JSON.parse(
        (await this.docker(["network", "inspect", networkName])).stdout,
      )?.[0];
    } catch (error) {
      if (
        error instanceof Error &&
        /not found|No such network/.test(error.message)
      )
        return;
      throw error;
    }
    const networkLabels = network?.Labels;
    const ownedNetwork =
      networkLabels?.["wme.kind"] === "library" &&
      idRx.test(networkLabels["wme.asset"] ?? "") &&
      /^[a-f0-9]{64}$/.test(network?.Id ?? "") &&
      (attemptId
        ? networkLabels["wme.version"] === id &&
          networkLabels["wme.attempt"] === attemptId
        : (networkLabels["wme.version"] === id &&
            idRx.test(networkLabels["wme.attempt"] ?? "") &&
            (!ownedContainer ||
              networkLabels["wme.attempt"] === labels["wme.attempt"])) ||
          (!networkLabels["wme.version"] &&
            ownedContainer &&
            network.Id ===
              item.NetworkSettings?.Networks?.[networkName]?.NetworkID)) &&
      (!ownedContainer || networkLabels["wme.asset"] === labels["wme.asset"]);
    if (!ownedNetwork) {
      if (attemptId) return;
      throw new Error("Refusing to remove an unowned library network");
    }
    await this.docker(["network", "rm", network.Id]);
  }
}
function ownedNetworkReceipt(
  network: any,
  item: any,
  name: string,
  id: string,
) {
  const labels = network?.Labels,
    containerLabels = item?.Config?.Labels;
  return (
    labels?.["wme.kind"] === "library" &&
    labels["wme.asset"] === containerLabels?.["wme.asset"] &&
    /^[a-f0-9]{64}$/.test(network?.Id ?? "") &&
    network.Id === item.NetworkSettings?.Networks?.[name]?.NetworkID &&
    (!labels["wme.version"] ||
      (labels["wme.version"] === id &&
        idRx.test(labels["wme.attempt"] ?? "") &&
        labels["wme.attempt"] === containerLabels["wme.attempt"]))
  );
}
function isPrivateV4(ip: string) {
  const octets = ip.split(".").map(Number);
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}
