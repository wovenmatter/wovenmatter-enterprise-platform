import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Exercise the real shell preflight without Docker, privilege, policy loading,
// a build, or ripgrep. Every potentially mutating command is a local stub.
async function preflight(t, profiles, install = "1", readFails = false) {
  const root = await mkdtemp(join(tmpdir(), "wme-profile-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const command of ["dirname", "grep"])
    await symlink("/usr/bin/" + command, join(root, command));
  const log = join(root, "calls.jsonl");
  await writeFile(log, "");
  for (const command of ["docker", "sudo", "npm", "uname"])
    await writeFile(
      join(root, command),
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const command=${JSON.stringify(command)}, args=process.argv.slice(2);
appendFileSync(process.env.PREFLIGHT_LOG, JSON.stringify({command,args})+'\\n');
if(command==='uname')process.stdout.write('Linux\\n');
if(command==='sudo'&&args[0]==='cat'){
 if(process.env.PREFLIGHT_READ_FAIL==='1')process.exit(1);
 process.stdout.write(process.env.PREFLIGHT_PROFILES);
}
if(command==='npm'){console.log('PREFLIGHT_PASSED');process.exit(23);}
`,
      { mode: 0o700 },
    );
  const result = spawnSync(
    "/bin/bash",
    [fileURLToPath(new URL("./check-container.sh", import.meta.url))],
    {
      env: {
        ...process.env,
        PATH: root,
        WME_RUN_CONTAINER_ACCEPTANCE: "1",
        WME_INSTALL_TEST_PROFILES: install,
        PREFLIGHT_LOG: log,
        PREFLIGHT_PROFILES: profiles,
        PREFLIGHT_READ_FAIL: readFails ? "1" : "0",
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.error, undefined);
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { ...result, calls };
}
const enforcing =
  "wme-platform-agent (enforce)\nwme-project-supervisor (enforce)\n";
const loaders = (calls) =>
  calls.filter(
    (call) => call.command === "sudo" && call.args[0] === "apparmor_parser",
  );

test("enforced profiles are recognized with no ripgrep and never reloaded", async (t) => {
  const result = await preflight(t, enforcing);
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stdout, /PREFLIGHT_PASSED/);
  assert.deepEqual(loaders(result.calls), []);
});

test("existing non-enforcing profile is refused even with install opt-in", async (t) => {
  const result = await preflight(
    t,
    enforcing.replace("agent (enforce)", "agent (complain)"),
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /not enforcing; refusing to replace/);
  assert.deepEqual(loaders(result.calls), []);
  assert.equal(
    result.calls.some((call) => call.command === "npm"),
    false,
  );
});

test("profile-list read failure stops preflight without treating profiles as missing", async (t) => {
  const result = await preflight(t, "", "1", true);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(loaders(result.calls), []);
  assert.equal(
    result.calls.some((call) => call.command === "npm"),
    false,
  );
});

test("absent profile requires explicit disposable-runner install opt-in", async (t) => {
  const result = await preflight(t, "unrelated-profile (enforce)\n", "");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /operator policy setup is required/);
  assert.deepEqual(loaders(result.calls), []);
});
