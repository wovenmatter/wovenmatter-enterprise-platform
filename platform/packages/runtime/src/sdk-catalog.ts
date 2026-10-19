import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, sep } from "node:path";
import { embeddedDefaultAgentRoot } from "./embedded/default-agent.js";
import { RuntimeError } from "./types.js";

export type SDKGenerationCatalogItem = {
  id: string;
  label: string;
  piVersion: string;
  status: "approved";
  bundled?: boolean;
  provenance?: {
    sourceCommit?: string;
    builtAt?: string;
    builder?: string;
  };
  integrity: {
    algorithm: "sha256";
    manifest: string;
  };
};

export type SDKCatalogStatus = {
  bundledGeneration: string;
  defaultGeneration: string;
  items: SDKGenerationCatalogItem[];
};

export type SDKGenerationRuntime = {
  id: string;
  root: string;
  sourceCommit: string;
  piVersion: string;
  bundled: boolean;
};

type CatalogFile = {
  schemaVersion?: number;
  defaultGeneration?: unknown;
  generations?: unknown;
};

type GenerationManifest = {
  schemaVersion?: number;
  id?: unknown;
  label?: unknown;
  piVersion?: unknown;
  sourceCommit?: unknown;
  builtAt?: unknown;
  builder?: unknown;
  platform?: unknown;
  arch?: unknown;
  packages?: unknown;
  files?: unknown;
};

const SOURCE_COMMIT = "5542b83ab2e11cc3c24037552883e2c6814bd596";
const DEFAULT_CATALOG = "/opt/runtime/approved-sdk";
const manifestName = "woven-sdk-generation.json";
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const maxCatalogGenerations = 256;
const maxManifestBytes = 64 * 1024 * 1024;
const maxManifestFiles = 250_000;
const requiredSources = [
  "src/engine.mjs",
  "src/durable-session.mjs",
  "src/main-runtime.mjs",
];
const requiredPackages = [
  "@earendil-works/pi-durable",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/chord",
];
const moduleRequire = createRequire(import.meta.url);

async function readBoundedJSON<T>(
  path: string,
  maxBytes = 1024 * 1024,
): Promise<T | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new RuntimeError(
        "invalid_sdk_generation",
        "The SDK catalog metadata is invalid.",
      );
    return JSON.parse(await file.readFile("utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function packageJSONPath(name: string) {
  try {
    return moduleRequire.resolve(`${name}/package.json`);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED"
    )
      throw error;
  }
  for (const base of moduleRequire.resolve.paths(name) ?? []) {
    const candidate = join(base, ...name.split("/"), "package.json");
    const value = await readBoundedJSON<{ name?: unknown }>(
      candidate,
      64 * 1024,
    ).catch(() => undefined);
    if (value?.name === name) return candidate;
  }
  let current = dirname(moduleRequire.resolve(name));
  for (;;) {
    const candidate = join(current, "package.json");
    const value = await readBoundedJSON<{ name?: unknown }>(
      candidate,
      64 * 1024,
    ).catch(() => undefined);
    if (value?.name === name) return candidate;
    const parent = dirname(current);
    if (parent === current)
      throw new RuntimeError(
        "invalid_sdk_generation",
        `Unable to resolve installed package ${name}.`,
      );
    current = parent;
  }
}

async function actualPackageVersion(name: string) {
  const value = await readBoundedJSON<{ version?: unknown }>(
    await packageJSONPath(name),
    64 * 1024,
  ).catch(() => undefined);
  return typeof value?.version === "string" ? value.version : "unknown";
}

async function findUpPackageLock(start: string) {
  let current = start;
  for (;;) {
    const candidate = join(current, "package-lock.json");
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function bundledSDKGenerationId() {
  const hash = createHash("sha256");
  hash.update(SOURCE_COMMIT);
  const embeddedFiles = await collectSDKFiles(embeddedDefaultAgentRoot());
  for (const [path, digest] of Object.entries(embeddedFiles))
    hash.update(`source\0${path}\0${digest}\0`);
  for (const name of requiredPackages) {
    const path = await packageJSONPath(name);
    hash.update(`package\0${name}\0${await actualPackageVersion(name)}\0`);
    hash.update(await sha256File(path));
  }
  const lock = await findUpPackageLock(
    dirname(await packageJSONPath("@earendil-works/pi-durable")),
  );
  if (lock) hash.update(`lock\0${await sha256File(lock)}\0`);
  return `bundled-pi-${(await actualPackageVersion("@earendil-works/pi-durable")).replace(/[^0-9A-Za-z_.-]/g, "_")}-${hash.digest("hex").slice(0, 16)}`;
}

async function bundledItem(): Promise<SDKGenerationCatalogItem> {
  const id = await bundledSDKGenerationId();
  return {
    id,
    label: "Bundled Pi Durable SDK",
    piVersion: await actualPackageVersion("@earendil-works/pi-durable"),
    status: "approved",
    bundled: true,
    provenance: { sourceCommit: SOURCE_COMMIT },
    integrity: {
      algorithm: "sha256",
      manifest: createHash("sha256").update(id).digest("hex"),
    },
  };
}

function catalogDirectory(directory?: string) {
  return directory ?? process.env.WME_PI_SDK_CATALOG ?? DEFAULT_CATALOG;
}

function validateGenerationId(id: unknown): string {
  if (typeof id !== "string" || !safeId.test(id))
    throw new RuntimeError(
      "invalid_sdk_generation",
      "Choose an approved Pi SDK generation.",
    );
  return id;
}

function ensureInside(root: string, path: string) {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || rel.includes(sep + ".." + sep))
    throw new RuntimeError(
      "invalid_sdk_generation",
      "The SDK generation manifest is invalid.",
    );
}

async function ensureNoSymlinkAncestors(root: string) {
  let current = root;
  for (;;) {
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new RuntimeError(
        "invalid_sdk_generation",
        "The SDK catalog path is invalid.",
      );
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile())
      throw new RuntimeError(
        "invalid_sdk_generation",
        "The SDK generation contains invalid files.",
      );
    const stream = file.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await file.close().catch(() => undefined);
  }
}

