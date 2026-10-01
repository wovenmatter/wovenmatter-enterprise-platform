import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  chown,
  lstat,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export const CLI_PROXY_REVISION = "acdace936fa7df2905500c7f5e0a97d683138dea";
export const ORGANIZATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface ProxyEndpoint {
  baseUrl: string;
  managementKey: string;
  clientKey: string;
}
export interface ProvisionerOptions {
  root: string;
  image: string;
  network: string;
  docker?: (args: string[]) => Promise<string>;
  /** Production supervisor owns Docker/root; tests deliberately avoid chown. */
  credentialUid?: number;
  /** Tests may inject a deterministic readiness probe; production probes the isolated bridge IP. */
  probe?: (container: string, endpoint: ProxyEndpoint) => Promise<void>;
  firewallAttestation?: string;
}
const execute = promisify(execFile);
export async function docker(args: string[]): Promise<string> {
  try {
    return (
      await execute("docker", args, {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new Error(
      "Container operation failed; inspect host service diagnostics.",
    );
  }
}
export function organizationId(value: string): string {
  if (!ORGANIZATION_ID.test(value))
    throw new Error("Invalid organization identity");
  return value.toLowerCase();
}
export function proxyConfiguration(endpoint: ProxyEndpoint): string {
  // JSON is valid YAML. All strings are encoded, never interpolated into YAML syntax.
  return (
    JSON.stringify(
      {
        "config-version": 8,
        server: {
          host: "0.0.0.0",
          port: 8317,
          "trusted-proxies": [],
          discovery: { enabled: false },
        },
        management: {
          "allow-remote": true,
          "secret-key": endpoint.managementKey,
          "disable-control-panel": true,
          "disable-auto-update-panel": true,
        },
        access: { "api-keys": [endpoint.clientKey] },
        oauth: { "auth-dir": "/credentials" },
        routing: {
          strategy: "round-robin",
          "session-affinity": true,
          retry: { "request-retry": 0 },
        },
        observability: {
          logs: {
            debug: false,
            "logging-to-file": false,
            "request-log": false,
            "error-logs-max-files": 1,
          },
          usage: { "usage-statistics-enabled": true },
          pprof: { enable: false },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/** Privileged host-only component. HTTP callers supply an organization UUID, never paths/images/commands. */
export class OrganizationProxyProvisioner {
  private readonly pending = new Map<string, Promise<ProxyEndpoint>>();
  private readonly ready = new Map<string, number>();
  private readonly run: (args: string[]) => Promise<string>;
  constructor(private readonly options: ProvisionerOptions) {
    this.run = options.docker ?? docker;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(options.network))
      throw new Error("Invalid control network");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]+$/.test(options.image))
      throw new Error("Invalid proxy image");
    if (resolve(options.root) !== options.root || /[,\n\r]/.test(options.root))
      throw new Error("An absolute safe inference root is required");
  }
  async resolve(id: string): Promise<ProxyEndpoint | undefined> {
    id = organizationId(id);
    try {
      const filename = join(this.options.root, id, "endpoint.json");
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
        throw new Error("Insecure inference registry permissions");
      const result = JSON.parse(
        await readFile(filename, "utf8"),
      ) as ProxyEndpoint;
      if (
        result.baseUrl !== `http://wme-inference-${id}:8317` ||
        !/^[0-9a-f]{64}$/.test(result.managementKey) ||
        !/^[0-9a-f]{64}$/.test(result.clientKey) ||
        result.managementKey === result.clientKey
      )
        throw new Error("Invalid inference registry entry");
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async ensure(id: string): Promise<ProxyEndpoint> {
    id = organizationId(id);
    if (Date.now() - (this.ready.get(id) ?? 0) < 10_000) {
      const endpoint = await this.resolve(id);
      if (endpoint) return endpoint;
    }
    let pending = this.pending.get(id);
    if (!pending) {
      pending = this.provision(id).finally(() => this.pending.delete(id));
      this.pending.set(id, pending);
    }
    return pending;
  }
  private async provision(id: string): Promise<ProxyEndpoint> {
    if (this.options.firewallAttestation) {
      const bootId = (
        await readFile("/proc/sys/kernel/random/boot_id", "utf8")
      ).trim();
      const attestation = (
        await readFile(this.options.firewallAttestation, "utf8")
      ).trim();
      if (bootId !== attestation)
        throw new Error(
          "Inference egress firewall must be installed for this host boot",
        );
    }
    const root = join(this.options.root, id);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error("Invalid inference registry directory");
    await chmod(root, 0o700);
    let endpoint = await this.resolve(id);
    if (!endpoint) {
      endpoint = {
        baseUrl: `http://wme-inference-${id}:8317`,
        managementKey: randomBytes(32).toString("hex"),
        clientKey: randomBytes(32).toString("hex"),
      };
      await writeFile(
        join(root, "endpoint.json.tmp"),
        JSON.stringify(endpoint),
        { mode: 0o600 },
      );
      await rename(
        join(root, "endpoint.json.tmp"),
        join(root, "endpoint.json"),
      );
    }
    const config = join(root, "config"),
      credentials = join(root, "credentials");
    await mkdir(config, { mode: 0o700, recursive: true });
    await mkdir(credentials, { mode: 0o700, recursive: true });
    // CLIProxyAPI persists administrator edits and hashes the management key in place.
    // Never replace an existing config with bootstrap defaults on restart.
    try {
      await writeFile(
        join(config, "config.yaml"),
        proxyConfiguration(endpoint),
        { mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (this.options.credentialUid !== undefined) {
      for (const path of [config, credentials, join(config, "config.yaml")])
        await chown(
          path,
          this.options.credentialUid,
          this.options.credentialUid,
        );
    }
    const name = `wme-inference-${id}`;
    const existing = await this.run([
      "ps",
      "-a",
      "--filter",
      `name=^/${name}$`,
      "--format",
      "{{.ID}}",
    ]).then((s) => s.trim());
    if (existing) {
      const label = (
        await this.run([
          "inspect",
          "--format",
          '{{index .Config.Labels "com.wovenmatter.enterprise.organization"}}',
          name,
        ])
      ).trim();
      if (label !== id) throw new Error("Container identity conflict");
      const mounts = JSON.parse(
        await this.run(["inspect", "--format", "{{json .Mounts}}", name]),
      ) as { Source: string; Destination: string }[];
      if (
        !mounts.some(
          (m) => m.Source === config && m.Destination === "/config",
        ) ||
        !mounts.some(
          (m) => m.Source === credentials && m.Destination === "/credentials",
        )
      )
        throw new Error("Container storage does not belong to this deployment");
      await this.run(["start", name]);
    } else {
      await this.run([
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `com.wovenmatter.enterprise.organization=${id}`,
        "--label",
        `com.wovenmatter.enterprise.proxy-revision=${CLI_PROXY_REVISION}`,
        "--restart",
        "no",
        "--read-only",
        "--user",
        "10002:10002",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "128",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--ulimit",
        "nofile=4096:4096",
        "--network",
        this.options.network,
        "--log-driver",
        "local",
        "--log-opt",
        "max-size=10m",
        "--log-opt",
        "max-file=3",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
        "--mount",
        `type=bind,src=${config},dst=/config,bind-propagation=rprivate`,
        "--mount",
        `type=bind,src=${credentials},dst=/credentials,bind-propagation=rprivate`,
        this.options.image,
        "--config",
        "/config/config.yaml",
      ]);
    }
    if (this.options.probe) await this.options.probe(name, endpoint);
    else {
      const address = (
        await this.run([
          "inspect",
          "--format",
          `{{(index .NetworkSettings.Networks "${this.options.network}").IPAddress}}`,
          name,
        ])
      ).trim();
      if (
        !/^172\.31\.251\.(?:[3-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(
          address,
        )
      )
        throw new Error("Inference container has an invalid network address");
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const response = await fetch(`http://${address}:8317/v1/models`, {
            headers: { authorization: `Bearer ${endpoint.clientKey}` },
            redirect: "error",
            signal: AbortSignal.timeout(1000),
          });
          await response.body?.cancel();
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* Initial start may not yet listen. Never log keys or upstream bodies. */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) throw new Error("Inference service did not become ready");
    }
    this.ready.set(id, Date.now());
    return endpoint;
  }
}
