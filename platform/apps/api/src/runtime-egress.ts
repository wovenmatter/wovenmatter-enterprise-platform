import { createEgressProxy, type EgressScope } from "./egress/index.js";
import type {
  Runtime,
  ProjectRuntimeSpec,
} from "../../../packages/runtime/src/types.js";
export interface NetworkBoundary {
  addresses: string[];
  hostnames: string[];
}
export interface RuntimeEgressOptions {
  runtime: Runtime;
  proxyOrigin: string;
  host: string;
  port: number;
  networkBoundary(): Promise<NetworkBoundary>;
  issueProjectCapability?(spec: ProjectRuntimeSpec): Promise<string>;
  authorize(projectId: string, token: string): Promise<EgressScope>;
}

/** Trusted startup-only wiring. Browser requests never choose proxy URLs or boundaries. */
export async function createRuntimeEgress(options: RuntimeEgressOptions) {
  const origin = new URL(options.proxyOrigin);
  if (
    origin.protocol !== "http:" ||
    !origin.port ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid internal agent proxy origin");
  let boundary: NetworkBoundary | undefined;
  let observedAt = 0;
  let pending: Promise<NetworkBoundary> | undefined;
  async function currentBoundary(): Promise<NetworkBoundary> {
    if (boundary && Date.now() - observedAt < 1000) return boundary;
    if (pending) return pending;
    pending = options
      .networkBoundary()
      .then((value) => {
        boundary = value;
        observedAt = Date.now();
        return value;
      })
      .catch((error) => {
        boundary = undefined;
        throw error;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  const initial = await currentBoundary();
  const proxy = createEgressProxy({
    authorize: options.authorize,
    excludedAddresses: initial.addresses,
    excludedHostnames: initial.hostnames,
    getNetworkBoundary: currentBoundary,
  });
  let listening = false;
  const runtime: Runtime = {
    releaseAsset: options.runtime.releaseAsset?.bind(options.runtime),
    attach: options.runtime.attach?.bind(options.runtime),
    acknowledge: options.runtime.acknowledge?.bind(options.runtime),
    stopSession: options.runtime.stopSession?.bind(options.runtime),
    steer: options.runtime.steer?.bind(options.runtime),
    updateProject: options.runtime.updateProject?.bind(options.runtime),
    ensureProject: options.runtime.ensureProject
      ? async (spec) =>
          options.runtime.ensureProject!({
            ...spec,
            ...(options.issueProjectCapability && !spec.owner
              ? {
                  egressProxyUrl: origin.origin,
                  egressToken: await options.issueProjectCapability(spec),
                }
              : {}),
          })
      : undefined,
    stopProject: options.runtime.stopProject?.bind(options.runtime),
    restoreProject: options.runtime.restoreProject
      ? async (spec) =>
          options.runtime.restoreProject!({
            ...spec,
            ...(options.issueProjectCapability && !spec.owner
              ? {
                  egressProxyUrl: origin.origin,
                  egressToken: await options.issueProjectCapability(spec),
                }
              : {}),
          })
      : undefined,
    purgeProject: options.runtime.purgeProject?.bind(options.runtime),
    async execute(request, emit, signal) {
      if (!listening) throw new Error("Agent public network is unavailable");
      return options.runtime.execute(
        {
          ...request,
          egressProxyUrl: origin.origin,
        },
        emit,
        signal,
      );
    },
    cancel: (id) => options.runtime.cancel(id),
    recover: () => options.runtime.recover(),
  };
  return {
    runtime,
    async start() {
      const address = await proxy.listen(options.host, options.port);
      listening = true;
      return address;
    },
    async close() {
      listening = false;
      await proxy.close();
    },
  };
}