function normalizeFiles(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RuntimeError(
      "invalid_sdk_generation",
      "The SDK generation manifest is invalid.",
    );
  const files: Record<string, string> = {};
  for (const [path, digest] of Object.entries(value)) {
    if (
      path.startsWith("/") ||
      path.includes("..") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path === manifestName ||
      typeof digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new RuntimeError(
        "invalid_sdk_generation",
        "The SDK generation manifest is invalid.",
      );
    files[path] = digest;
  }
  if (Object.keys(files).length > maxManifestFiles)
    throw new RuntimeError(
      "invalid_sdk_generation",
      "The SDK generation manifest is too large.",
    );
  return files;
}

async function manifestHash(manifest: GenerationManifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

async function verifyGeneration(
  root: string,
  id: string,
  expectedManifestHash?: string,
): Promise<SDKGenerationRuntime & { item: SDKGenerationCatalogItem }> {
  await ensureNoSymlinkAncestors(root);
  const manifestPath = join(root, manifestName);
  const manifest = await readBoundedJSON<GenerationManifest>(
    manifestPath,
    maxManifestBytes,
  );
  if (!manifest || manifest.schemaVersion !== 1 || manifest.id !== id)
    throw new RuntimeError(
      "invalid_sdk_generation",
      "The SDK generation manifest is invalid.",
    );
  const hash = await manifestHash(manifest);
  if (expectedManifestHash && hash !== expectedManifestHash)
    throw new RuntimeError(
      "invalid_sdk_generation",
      "The SDK generation integrity check failed.",
    );
  const files = normalizeFiles(manifest.files);
  for (const source of requiredSources)
    if (!files[source])
      throw new RuntimeError(
        "invalid_sdk_generation",
        "The SDK generation manifest is incomplete.",
      );
  for (const name of requiredPackages)
    if (!files[`node_modules/${name}/package.json`])
      throw new RuntimeError(
        "invalid_sdk_generation",
        "The SDK generation dependency manifest is incomplete.",
      );
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new RuntimeError(
      "invalid_sdk_generation",
      "The SDK generation is not compatible with this runtime platform.",
    );
  const actualFiles = await collectSDKFiles(root);
  const manifestKeys = Object.keys(files).sort();
  const actualKeys = Object.keys(actualFiles).sort();
  if (
    manifestKeys.length !== actualKeys.length ||
    manifestKeys.some((value, index) => value !== actualKeys[index])
  )
    throw new RuntimeError(
      "invalid_sdk_generation",
      "The SDK generation file manifest does not match its contents.",
    );
  for (const [name, digest] of Object.entries(files)) {
    const path = join(root, name);
    ensureInside(root, path);
    if (actualFiles[name] !== digest)
      throw new RuntimeError(
        "invalid_sdk_generation",
        "The SDK generation integrity check failed.",
      );
  }
  const packages =
    manifest.packages &&
    typeof manifest.packages === "object" &&
    !Array.isArray(manifest.packages)
      ? (manifest.packages as Record<string, unknown>)
      : {};
  for (const name of requiredPackages) {
    const packageInfo = await readBoundedJSON<{ version?: unknown }>(
      join(root, "node_modules", ...name.split("/"), "package.json"),
      64 * 1024,
    );
    const version = packageInfo?.version;
    if (
      typeof version !== "string" ||
      !/^1\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(version) ||
      packages[name] !== version
    )
      throw new RuntimeError(
        "invalid_sdk_generation",
        "The SDK generation has incompatible Pi package versions.",
      );
  }
  const piVersion =
    typeof manifest.piVersion === "string" ? manifest.piVersion : "unknown";
  if (packages["@earendil-works/pi-durable"] !== piVersion)
    throw new RuntimeError(
      "invalid_sdk_generation",
      "The SDK generation Pi version does not match its dependency closure.",
    );
  const sourceCommit =
    typeof manifest.sourceCommit === "string"
      ? manifest.sourceCommit
      : SOURCE_COMMIT;
  return {
    id,
    root,
    piVersion,
    sourceCommit,
    bundled: false,
    item: {
      id,
      label: typeof manifest.label === "string" ? manifest.label : id,
      piVersion,
      status: "approved",
      provenance: {
        sourceCommit,
        ...(typeof manifest.builtAt === "string"
          ? { builtAt: manifest.builtAt }
          : {}),
        ...(typeof manifest.builder === "string"
          ? { builder: manifest.builder }
          : {}),
      },
      integrity: { algorithm: "sha256", manifest: hash },
    },
  };
}

async function readCatalog(directory?: string) {
  const root = catalogDirectory(directory);
  const catalog = await readBoundedJSON<CatalogFile>(
    join(root, "catalog.json"),
    1024 * 1024,
  ).catch(() => undefined);
  return { root, catalog };
}

export async function sdkCatalogStatus(
  options: {
    catalogDirectory?: string;
  } = {},
): Promise<SDKCatalogStatus> {
  const bundled = await bundledItem();
  const { root, catalog } = await readCatalog(options.catalogDirectory);
  const items = [bundled];
  let configuredDefault: string | undefined;
  if (catalog?.schemaVersion === 1 && catalog.defaultGeneration !== undefined)
    configuredDefault = validateGenerationId(catalog.defaultGeneration);
  if (catalog?.schemaVersion === 1 && Array.isArray(catalog.generations)) {
    if (catalog.generations.length > maxCatalogGenerations)
      throw new RuntimeError(
        "invalid_sdk_generation",
        "The SDK catalog has too many generations.",
      );
    for (const entry of catalog.generations) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as { id?: unknown }).id;
      const integrity = (entry as { integrity?: unknown }).integrity;
      const manifest =
        integrity && typeof integrity === "object"
          ? (integrity as { manifest?: unknown }).manifest
          : undefined;
      if (typeof manifest !== "string") continue;
      const generationId = validateGenerationId(id);
      try {
        const verified = await verifyGeneration(
          join(root, "generations", generationId),
          generationId,
          manifest,
        );
        items.push(verified.item);
      } catch (error) {
        if (configuredDefault === generationId) throw error;
        // Broken catalog entries fail closed on selection but are omitted from
        // user inventory to avoid advertising unusable generations.
      }
    }
  }
  const defaultGeneration =
    configuredDefault && items.some((item) => item.id === configuredDefault)
      ? configuredDefault
      : bundled.id;
  if (
    configuredDefault &&
    configuredDefault !== bundled.id &&
    defaultGeneration !== configuredDefault
  )
    throw new RuntimeError(
      "sdk_generation_unavailable",
      "The configured Pi SDK generation is not available.",
    );
  return {
    bundledGeneration: bundled.id,
    defaultGeneration,
    items,
  };
}

