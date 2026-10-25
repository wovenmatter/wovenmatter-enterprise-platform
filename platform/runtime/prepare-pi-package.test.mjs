import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
test("published Pi CLI and RPC entrypoints use the patched dependency tree", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "wme-pi-package-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const root = resolve("node_modules/@earendil-works/pi-coding-agent");
  assert.deepEqual((await readdir(join(root, "dist/bundle"))).sort(),
    ["cli-runtime.js", "cli.js", "index.js", "rpc-entry.js"]);
  for (const entry of ["cli.js", "rpc-entry.js"]) {
    const result = await execute(process.execPath,
      [join(root, "dist/bundle", entry), "--version"],
      { env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: state }, timeout: 20000 });
    assert.equal(result.stdout.trim(), "1.1.0");
  }
  // Exercise the published SDK export and Pi's HTTP dispatcher import; resolving
  // only the root package metadata would miss a nested stale dependency.
  const result = await execute(process.execPath, ["--input-type=module", "-e", `
    import {createRequire} from 'node:module';
    import {pathToFileURL} from 'node:url';
    const root = ${JSON.stringify(root)};
    const require = createRequire(root + '/dist/core/http-dispatcher.js');
    const assert = (await import('node:assert/strict')).default;
    assert.equal(require('undici/package.json').version, '8.12.2');
    const sdk = await import(pathToFileURL(root + '/dist/bundle/index.js'));
    assert.equal(typeof sdk.createAgentSession, 'function');
    const dispatcher = await import(pathToFileURL(root + '/dist/core/http-dispatcher.js'));
    assert.equal(typeof dispatcher.configureHttpDispatcher, 'function');
  `], { env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: state }, timeout: 20000 });
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "1.1.0");
});

test("unbundled Pi RPC loads a local TypeScript extension without a provider", { timeout: 25000 }, async (t) => {
  const state = await mkdtemp(join(tmpdir(), "wme-pi-extension-"));
  let child;
  t.after(async () => {
    // Stop Pi's settings/cache writers before removing their private fixture.
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    await rm(state, { recursive: true, force: true });
  });
  const extension = join(state, "probe.ts");
  await writeFile(extension, `export default function (pi: any) {
    pi.registerCommand('packaging-probe', { description: 'Synthetic packaging fixture', handler: async () => {} });
  }`);
  child = spawn(process.execPath, [resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js"),
    "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--extension", extension],
    { cwd: state, env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: state }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  child.stderr.resume();
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Pi RPC packaging fixture timed out")), 20000);
    t.after(() => clearTimeout(timer));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error("Pi RPC exited before response: " + code)));
    lines.on("line", (line) => {
      const value = JSON.parse(line);
      if (value.id === "packaging") { clearTimeout(timer); resolve(value); }
    });
  });
  child.stdin.write(JSON.stringify({ id: "packaging", type: "get_commands" }) + "\n");
  const reply = await response;
  assert.equal(reply.success, true);
  assert.ok(reply.data.commands.some((command) => command.name === "packaging-probe"));
});
