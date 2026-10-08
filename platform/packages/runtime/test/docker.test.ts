import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DockerRuntime, type DockerRuntimeOptions } from "../src/docker.js";
import { validateHostRequest } from "../src/validation.js";
import { volumeMount, storageVolumeName } from "../src/volumes.js";
import type { RuntimeRequest } from "../src/types.js";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "wme-project-driver-")),
    files = join(root, "files"),
    sessions = join(root, "sessions"),
    journal = join(root, "journal"),
    log = join(root, "commands.jsonl"),
    binary = join(root, "docker.mjs");
  for (const path of [
    files,
    sessions,
    journal,
    join(files, "projects/project1/files"),
    join(sessions, "org1/project1/sessions/thread1/codex/read"),
  ])
    await mkdir(path, {
      recursive: true,
    });
  const program = `#!${process.execPath}
import fs from 'node:fs';import {createInterface} from 'node:readline';import crypto from 'node:crypto';
const a=process.argv.slice(2),root=${JSON.stringify(root)},log=${JSON.stringify(log)},container=root+'/container.json',network=root+'/network.json';fs.appendFileSync(log,JSON.stringify(a)+'\\n');
const labels=()=>Object.fromEntries(a.flatMap((v,i)=>v==='--label'?[a[i+1].split('=')]:[]));
const load=file=>JSON.parse(fs.readFileSync(file,'utf8'));const save=(file,data)=>fs.writeFileSync(file,JSON.stringify(data));
if(a[0]==='volume'&&a[1]==='inspect'){const roots=${JSON.stringify([files, sessions, journal])};const r=roots.find(r=>'wme-storage-'+crypto.createHash('sha256').update(r).digest('hex').slice(0,32)===a[2]);console.log(JSON.stringify([{Driver:'local',Options:{type:'none',o:'bind',device:r}}]));}
if(a[0]==='network'&&a[1]==='ls'&&fs.existsSync(network))console.log('net1');
if(a[0]==='network'&&a[1]==='create')save(network,{Id:'net1',Internal:true,Labels:labels(),Containers:{}});
if(a[1]==='inspect'&&['container','network'].includes(a[0])){const file=a[0]==='container'?container:network;if(!fs.existsSync(file)){console.error(a[0]==='network'&&fs.existsSync(root+'/network-error')?fs.readFileSync(root+'/network-error','utf8'):'No such '+a[0]);process.exit(1);}console.log(JSON.stringify([load(file)]));}
if(a[0]==='create')save(container,{Id:'container1',Config:{Labels:labels(),Image:'fixture:runtime'},State:{Running:false}});
if(['start','stop'].includes(a[0])){const c=load(container);c.State.Running=a[0]==='start';save(container,c);}
if(a[0]==='rm')fs.rmSync(container,{force:true});
if(a[0]==='network'&&a[1]==='rm'){if(fs.existsSync(root+'/fail-network-remove')){fs.rmSync(root+'/fail-network-remove');process.exit(1);}fs.rmSync(network,{force:true});}
if(a[0]==='exec')for await(const line of createInterface({input:process.stdin})){const r=JSON.parse(line);if(r.operation==='status'){console.log(JSON.stringify(fs.existsSync(root+'/status.json')?load(root+'/status.json'):{ready:true}));break;}if(r.operation==='policy'){console.log(JSON.stringify({ok:true}));break;}if(r.operation==='cancel'){console.log(JSON.stringify({ok:true}));break;}if(r.operation==='execute'){fs.writeFileSync(root+'/request-'+r.request.runId+'.json',JSON.stringify(r.request));console.log(JSON.stringify({ok:true}));break;}if(r.operation==='attach'){console.log(JSON.stringify({attachment:'synthetic-attachment'}));break;}if(r.operation==='poll'){console.log(JSON.stringify({events:['started','input_accepted','completed'].map((type,i)=>({type,sequence:i+1})).filter(e=>e.sequence>r.after),terminal:true}));break;}if(['acknowledge','stop-session'].includes(r.operation)){console.log(JSON.stringify({ok:true}));break;}}
process.stdin.destroy();
`;
  await writeFile(binary, program);
  await chmod(binary, 0o700);
  t.after(() =>
    rm(root, {
      recursive: true,
      force: true,
    }),
  );
  const options: DockerRuntimeOptions = {
    image: "fixture:runtime",
    network: "wme-runtime",
    networkPool: "10.252.0.0/24",
    gatewayContainer: "synthetic-gateway",
    storageRoots: [files],
    sessionRoot: sessions,
    journalRoot: journal,
    gatewayOrigins: ["http://api:4100"],
    dockerBinary: binary,
    appArmorProfile: "wme-platform-agent",
  };
  const runtime = new DockerRuntime(options),
    spec = {
      projectId: "project1",
      organizationId: "org1",
      hostId: "local",
    };
  const request: RuntimeRequest = {
    runId: "run1",
    organizationId: "org1",
    projectId: "project1",
    conversationId: "thread1",
    harness: "codex",
    model: "fixture-model",
    prompt: "Fixture",
    access: "read",
    mounts: [
      {
        source: join(files, "projects/project1/files"),
        target: "/workspace",
        access: "read",
      },
    ],
    sessionDirectory: join(
      sessions,
      "org1/project1/sessions/thread1/codex/read",
    ),
    gateway: {
      baseUrl: "http://api:4100/enterprise/api/runtime/inference/project1",
      token: "synthetic-scoped-fixture-token",
    },
  };
  return {
    root,
    files,
    sessions,
    journal,
    runtime,
    options,
    spec,
    request,
    commands: async () => {
      try {
        return (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s) as string[]);
      } catch {
        return [];
      }
    },
  };
}
test("one persistent project survives multiple runs; process dispatch never tears down container or volumes", async (t) => {
  const f = await fixture(t);
  await f.runtime.ensureProject(f.spec);
  const events: string[] = [];
  await f.runtime.execute(f.request, (e) => {
    events.push(e.type);
  });
  await f.runtime.execute(
    {
      ...f.request,
      runId: "run2",
    },
    () => {},
  );
  assert.deepEqual(events, [
    "attached",
    "started",
    "input_accepted",
    "completed",
  ]);
  const commands = await f.commands();
  assert.equal(commands.filter((c) => c[0] === "create").length, 1);
  assert.equal(commands.filter((c) => ["stop", "rm"].includes(c[0])).length, 0);
  assert.equal(
    JSON.parse(await readFile(join(f.root, "container.json"), "utf8")).State
      .Running,
    true,
  );
  const c = commands.find((c) => c[0] === "create")!;
  assert.ok(c.includes("unless-stopped"));
  assert.ok(c.includes("apparmor=wme-project-supervisor"));
  assert.ok(c.includes("no-new-privileges:true"));
  assert.equal(c.includes("--privileged"), false);
  await f.runtime.stopProject(f.spec);
  assert.equal(
    JSON.parse(await readFile(join(f.root, "container.json"), "utf8")).State
      .Running,
    false,
  );
});
test("delete before provisioning, repeated stop/restore, and interrupted purge are idempotent", async (t) => {
  const f = await fixture(t);
  await f.runtime.stopProject(f.spec);
  await f.runtime.stopProject(f.spec);
  await assert.rejects(f.runtime.ensureProject(f.spec), {
    code: "project_deleted",
  });
  await f.runtime.restoreProject(f.spec);
  await f.runtime.restoreProject(f.spec);
  assert.equal((await f.commands()).filter((c) => c[0] === "create").length, 1);
  await f.runtime.stopProject(f.spec);
  await writeFile(join(f.root, "fail-network-remove"), "yes");
  await assert.rejects(f.runtime.purgeProject(f.spec));
  await f.runtime.purgeProject(f.spec);
  await f.runtime.purgeProject(f.spec);
  await assert.rejects(f.runtime.restoreProject(f.spec), {
    code: "project_purged",
  });
});
test("purge recovers Docker Engine network-not-found without hiding permission or unrelated lookup failures", async (t) => {
  const f = await fixture(t);
  await f.runtime.ensureProject(f.spec);
  await f.runtime.stopProject(f.spec);
  const network = (await f.commands())
    .find((command) => command[0] === "network" && command[1] === "create")!
    .at(-1)!;
  await rm(join(f.root, "network.json"));
  for (const message of [
    "Error response from daemon: permission denied",
    "Error response from daemon: network unrelated not found",
  ]) {
    await writeFile(join(f.root, "network-error"), message);
    await assert.rejects(f.runtime.purgeProject(f.spec));
  }
  await writeFile(
    join(f.root, "network-error"),
    `Error response from daemon: network ${network} not found\n`,
  );
  await f.runtime.purgeProject(f.spec);
  await f.runtime.purgeProject(f.spec);
  await assert.rejects(f.runtime.restoreProject(f.spec), {
    code: "project_purged",
  });
});
test("concurrent provision and delete serialize; wrong host/org and foreign resources cannot be controlled", async (t) => {
  const f = await fixture(t);
  await Promise.all([
    f.runtime.ensureProject(f.spec),
    f.runtime.stopProject(f.spec),
  ]);
  assert.equal(
    JSON.parse(await readFile(join(f.root, "container.json"), "utf8")).State
      .Running,
    false,
  );
  await assert.rejects(
    f.runtime.restoreProject({
      ...f.spec,
      hostId: "elsewhere",
    }),
    {
      code: "wrong_host",
    },
  );
  await assert.rejects(
    f.runtime.stopProject({
      ...f.spec,
      organizationId: "other",
    }),
    {
      code: "placement_conflict",
    },
  );
  const c = JSON.parse(await readFile(join(f.root, "container.json"), "utf8"));
  c.Config.Labels["com.wovenmatter.enterprise.allocation"] = "foreign";
  await writeFile(join(f.root, "container.json"), JSON.stringify(c));
  await assert.rejects(f.runtime.purgeProject(f.spec), {
    code: "resource_ownership",
  });
  assert.equal((await f.commands()).filter((c) => c[0] === "rm").length, 0);
});
test("runtime recovery restarts a stopped project and preserves durable native state without replaying runs", async (t) => {
  const f = await fixture(t);
  await f.runtime.ensureProject(f.spec);
  await writeFile(join(f.request.sessionDirectory, "history"), "saved");
  const c = JSON.parse(await readFile(join(f.root, "container.json"), "utf8"));
  c.State.Running = false;
  await writeFile(join(f.root, "container.json"), JSON.stringify(c));
  const next = new DockerRuntime(f.options);
  await next.recover();
  assert.equal(
    await readFile(join(f.request.sessionDirectory, "history"), "utf8"),
    "saved",
  );
  assert.equal(
    (await f.commands()).filter(
      (c) => c[0] === "exec" && c.includes("--interactive"),
    ).length,
    3,
  );
  assert.equal((await f.commands()).filter((c) => c[0] === "create").length, 1);
});
test("dispatch validates project/session identity, share scope, symlink sources and network capabilities", async (t) => {
  const f = await fixture(t);
  await f.runtime.ensureProject(f.spec);
  await assert.rejects(
    f.runtime.execute(
      {
        ...f.request,
        sessionDirectory: f.sessions,
      },
      () => {},
    ),
    {
      code: "invalid_session",
    },
  );
  await mkdir(join(f.files, "projects/other/files"), {
    recursive: true,
  });
  await assert.rejects(
    f.runtime.execute(
      {
        ...f.request,
        mounts: [
          {
            source: join(f.files, "projects/other/files"),
            target: "/workspace",
            access: "read",
          },
        ],
      },
      () => {},
    ),
    {
      code: "invalid_mount",
    },
  );
  await assert.rejects(
    f.runtime.execute(
      {
        ...f.request,
        gateway: {
          baseUrl: "http://private.invalid",
          token: "x",
        },
      },
      () => {},
    ),
    {
      code: "invalid_gateway",
    },
  );
  await assert.rejects(
    f.runtime.execute(
      {
        ...f.request,
        egressProxyUrl: "http://api:4101",
      },
      () => {},
    ),
    {
      code: "invalid_gateway",
    },
  );
  await symlink(f.request.mounts[0].source, join(f.files, "alias"));
  await assert.rejects(
    validateHostRequest(
      {
        ...f.request,
        mounts: [
          {
            source: join(f.files, "alias"),
            target: "/workspace",
            access: "read",
          },
        ],
      },
      [f.files],
      f.sessions,
    ),
    {
      code: "invalid_mount",
    },
  );
  assert.throws(() =>
    volumeMount("/unmanaged", "/workspace", [f.files], false),
  );
  assert.match(storageVolumeName(f.files), /^wme-storage-/);
});
test("runtime image changes require an explicit backed-up operator update", async (t) => {
  const f = await fixture(t);
  await f.runtime.ensureProject(f.spec);
  const newer = new DockerRuntime({
    ...f.options,
    image: "fixture:next-runtime",
  });
  await assert.rejects(newer.ensureProject(f.spec), {
    code: "runtime_upgrade_required",
  });
  assert.equal((await f.commands()).filter((c) => c[0] === "create").length, 1);
  assert.equal(
    JSON.parse(await readFile(join(f.root, "container.json"), "utf8")).State
      .Running,
    true,
  );
});

