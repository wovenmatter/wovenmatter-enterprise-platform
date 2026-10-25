// Pi 1.1.0 publishes both unbundled entrypoints and a CLI bundle containing its
// own Undici copy. Use the published unbundled code so lockfile overrides apply
// to shell-invoked Pi as well as Enterprise's embedded SDK.
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function preparePiPackage(modules = "node_modules") {
  const root = resolve(modules, "@earendil-works/pi-coding-agent");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (pkg.name !== "@earendil-works/pi-coding-agent" || pkg.version !== "1.1.0")
    throw new Error("Review Pi's bundled dependencies before changing its version");
  if (pkg.bin?.pi !== "dist/bundle/cli.js" ||
      pkg.exports?.["./rpc-entry"]?.import !== "./dist/bundle/rpc-entry.js" ||
      pkg.exports?.["."]?.import !== "./dist/index.js")
    throw new Error("Unexpected Pi package entrypoints");
  for (const name of ["dist", "dist/bundle"]) {
    const info = await lstat(join(root, name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error("Expected an ordinary Pi distribution directory");
  }
  // Validate all targets before replacing any installed files. The package
  // manifest, notices and upstream unbundled implementation remain untouched.
  for (const name of ["cli.js", "rpc-entry.js", "index.js"])
    if (!(await lstat(join(root, "dist", name))).isFile())
      throw new Error("Missing published Pi entrypoint: " + name);
  const bundle = join(root, "dist/bundle");
  await rm(bundle, { recursive: true, force: true });
  await mkdir(bundle);
  for (const name of ["cli.js", "cli-runtime.js", "rpc-entry.js", "index.js"]) {
    const target = name === "cli-runtime.js" ? "cli.js" : name;
    const source = name === "index.js"
      ? 'export * from "../index.js";\n'
      : name === "cli.js"
      ? '#!/usr/bin/env node\nimport { enableCompileCache } from "node:module";\nenableCompileCache();\nawait import("../cli.js");\n'
      : '#!/usr/bin/env node\nimport "../' + target + '";\n';
    await writeFile(join(bundle, name), source, { mode: 0o755 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await preparePiPackage(process.argv[2]);
