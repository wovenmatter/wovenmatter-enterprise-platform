import type { SteeringChannel } from "./steering.ts";
import type { NativeSessionState } from "./native.ts";
import type { ContainerRequest, EventSink } from "./types.ts";
import { runEnterprisePi } from "./embedded/enterprise-pi.ts";

/** Pi Durable is the only executable harness. Provider SDKs run inside Pi. */
export async function runPi(
  request: ContainerRequest,
  emit: EventSink,
  signal: AbortSignal,
  steering?: SteeringChannel,
  retained?: NativeSessionState,
): Promise<void> {
  await runEnterprisePi(request, emit, signal, steering, retained);
}
