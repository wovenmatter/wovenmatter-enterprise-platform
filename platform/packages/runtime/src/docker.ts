export { ProjectDockerRuntime as DockerRuntime } from "./project-runtime.js";
export interface DockerRuntimeOptions {
  image: string;
  hostId?: string;
  supervisorAppArmorProfile?: string;
  network: string;
  /** Explicit operator-selected private pool; never falls back to Docker default IPAM. */
  networkPool: string;
  /** The API/gateway is the only other container attached to each private run network. */
  gatewayContainer: string;
  storageRoots: string[];
  sessionRoot: string;
  journalRoot: string;
  gatewayOrigins: string[];
  /** Trusted internal HTTP proxy origins. Empty/omitted rejects all egress capabilities. */
  egressProxyOrigins?: string[];
  dockerBinary?: string;
  timeoutMs?: number;
  /** Absolute host-installed AppArmor profile name; fail closed if absent on host. */
  appArmorProfile: string;
}
