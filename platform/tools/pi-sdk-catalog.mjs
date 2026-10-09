#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const manifestName = "woven-sdk-generation.json";
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const execFile = promisify(execFileCallback);
const requiredPackages = [
  "@earendil-works/pi-durable",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/chord",
];
const importRequiredPackages = [
  "@anthropic-ai/claude-agent-sdk",
  "@modelcontextprotocol/sdk",
  "proper-lockfile",
  "typebox",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name) {
  return process.argv.includes(name);
}

async function readJSON(path, max = 64 * 1024 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > max) throw new Error("invalid metadata");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close().catch(() => {});
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stream = file.createReadStream();
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await file.close().catch(() => {});
  }
}

async function collectFiles(root) {
  const files = {};
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        entry.name === manifestName ||
        entry.name === ".staging" ||
        entry.name === ".tmp"
      )
        continue;
      const path = join(directory, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && !entry.isSymbolicLink())
        files[rel] = await sha256File(path);
      else throw new Error(`unsupported bundle entry ${rel}`);
    }
  }
  await visit(root);
  return files;
}

async function copyWorkspaceManifests(destination) {
  await mkdir(join(destination, "platform/packages/runtime"), {
    recursive: true,
    mode: 0o755,
  });
  await cp(join(repo, "package.json"), join(destination, "package.json"));
  await cp(
    join(repo, "package-lock.json"),
    join(destination, "package-lock.json"),
  );
  await cp(
    join(repo, "platform/packages/runtime/package.json"),
    join(destination, "platform/packages/runtime/package.json"),
  );
  for (const area of ["platform/apps", "platform/packages"]) {
    let entries = [];
    try {
      entries = await readdir(join(repo, area), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "runtime") continue;
      const source = join(repo, area, entry.name, "package.json");
      try {
        await access(source);
      } catch {
        continue;
      }
      const target = join(destination, area, entry.name, "package.json");
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await cp(source, target);
    }
  }
}

async function installLockedRuntimeClosure(root) {
  await copyWorkspaceManifests(root);
  try {
    await execFile(
      "npm",
      [
        "ci",
        "--ignore-scripts",
        "--omit=dev",
        "--workspace",
        "@wovenmatter-enterprise/runtime",
        "--include-workspace-root=false",
      ],
      {
        cwd: root,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
      },
    );
  } catch (error) {
    const output = [error.message, error.stderr, error.stdout]
      .filter(Boolean)
      .join("\n")
      .slice(-12000);
    throw new Error(
      `Locked runtime dependency install failed.${output ? `\n${output}` : ""}`,
    );
  }
  await rm(join(root, "node_modules", ".bin"), {
    recursive: true,
    force: true,
  });
  await rm(join(root, "node_modules", "@wovenmatter-enterprise"), {
    recursive: true,
    force: true,
  });
}

async function packageVersion(packageRoot) {
  return (await readJSON(join(packageRoot, "package.json"), 64 * 1024)).version;
}

async function verifyGeneration(root, expectedId) {
  const manifest = await readJSON(join(root, manifestName));
  if (manifest.schemaVersion !== 1 || manifest.id !== expectedId)
    throw new Error("manifest identity mismatch");
  const actualFiles = await collectFiles(root);
  const manifestFiles = manifest.files ?? {};
  const expectedNames = Object.keys(manifestFiles).sort();
  const actualNames = Object.keys(actualFiles).sort();
  if (
    expectedNames.length !== actualNames.length ||
    expectedNames.some((name, index) => name !== actualNames[index])
  )
    throw new Error("manifest coverage mismatch");
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new Error("platform mismatch");
  for (const [name, digest] of Object.entries(manifestFiles)) {
    if (
      name.startsWith("/") ||
      name.includes("..") ||
      name.includes("\\") ||
      !/^[a-f0-9]{64}$/.test(String(digest))
    )
      throw new Error("invalid manifest file entry");
    if (actualFiles[name] !== digest)
      throw new Error(`integrity mismatch: ${name}`);
  }
  await access(join(root, "src", "engine.mjs"));
  await access(join(root, "src", "durable-session.mjs"));
  await access(join(root, "src", "main-runtime.mjs"));
  for (const name of requiredPackages) {
    const version = await packageVersion(
      join(root, "node_modules", ...name.split("/")),
    );
    if (!/^1\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(version))
      throw new Error(`incompatible package version: ${name}@${version}`);
    if (manifest.packages?.[name] !== version)
      throw new Error(`package manifest mismatch: ${name}`);
  }
  for (const name of importRequiredPackages)
    await access(
      join(root, "node_modules", ...name.split("/"), "package.json"),
    );
  await import(`file://${join(root, "src", "durable-session.mjs")}`);
  await import(`file://${join(root, "src", "engine.mjs")}`);
  return {
    id: manifest.id,
    label: manifest.label,
    piVersion: manifest.piVersion,
    status: "approved",
    provenance: {
      sourceCommit: manifest.sourceCommit,
      builtAt: manifest.builtAt,
      builder: manifest.builder,
    },
    integrity: {
      algorithm: "sha256",
      manifest: createHash("sha256")
        .update(JSON.stringify(manifest))
        .digest("hex"),
    },
  };
}

