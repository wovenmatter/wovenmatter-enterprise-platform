import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSDKGeneration } from "../sdk-catalog.js";

export interface EmbeddedDefaultAgentRuntime {
  root: string;
  sourceCommit: string;
  generation: string;
  piVersion: string;
  bundled: boolean;
  openDurableSession: (
    engine: unknown,
    id?: string,
    requested?: string,
  ) => Promise<unknown>;
}

const here = dirname(fileURLToPath(import.meta.url));

export function embeddedDefaultAgentRoot() {
  return join(here, "default-agent");
}

export async function loadEmbeddedDefaultAgent(options: {
  sdkGeneration?: string;
  catalogDirectory?: string;
} = {}): Promise<EmbeddedDefaultAgentRuntime> {
  const generation = await resolveSDKGeneration({
    generation: options.sdkGeneration,
    catalogDirectory: options.catalogDirectory,
  });
  const root = generation.root;
  const durable = (await import(
    pathToFileURL(join(root, "src/durable-session.mjs")).href
  )) as {
    openDurableSession: EmbeddedDefaultAgentRuntime["openDurableSession"];
  };
  return {
    root,
    sourceCommit: generation.sourceCommit,
    generation: generation.id,
    piVersion: generation.piVersion,
    bundled: generation.bundled,
    openDurableSession: durable.openDurableSession,
  };
}
