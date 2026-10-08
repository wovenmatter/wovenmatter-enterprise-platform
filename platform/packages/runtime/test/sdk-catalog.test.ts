import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectSDKFiles,
  resolveSDKGeneration,
  sdkCatalogStatus,
} from "../src/sdk-catalog.ts";
import { loadEmbeddedDefaultAgent } from "../src/embedded/default-agent.ts";
import { runEnterprisePi } from "../src/embedded/enterprise-pi.ts";
import type { ContainerRequest } from "../src/types.ts";

async function fixtureGeneration(
  catalog: string,
  id: string,
  text: string,
  options: { tamperHash?: boolean; version?: string } = {},
) {
  const root = join(catalog, "generations", id);
  const version = options.version ?? "1.1.0";
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "@earendil-works", "pi-durable"), {
    recursive: true,
  });
  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/chord",
  ])
    await mkdir(join(root, "node_modules", ...name.split("/")), {
      recursive: true,
    });
  await writeFile(
    join(root, "src", "durable-session.mjs"),
    `export const fixtureGeneration = ${JSON.stringify(text)};\nexport async function openDurableSession() { return { fixtureGeneration }; }\n`,
  );
  await writeFile(
    join(root, "src", "engine.mjs"),
    "export class DefaultAgentEngine {}\n",
  );
  await writeFile(
    join(root, "node_modules", "@earendil-works", "pi-durable", "package.json"),
    JSON.stringify({ version }),
  );
  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/chord",
  ])
    await writeFile(
      join(root, "node_modules", ...name.split("/"), "package.json"),
      JSON.stringify({ version }),
    );
  await writeFile(join(root, "src", "main-runtime.mjs"), "export {};\n");
  const manifest = {
    schemaVersion: 1,
    id,
    label: `Fixture ${id}`,
    piVersion: version,
    sourceCommit: "fixture-source",
    builtAt: "2026-10-08T00:00:00.000Z",
    builder: "test",
    platform: process.platform,
    arch: process.arch,
    packages: {
      "@earendil-works/pi-durable": version,
      "@earendil-works/pi-ai": version,
      "@earendil-works/pi-coding-agent": version,
      "@earendil-works/chord": version,
    },
    files: await collectSDKFiles(root),
  };
  await writeFile(
    join(root, "woven-sdk-generation.json"),
    JSON.stringify(manifest),
  );
  const digest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  return {
    id,
    root,
    item: {
      id,
      label: `Fixture ${id}`,
      piVersion: version,
      status: "approved",
      integrity: {
        algorithm: "sha256",
        manifest: options.tamperHash ? "0".repeat(64) : digest,
      },
    },
  };
}

test("SDK catalog resolves approved generations to actual selected bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-sdk-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await fixtureGeneration(directory, "pi-1", "first");
  const second = await fixtureGeneration(directory, "pi-2", "second", {
    version: "1.2.0",
  });
  await writeFile(
    join(directory, "catalog.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultGeneration: second.id,
      generations: [first.item, second.item],
    }),
  );
  const status = await sdkCatalogStatus({ catalogDirectory: directory });
  assert.equal(status.defaultGeneration, "pi-2");
  assert.ok(status.items.some((item) => item.id === "pi-1"));
  assert.ok(status.items.some((item) => item.id === "pi-2"));
  const selected = await resolveSDKGeneration({
    generation: "pi-2",
    catalogDirectory: directory,
  });
  assert.equal(selected.id, "pi-2");
  assert.equal(
    selected.piVersion,
    "1.2.0",
    "an approved later compatible minor is selectable",
  );
  assert.equal(selected.root, second.root);
  const loaded = await loadEmbeddedDefaultAgent({
    sdkGeneration: "pi-1",
    catalogDirectory: directory,
  });
  assert.equal(loaded.generation, "pi-1");
  const module = (await import(
    pathToFileURL(join(loaded.root, "src", "durable-session.mjs")).href
  )) as { fixtureGeneration: string };
  assert.equal(module.fixtureGeneration, "first");
});

test("SDK catalog rejects mismatched and tampered generations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-sdk-catalog-bad-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bad = await fixtureGeneration(directory, "pi-bad", "bad", {
    tamperHash: true,
  });
  const good = await fixtureGeneration(directory, "pi-good", "good");
  await writeFile(
    join(directory, "catalog.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultGeneration: good.id,
      generations: [bad.item, good.item],
    }),
  );
  await assert.rejects(
    () =>
      resolveSDKGeneration({
        generation: "pi-bad",
        catalogDirectory: directory,
      }),
    /integrity|approved|generation/i,
  );
  await writeFile(
    join(good.root, "src", "durable-session.mjs"),
    `${await readFile(join(good.root, "src", "durable-session.mjs"), "utf8")}\n// tampered\n`,
  );
  await assert.rejects(
    () =>
      resolveSDKGeneration({
        generation: "pi-good",
        catalogDirectory: directory,
      }),
    /integrity|generation/i,
  );
});