async function readCatalog(catalog) {
  try {
    return await readJSON(join(catalog, "catalog.json"));
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, generations: [] };
    throw error;
  }
}

async function writeCatalog(catalog, value) {
  await mkdir(catalog, { recursive: true, mode: 0o755 });
  const tmp = join(catalog, `catalog.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o644 });
  await rename(tmp, join(catalog, "catalog.json"));
}

async function build() {
  const catalog = resolve(option("--catalog") ?? fail("Missing --catalog."));
  const id = option("--id") ?? fail("Missing --id.");
  if (!safeId.test(id)) fail("Invalid generation id.");
  const label = option("--label") ?? id;
  const source = resolve(
    option("--source") ??
      join(repo, "platform/packages/runtime/src/embedded/default-agent"),
  );
  const sourceCommit =
    option("--source-commit") ??
    (await execFile("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const builder = option("--builder") ?? "operator";
  const generations = join(catalog, "generations");
  const finalRoot = join(generations, id);
  try {
    await access(finalRoot);
    fail("Generation already exists.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stage = join(generations, `.staging-${id}-${process.pid}`);
  const install = join(generations, `.install-${id}-${process.pid}`);
  await rm(stage, { recursive: true, force: true });
  await rm(install, { recursive: true, force: true });
  await mkdir(stage, { recursive: true, mode: 0o755 });
  try {
    await mkdir(install, { recursive: true, mode: 0o755 });
    await installLockedRuntimeClosure(install);
    await cp(join(source, "src"), join(stage, "src"), { recursive: true });
    await cp(join(repo, "LICENSE"), join(stage, "WovenMatter-LICENSE.txt"));
    await cp(join(source, "README.md"), join(stage, "README.md"));
    await cp(join(install, "package.json"), join(stage, "package.json"));
    await cp(
      join(install, "package-lock.json"),
      join(stage, "package-lock.json"),
    );
    await cp(join(install, "node_modules"), join(stage, "node_modules"), {
      recursive: true,
      dereference: false,
      filter: (path) =>
        !path.includes(`${sep}.cache${sep}`) &&
        !path.includes(`${sep}.git${sep}`) &&
        basename(path) !== ".npmrc",
    });
    const piVersion = await packageVersion(
      join(stage, "node_modules/@earendil-works/pi-durable"),
    );
    const packages = {};
    for (const name of [...requiredPackages, ...importRequiredPackages])
      packages[name] = await packageVersion(
        join(stage, "node_modules", ...name.split("/")),
      );
    const files = await collectFiles(stage);
    const manifest = {
      schemaVersion: 1,
      id,
      label,
      piVersion,
      sourceCommit,
      upstreamSourceCommit: "5542b83ab2e11cc3c24037552883e2c6814bd596",
      builtAt: new Date().toISOString(),
      builder,
      platform: process.platform,
      arch: process.arch,
      packages,
      files,
    };
    await writeFile(join(stage, manifestName), JSON.stringify(manifest), {
      mode: 0o644,
    });
    const item = await verifyGeneration(stage, id);
    await mkdir(generations, { recursive: true, mode: 0o755 });
    await rename(stage, finalRoot);
    const current = await readCatalog(catalog);
    const generationsList = [
      ...(current.generations ?? []).filter((entry) => entry.id !== id),
      item,
    ].sort((a, b) => a.id.localeCompare(b.id));
    await writeCatalog(catalog, {
      schemaVersion: 1,
      ...(has("--default")
        ? { defaultGeneration: id }
        : current.defaultGeneration
          ? { defaultGeneration: current.defaultGeneration }
          : {}),
      generations: generationsList,
    });
    console.log(JSON.stringify({ ok: true, item }, null, 2));
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    await rm(install, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(install, { recursive: true, force: true });
  }
}

async function verify() {
  const catalog = resolve(option("--catalog") ?? fail("Missing --catalog."));
  const selected = option("--id");
  const current = await readCatalog(catalog);
  const entries = (current.generations ?? []).filter(
    (entry) => !selected || entry.id === selected,
  );
  const items = [];
  for (const entry of entries)
    items.push(
      await verifyGeneration(join(catalog, "generations", entry.id), entry.id),
    );
  console.log(
    JSON.stringify(
      { ok: true, defaultGeneration: current.defaultGeneration, items },
      null,
      2,
    ),
  );
}

async function status() {
  const catalog = resolve(option("--catalog") ?? fail("Missing --catalog."));
  console.log(JSON.stringify(await readCatalog(catalog), null, 2));
}

const command = process.argv[2];
try {
  if (command === "build") await build();
  else if (command === "verify") await verify();
  else if (command === "status") await status();
  else fail("Usage: pi-sdk-catalog.mjs <status|build|verify> --catalog <dir>");
} catch (error) {
  fail(error instanceof Error ? error.message : "SDK catalog command failed.");
}