export async function resolveSDKGeneration(
  options: {
    generation?: string;
    catalogDirectory?: string;
  } = {},
): Promise<SDKGenerationRuntime> {
  const bundled = await bundledItem();
  const selected = options.generation;
  if (selected === undefined) {
    const status = await sdkCatalogStatus(options);
    return resolveSDKGeneration({
      ...options,
      generation: status.defaultGeneration,
    });
  }
  const id = validateGenerationId(selected);
  if (id === bundled.id)
    return {
      id,
      root: embeddedDefaultAgentRoot(),
      sourceCommit: SOURCE_COMMIT,
      piVersion: bundled.piVersion,
      bundled: true,
    };
  const { root, catalog } = await readCatalog(options.catalogDirectory);
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.generations))
    throw new RuntimeError(
      "sdk_generation_unavailable",
      "The selected Pi SDK generation is not available.",
    );
  const entry = catalog.generations.find(
    (value) =>
      value &&
      typeof value === "object" &&
      (value as { id?: unknown }).id === id,
  ) as { integrity?: { manifest?: unknown } } | undefined;
  const expected =
    entry?.integrity &&
    typeof entry.integrity.manifest === "string" &&
    /^[a-f0-9]{64}$/.test(entry.integrity.manifest)
      ? entry.integrity.manifest
      : undefined;
  if (!entry || !expected)
    throw new RuntimeError(
      "sdk_generation_unavailable",
      "The selected Pi SDK generation is not approved.",
    );
  const verified = await verifyGeneration(
    join(root, "generations", id),
    id,
    expected,
  );
  return {
    id: verified.id,
    root: verified.root,
    piVersion: verified.piVersion,
    sourceCommit: verified.sourceCommit,
    bundled: false,
  };
}

export async function collectSDKFiles(root: string) {
  const result: Record<string, string> = {};
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        entry.name === manifestName ||
        entry.name === ".installer-home" ||
        entry.name === ".installer-tmp" ||
        entry.name === ".npm-cache"
      )
        continue;
      const path = join(directory, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if (rel.startsWith("..") || rel.includes("\0"))
        throw new RuntimeError(
          "invalid_sdk_generation",
          "The SDK generation contains invalid files.",
        );
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && !entry.isSymbolicLink())
        result[rel] = await sha256File(path);
      else
        throw new RuntimeError(
          "invalid_sdk_generation",
          `Unsupported SDK bundle entry: ${basename(path)}`,
        );
    }
  }
  await visit(root);
  return result;
}