test("SDK catalog checks cwd-independent bundled identity and every load", async (t) => {
  const original = process.cwd();
  const unrelated = await mkdtemp(join(tmpdir(), "wme-unrelated-cwd-"));
  const directory = await mkdtemp(join(tmpdir(), "wme-sdk-catalog-cache-"));
  t.after(async () => {
    process.chdir(original);
    await rm(unrelated, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });
  process.chdir(unrelated);
  const status = await sdkCatalogStatus({ catalogDirectory: directory });
  assert.match(status.bundledGeneration, /^bundled-pi-1\.1\.0-/);
  const good = await fixtureGeneration(directory, "pi-cache", "good");
  await writeFile(
    join(directory, "catalog.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultGeneration: good.id,
      generations: [good.item],
    }),
  );
  assert.equal(
    (
      await resolveSDKGeneration({
        generation: good.id,
        catalogDirectory: directory,
      })
    ).id,
    good.id,
  );
  await writeFile(
    join(good.root, "src", "engine.mjs"),
    "export const x = 1;\n",
  );
  await assert.rejects(
    () =>
      resolveSDKGeneration({
        generation: good.id,
        catalogDirectory: directory,
      }),
    /integrity|manifest|generation/i,
  );
});

test("SDK catalog rejects incomplete, extra, symlinked and incompatible generations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wme-sdk-catalog-strict-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = await fixtureGeneration(directory, "pi-missing", "missing");
  const missingManifest = JSON.parse(
    await readFile(join(missing.root, "woven-sdk-generation.json"), "utf8"),
  );
  delete missingManifest.files["src/main-runtime.mjs"];
  await writeFile(
    join(missing.root, "woven-sdk-generation.json"),
    JSON.stringify(missingManifest),
  );
  const extra = await fixtureGeneration(directory, "pi-extra", "extra");
  await writeFile(join(extra.root, "unexpected.mjs"), "export {};\n");
  const platform = await fixtureGeneration(
    directory,
    "pi-platform",
    "platform",
  );
  const platformManifest = JSON.parse(
    await readFile(join(platform.root, "woven-sdk-generation.json"), "utf8"),
  );
  platformManifest.platform = process.platform === "linux" ? "darwin" : "linux";
  platformManifest.files = await collectSDKFiles(platform.root);
  await writeFile(
    join(platform.root, "woven-sdk-generation.json"),
    JSON.stringify(platformManifest),
  );
  const symlinked = await fixtureGeneration(directory, "pi-link", "link");
  await symlink("/tmp", join(symlinked.root, "node_modules", "escape"));
  await writeFile(
    join(directory, "catalog.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultGeneration: "pi-good",
      generations: [missing.item, extra.item, platform.item, symlinked.item],
    }),
  );
  for (const id of ["pi-missing", "pi-extra", "pi-platform", "pi-link"])
    await assert.rejects(
      () =>
        resolveSDKGeneration({ generation: id, catalogDirectory: directory }),
      /generation|manifest|integrity|platform|unsupported/i,
    );
  await assert.rejects(
    () =>
      resolveSDKGeneration({
        generation: "../pi-link",
        catalogDirectory: directory,
      }),
    /approved|generation/i,
  );
});

test("retained Pi sessions reject SDK generation changes until idle handoff", async () => {
  const retained = {
    pi: {
      sdkGeneration: "pi-old",
      routeKey: "route",
      model: "fixture-model",
      tokenDigest: "token",
      engine: {
        async initialize() {},
        async handle() {
          return {};
        },
      },
    },
  };
  const request: ContainerRequest = {
    runId: "11111111-1111-4111-8111-111111111111",
    projectId: "project",
    harness: "pi",
    model: "fixture-model",
    prompt: "hello",
    access: "write",
    gateway: {
      baseUrl: "https://gateway.example.test",
      token: "synthetic-token",
    },
    pi: { sdkGeneration: "pi-new" },
  };
  await assert.rejects(
    () =>
      runEnterprisePi(
        request,
        async () => {},
        new AbortController().signal,
        undefined,
        retained,
      ),
    /another approved SDK generation/,
  );
});