test("asset compute releases only an idle matching lease and reopens durable workspace without creating project storage", async (t) => {
  const f = await fixture(t),
    assetId = "asset1",
    projectId = "asset-" + assetId;
  const spec = {
    projectId,
    organizationId: "org1",
    hostId: "local",
    owner: { kind: "asset" as const, assetId },
    workspaceLease: 1,
    scheduleEnabled: false,
    scheduleMounts: [],
  };
  const root = join(f.files, "assets", assetId, "files"),
    sessionDirectory = join(
      f.sessions,
      "org1",
      projectId,
      "sessions/thread1/codex/write",
    );
  await mkdir(root, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(root, "retained.txt"), "durable asset");
  const request = {
    ...f.request,
    projectId,
    assetId,
    workspaceLease: 1,
    access: "write" as const,
    sessionDirectory,
    mounts: [{ source: root, target: "/workspace", access: "write" as const }],
    gateway: {
      ...f.request.gateway,
      baseUrl: "http://api:4100/enterprise/api/runtime/inference/" + projectId,
    },
  };
  await f.runtime.ensureProject(spec);
  await f.runtime.execute(request, () => {});
  assert.ok((await f.commands()).find((c) => c.includes("wme-asset-asset1")));
  assert.ok(
    (await f.commands()).some((c) =>
      c.includes("com.wovenmatter.enterprise.asset=asset1"),
    ),
  );
  await writeFile(
    join(f.root, "status.json"),
    JSON.stringify({ ready: true, runIds: ["active-run"], sessions: [] }),
  );
  await assert.rejects(f.runtime.releaseAsset(spec), {
    code: "workspace_busy",
  });
  assert.equal((await f.commands()).filter((c) => c[0] === "stop").length, 0);
  await writeFile(
    join(f.root, "status.json"),
    JSON.stringify({
      ready: true,
      runIds: [],
      sessions: [{ activeRun: "active-turn" }],
    }),
  );
  await assert.rejects(f.runtime.releaseAsset(spec), {
    code: "workspace_busy",
  });
  await writeFile(
    join(f.root, "status.json"),
    JSON.stringify({ ready: true, runIds: [], sessions: [] }),
  );
  await f.runtime.releaseAsset(spec);
  assert.equal(
    await readFile(join(root, "retained.txt"), "utf8"),
    "durable asset",
  );
  await assert.rejects(f.runtime.ensureProject(spec), {
    code: "stale_workspace_lease",
  });
  await f.runtime.ensureProject({ ...spec, workspaceLease: 2 });
  const stops = (await f.commands()).filter((c) => c[0] === "stop").length;
  await f.runtime.releaseAsset(spec);
  assert.equal(
    (await f.commands()).filter((c) => c[0] === "stop").length,
    stops,
    "stale release cannot stop newer lease",
  );
  await assert.rejects(
    f.runtime.execute({ ...request, runId: "stale-admission" }, () => {}),
    { code: "stale_workspace_lease" },
  );
  await f.runtime.execute(
    { ...request, runId: "next-admission", workspaceLease: 2 },
    () => {},
  );
  const restarted = new DockerRuntime(f.options);
  await restarted.recover();
  assert.equal(
    (await f.commands()).filter((c) => c[0] === "create").length,
    2,
    "recovery cannot start idle asset compute",
  );
  await assert.rejects(f.runtime.releaseAsset(f.spec), { code: "asset_only" });
});

test("Stop before provisioning and while compute is absent durably fences delayed dispatch across supervisor restart", async (t) => {
  const f = await fixture(t);
  await f.runtime.stopSession(f.spec.projectId, f.request.conversationId, 1);
  assert.equal((await f.commands()).filter((c) => c[0] === "create").length, 0);
  await f.runtime.ensureProject(f.spec);
  const restarted = new DockerRuntime(f.options);
  await assert.rejects(
    restarted.execute(f.request, () => {}),
    { code: "authority_revoked" },
  );
  await restarted.execute(
    { ...f.request, runId: "current", generation: 1 },
    () => {},
  );
  await restarted.stopSession(f.spec.projectId, f.request.conversationId, 0);
  await assert.rejects(
    restarted.execute({ ...f.request, runId: "late" }, () => {}),
    { code: "authority_revoked" },
  );
});
