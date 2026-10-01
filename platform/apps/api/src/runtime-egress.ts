import { createEgressProxy, type EgressScope } from "./egress/index.js";
import type { Runtime } from "../../../packages/runtime/src/types.js";

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
    async execute(request, emit, signal) {
      if (!listening) throw new Error("Agent public network is unavailable");
      return options.runtime.execute(
        { ...request, egressProxyUrl: origin.origin },
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
