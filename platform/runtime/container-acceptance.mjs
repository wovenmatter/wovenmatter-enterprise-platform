// Real persistent-project acceptance. No firewall, host sysctl or policy mutation.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  chmod,
  chown,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, networkInterfaces } from "node:os";
import { boundaryTargets } from "./boundary-targets.mjs";
import { ProjectDockerRuntime } from "../dist/packages/runtime/src/project-runtime.js";
import { storageVolumeName } from "../dist/packages/runtime/src/volumes.js";
import { createIsolatedNetwork } from "../dist/packages/runtime/src/networks.js";
if (
  process.platform !== "linux" ||
  process.env.WME_RUN_CONTAINER_ACCEPTANCE !== "1"
)
  throw new Error("Explicit Linux container acceptance is required");
const image = process.env.WME_AGENT_IMAGE;
if (!image) throw new Error("Set the exact current runtime image");
const execute = promisify(execFile);
const docker = async (...args) =>
  (
    await execute("docker", args, {
      timeout: 90000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
const evidence = resolve(
  process.env.WME_ACCEPTANCE_ROOT ?? join(tmpdir(), "wme-container-evidence"),
);
await mkdir(evidence, {
  recursive: true,
  mode: 0o700,
});
const root = await mkdtemp(join(evidence, "fixture-")),
  allocation = randomUUID();
const projectId = "acceptance-" + allocation,
  organizationId = "acceptance-org";
const gateway = "wme-pr2-acceptance-gateway-" + allocation,
  bootstrap = "wme-pr2-acceptance-bootstrap-" + allocation;
const files = join(root, "workspaces"),
  sessions = join(root, "sessions"),
  journal = join(root, "journal");
const workspace = join(files, "projects", projectId, "files"),
  library = join(files, "organizations", organizationId, "files");
const ledger = {
  allocation,
  root,
  projectId,
  gateway,
  bootstrap,
  image,
  gatewayId: null,
  bootstrapId: null,
};
const save = () =>
  writeFile(join(root, "allocation.json"), JSON.stringify(ledger, null, 2), {
    mode: 0o600,
  });
for (const path of [workspace, library, sessions, journal])
  await mkdir(path, {
    recursive: true,
    mode: 0o750,
  });
// These are new synthetic directories, never a recursive ownership change.
for (const path of [workspace, library]) {
  await chown(path, 10001, 10001);
  await chmod(path, 0o750);
}
await writeFile(join(workspace, "original.txt"), "workspace fixture", {
  mode: 0o644,
});
await writeFile(join(library, "reference.txt"), "library fixture", {
  mode: 0o644,
});
for (const path of [
  join(workspace, "original.txt"),
  join(library, "reference.txt"),
]) {
  await chown(path, 10001, 10001);
  await chmod(path, 0o644);
}
await mkdir(join(workspace, "Shared"), {
  mode: 0o755,
});
const fixture = await readFile(
  new URL("./protocol-fixture.mjs", import.meta.url),
  "utf8",
);
await writeFile(join(root, "gateway.cjs"), fixture, {
  mode: 0o644,
});
await chmod(join(root, "gateway.cjs"), 0o644);
const options = {
  image,
  network: "wme-pr2-acceptance",
  networkPool: process.env.WME_ACCEPTANCE_NETWORK_POOL ?? "10.253.240.0/24",
  gatewayContainer: gateway,
  storageRoots: [files],
  sessionRoot: sessions,
  journalRoot: journal,
  gatewayOrigins: ["http://api:4100"],
  egressProxyOrigins: ["http://api:4101"],
  appArmorProfile: "wme-platform-agent",
};
const runtime = new ProjectDockerRuntime(options);
const spec = {
  projectId,
  organizationId,
  hostId: "local",
  egressProxyUrl: "http://api:4101",
  egressToken: "wme_schedule_" + "s".repeat(43),
  scheduleEnabled: true,
  scheduleMounts: [
    {
      source: library,
      target: "/workspace/Shared",
      access: "read",
    },
  ],
};
await save();
let complete = false;
const hostListeners = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForFile(
  name,
  test = (value) => Boolean(value),
  seconds = 45,
) {
  for (let i = 0; i < seconds * 5; i++) {
    try {
      const value = await readFile(join(workspace, name), "utf8");
      if (test(value)) return value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await pause(200);
  }
  throw new Error("Timed out waiting for synthetic workspace result: " + name);
}
async function trustedProbe(program) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        "0:0",
        "wme-project-" + projectId,
        "node",
        "--input-type=module",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "",
      error = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      error = (error + data).slice(-8192);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolveProbe(output)
        : reject(new Error("Trusted fixture probe failed: " + error));
    });
    child.stdin.end(program);
  });
}
const documentProbe = `
from pathlib import Path
from docx import Document
from openpyxl import Workbook, load_workbook
from pypdf import PdfReader, PdfWriter
root=Path('/workspace/documents');root.mkdir(exist_ok=True)
d=Document();d.add_paragraph('Durable document');d.save(root/'sample.docx')
assert Document(root/'sample.docx').paragraphs[0].text=='Durable document'
w=Workbook();w.active['A1']='Durable spreadsheet';w.save(root/'sample.xlsx')
assert load_workbook(root/'sample.xlsx').active['A1'].value=='Durable spreadsheet'
p=PdfWriter();p.add_blank_page(width=612,height=792);p.add_metadata({'/Title':'Durable PDF'});p.write(root/'sample.pdf')
assert PdfReader(root/'sample.pdf').metadata.title=='Durable PDF'
`;
async function request(
  harness = "pi",
  mode = "read",
  thread = harness,
  model = "synthetic-acceptance-model",
) {
  const sessionDirectory = join(
    sessions,
    organizationId,
    projectId,
    "sessions",
    thread,
    harness,
    mode,
  );
  await mkdir(sessionDirectory, {
    recursive: true,
    mode: 0o700,
  });
  return {
    runId: randomUUID(),
    organizationId,
    projectId,
    conversationId: thread,
    generation: 0,
    userId: "synthetic-user",
    harness,
    model,
    pi: {
      provider: "openai",
      api: "openai-responses",
      supportsReasoning: true,
      supportsNativeCompaction: true,
      thinking: "high",
      codeMode: "off",
      subagentConcurrency: 3,
      routeIdentity: "synthetic-openai:" + model,
    },
    prompt: "Reply SYNTHETIC_RUNTIME_ACCEPTANCE",
    access: mode,
    mounts: [
      {
        source: workspace,
        target: "/workspace",
        access: mode,
      },
      {
        source: library,
        target: "/workspace/Shared",
        access: "read",
      },
    ],
    sessionDirectory,
    gateway: {
      baseUrl: `http://api:4100/enterprise/api/runtime/inference/${projectId}`,
      token: "synthetic-scoped-fixture-key",
    },
  };
}
async function native(input, answer = "SYNTHETIC_RUNTIME_ACCEPTANCE") {
  const events = [];
  await runtime.execute(
    input,
    (event) => events.push(event),
    AbortSignal.timeout(45000),
  );
  assert.equal(events.at(-1)?.type, "completed", JSON.stringify(events));
  assert.ok(
    events.some((e) => e.type === "input_accepted"),
    "Missing actual input receipt",
  );
  if (input.pi) {
    const options = events
      .filter((e) => e.type === "native_update")
      .flatMap((e) => e.update.configOptions ?? []);
    assert.ok(
      options.some(
        (o) => o.id === "model" && o.currentValue === "openai/" + input.model,
      ),
      "Pi provider route was dropped at the container boundary",
    );
    assert.ok(
      options.some(
        (o) => o.id === "thinking" && o.currentValue === input.pi.thinking,
      ),
      "Pi thinking preference was dropped at the container boundary",
    );
  }
  assert.equal(
    events
      .filter((e) => e.type === "assistant_delta")
      .map((e) => e.delta)
      .join(""),
    answer,
  );
  return events.find((e) => e.type === "native_session")?.sessionId;
}
async function workspaceStatus() {
  return JSON.parse(
    await trustedProbe(
      `import {connect} from 'node:net';const s=connect('/control/runtime.sock');s.on('connect',()=>s.write(JSON.stringify({operation:'status'})+'\\n'));s.on('data',b=>process.stdout.write(b));s.on('end',()=>s.destroy());`,
    ),
  );
}
// This test launcher imports exactly the production descriptor preparation and
// argument builder. Its probe replaces only the final trusted Node program,
// after the unchanged AppArmor transition and mandatory restriction helper.
function verifyOutsideUid(fs, assert, childPid, innerPid) {
  const rows = fs
    .readdirSync("/proc")
    .filter((p) => /^\d+$/.test(p))
    .flatMap((p) => {
      try {
        return [
          {
            id: Number(p),
            status: fs.readFileSync("/proc/" + p + "/status", "utf8"),
          },
        ];
      } catch {
        return [];
      }
    });
  const descendants = new Set([childPid]);
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) {
      const parent = Number(/^PPid:\s+(\d+)/m.exec(row.status)?.[1]);
      if (descendants.has(parent) && !descendants.has(row.id)) {
        descendants.add(row.id);
        added = true;
      }
    }
  }
  const owned = rows.filter((row) => descendants.has(row.id));
  assert.ok(
    owned.some((row) => {
      const ids =
        /^NSpid:\s+(.+)$/m
          .exec(row.status)?.[1]
          .trim()
          .split(/\s+/)
          .map(Number) ?? [];
      return ids.length > 1 && ids.at(-1) === innerPid;
    }),
    "Agent PID must be a descendant in a nested PID namespace",
  );
  for (const row of owned)
    assert.match(row.status, /^Uid:\s+10001\s+10001\s+10001\s+10001$/m);
}
async function verifyOwnChildSignal(fs, assert, spawn) {
  // Native tools need ordinary same-namespace child cleanup and signal-based deadlines.
  // A denied signal is harmless: this synthetic child expires naturally after one second.
  const child = spawn("/bin/sleep", ["1"]);
  let error = null;
  child.on("error", (cause) => {
    error = cause.code;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const sent = child.kill("SIGTERM");
  await closed;
  const result = {
    uid: process.getuid(),
    label: fs.readFileSync("/proc/self/attr/current", "utf8").trim(),
    sent,
    error,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
  };
  console.log("OWN_CHILD_SIGNAL " + JSON.stringify(result));
  assert.equal(error, null, "Native child cleanup: " + JSON.stringify(result));
  assert.equal(sent, true);
  assert.equal(child.signalCode, "SIGTERM");
}
function probe(mode, thread, program) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        "0:0",
        "wme-project-" + projectId,
        "node",
        "--input-type=module",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "",
      error = "";
    child.stdout.on("data", (data) => {
      output += data;
      if (output.length > 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (data) => {
      error = (error + data).slice(-8192);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolveProbe(output)
        : reject(new Error(`Boundary probe failed (${code}): ${error}`));
    });
    const outer = `import fs from 'node:fs';import assert from 'node:assert/strict';import {prepareSandbox} from '/opt/runtime/src/execution-sandbox.js';import {mkdir,chmod,chown} from 'node:fs/promises';import {spawn} from 'node:child_process';import {once} from 'node:events';
const broker='/control/probe-${randomUUID()}';await mkdir(broker,{mode:0o750});await chmod(broker,0o750);await chown(broker,0,10001);
const boundary=await prepareSandbox(${JSON.stringify("sessions/" + thread + "/pi/" + mode)},${JSON.stringify(mode)},[{source:'/library/',target:'/workspace/Shared',access:'read'}],broker);
const args=boundary.args;args.splice(-1,1,'--input-type=module','-e',${JSON.stringify(program)});
const verify=${verifyOutsideUid.toString()};const child=spawn('bwrap',args,{uid:10001,gid:10001,stdio:['ignore','pipe','inherit',...boundary.fds]});let observed='',checked=false;child.stdout.on('data',data=>{process.stdout.write(data);observed+=data;const marker=observed.split(String.fromCharCode(10)).find(line=>line.startsWith('WME_AGENT_PID:'));if(marker&&!checked){verify(fs,assert,child.pid,Number(marker.slice(14)));checked=true;}});const [code]=await once(child,'close');await boundary.close();assert.ok(checked,'Outer namespace must verify actual kernel UID10001');process.exitCode=code;
`;
    child.stdin.end(outer);
  });
}
const commonProbe = `import assert from 'node:assert/strict';import fs from 'node:fs';import {execFileSync} from 'node:child_process';import {Worker} from 'node:worker_threads';import * as requireNet from 'node:net';import {assertIsolation} from '/opt/runtime/src/process-boundary.js';await assertIsolation();
console.log('WME_AGENT_PID:'+process.pid);await new Promise(r=>setTimeout(r,200));\n// Bubblewrap may use an intermediate user namespace mapping UID10001 through UID0; the trusted parent independently checks every final namespace PID has outside UID10001.\nassert.match(fs.readFileSync('/proc/self/uid_map','utf8'),/10001\\s+(?:0|10001)\\s+1/);
assert.equal(fs.readFileSync('/workspace/original.txt','utf8'),'workspace fixture');assert.equal(fs.readFileSync('/workspace/Shared/reference.txt','utf8'),'library fixture');
for(const p of ['/control','/state','/project','/library','/var/run/docker.sock'])assert.throws(()=>fs.lstatSync(p));
for(const p of ['/proc/kcore','/proc/keys','/proc/timer_list'])assert.throws(()=>fs.readFileSync(p));
for(const label of ['wme-project-supervisor','wme-platform-agent','unconfined'])assert.throws(()=>execFileSync('aa-exec',['-p',label,'--','true']));
assert.throws(()=>fs.writeFileSync('/workspace/Shared/reference.txt','changed'));assert.throws(()=>fs.writeFileSync('/etc/escape','x'));assert.throws(()=>execFileSync('mount',['-o','remount,rw','/workspace/Shared']));
const python='import ctypes,errno\\nlibc=ctypes.CDLL(None,use_errno=True)\\nfor flags in [0x20000,0x4000000,0x8000000,0x10000000,0x20000000,0x40000000,0x2000000,0x80]:\\n ctypes.set_errno(0);assert libc.syscall(56,flags|17,0,0,0,0)==-1 and ctypes.get_errno()==errno.EPERM\\nctypes.set_errno(0);assert libc.syscall(435,0,0)==-1 and ctypes.get_errno()==errno.ENOSYS\\nctypes.set_errno(0);assert libc.syscall(272,0x10000000)==-1 and ctypes.get_errno()==errno.EPERM';execFileSync('python3',['-c',python]);
await new Promise((resolve,reject)=>{const w=new Worker('require("worker_threads").parentPort.postMessage("thread okay")',{eval:true,execArgv:[]});w.once('message',resolve);w.once('error',reject);});
await (${verifyOwnChildSignal.toString()})(fs,assert,(await import('node:child_process')).spawn);
assert.equal(fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).length<12,true);assert.throws(()=>fs.readFileSync('/session/../../state/sessions/sibling/pi/write/private'));
for(const target of directTargets)await new Promise((resolve,reject)=>{const s=requireNet.connect({host:target.host,port:target.port});s.setTimeout(500,()=>s.destroy(new Error('blocked')));s.on('error',()=>resolve());s.on('connect',()=>{s.destroy();reject(Error('Direct network escaped namespace: '+target.kind));});});
`;
try {
  await createIsolatedNetwork(
    {
      name: bootstrap,
      pool: options.networkPool,
      bridgeName: "wme-a" + allocation.slice(0, 8),
      labels: { "com.wovenmatter.enterprise.acceptance": allocation },
    },
    (args) => docker(...args),
  );
  ledger.bootstrapId = JSON.parse(
    await docker("network", "inspect", bootstrap),
  )[0].Id;
  await save();
  ledger.gatewayId = await docker(
    "run",
    "-d",
    "--name",
    gateway,
    "--label",
    "com.wovenmatter.enterprise.acceptance=" + allocation,
    "--network",
    bootstrap,
    "--read-only",
    "--user",
    "10001:10001",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--mount",
    `type=bind,src=${join(root, "gateway.cjs")},dst=/fixture.cjs,readonly`,
    "--entrypoint",
    "node",
    image,
    "/fixture.cjs",
  );
  await save();
  await runtime.ensureProject(spec);
  const container = JSON.parse(
    await docker("inspect", "wme-project-" + projectId),
  )[0];
  await writeFile(
    join(root, "hostconfig.json"),
    JSON.stringify(container.HostConfig, null, 2),
  );
  assert.equal(container.State.Running, true);
  const gatewayDetail = JSON.parse(
    await docker("inspect", ledger.gatewayId),
  )[0];
  assert.equal(
    gatewayDetail.State.Running,
    true,
    "Synthetic gateway must be running",
  );
  const network = JSON.parse(
    await docker("network", "inspect", container.HostConfig.NetworkMode),
  )[0];
  const targets = boundaryTargets(network, gatewayDetail, networkInterfaces());
  const directTargets = [{ kind: "peer", host: targets.peer, port: 4100 }];
  for (const host of targets.hosts) {
    // A live listener on the actual fixture bridge prevents a closed host port
    // from masquerading as isolation. No wildcard/production interface binding.
    const server = createServer((socket) => socket.end());
    hostListeners.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port: 0 }, resolve);
    });
    directTargets.push({ kind: "host", host, port: server.address().port });
  }
  await writeFile(
    join(root, "network-targets.json"),
    JSON.stringify(
      {
        ...targets.diagnostics,
        directTargets,
      },
      null,
      2,
    ),
  );
  console.log(
    "Actual boundary targets " +
      JSON.stringify({
        bridge: targets.diagnostics.network.bridge,
        ipam: network.IPAM?.Config,
        targets: directTargets,
      }),
  );
  // Positive controls from the trusted project network must reach the same
  // peer/host endpoints that the inner agent namespaces must not reach.
  await trustedProbe(`import {connect} from 'node:net';
for(const target of ${JSON.stringify(directTargets)}){
 let connected=false,last;for(let attempt=0;attempt<5&&!connected;attempt++){
  try{await new Promise((resolve,reject)=>{const s=connect(target.port,target.host);s.setTimeout(1000,()=>s.destroy(new Error('Positive control timed out')));s.once('error',reject);s.once('connect',()=>{s.destroy();resolve();});});connected=true;}
  catch(error){last=error;await new Promise(resolve=>setTimeout(resolve,100));}
 }if(!connected)throw new Error('Boundary positive control failed: '+JSON.stringify(target)+' '+last?.message);
}console.log('PEER_AND_HOST_POSITIVE_CONTROLS_OK');`);
  console.log("Actual peer and host listener positive controls passed.");
  directTargets.push(
    { kind: "public", host: "1.1.1.1", port: 4100 },
    { kind: "metadata", host: "169.254.169.254", port: 4100 },
  );
  const boundary =
    `const directTargets=${JSON.stringify(directTargets)};` + commonProbe;
  const sibling = join(
    sessions,
    organizationId,
    projectId,
    "sessions/sibling/pi/write",
  );
  await mkdir(sibling, {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(join(sibling, "private"), "known sibling session sentinel");
  await trustedProbe(`import assert from 'node:assert/strict';import {mkdir,writeFile,rename,symlink,readFile,stat} from 'node:fs/promises';import {openDirectory} from '/opt/runtime/src/sandbox.js';import {pinSandbox} from '/opt/runtime/src/pinned-sandbox.js';
const path='/project/files/pin-source';await mkdir(path);await writeFile(path+'/sentinel','validated inode');const handle=await openDirectory('/project/files','pin-source');const before=await handle.stat();await rename(path,path+'-held');await mkdir(path+'-attacker');await writeFile(path+'-attacker/sentinel','replaced source');await symlink(path+'-attacker',path);const pinned=await pinSandbox([handle]);try{assert.equal(await readFile(pinned.sources[0]+'/sentinel','utf8'),'validated inode');assert.equal((await stat(pinned.sources[0])).ino,before.ino);}finally{await pinned.close();await handle.close();}console.log('ACTUAL_DESCRIPTOR_PIN_RACE_OK');`);
  await Promise.all([
    probe(
      "read",
      "reader",
      boundary +
        `assert.throws(()=>fs.writeFileSync('/workspace/read-write-test','x'));assert.throws(()=>fs.symlinkSync('/workspace/Shared/reference.txt','/workspace/link'));fs.writeFileSync('/session/private','reader state');console.log('READ_BOUNDARY_OK');`,
    ),
    probe(
      "write",
      "writer",
      boundary +
        `assert.throws(()=>fs.linkSync('/workspace/Shared/reference.txt','/workspace/hard-link'));fs.writeFileSync('/workspace/full-write-test','shared edit');fs.writeFileSync('/session/private','writer state');execFileSync('python3',['-c',${JSON.stringify(documentProbe)}]);await new Promise(r=>setTimeout(r,100));console.log('FULL_BOUNDARY_OK');`,
    ),
  ]);
  assert.equal(
    await readFile(join(workspace, "full-write-test"), "utf8"),
    "shared edit",
  );
  const nativeIds = new Map();
  for (const harness of ["pi"]) {
    const input = await request(harness),
      nativeId = await native(input);
    assert.ok(nativeId);
    nativeIds.set(harness, nativeId);
    const environment = (await workspaceStatus()).sessions.find(
      (s) => s.conversationId === input.conversationId,
    );
    assert.ok(environment.processId);
    await native({
      ...input,
      runId: randomUUID(),
      resumeId: nativeId,
    });
    assert.equal(
      (await workspaceStatus()).sessions.find(
        (s) => s.conversationId === input.conversationId,
      ).processId,
      environment.processId,
      "Ordinary turn completion recreated the thread environment",
    );
    const toolInput = await request(
      harness,
      "write",
      harness + "-tools",
      "synthetic-proxy-" + harness,
    );
    toolInput.egressProxyUrl = "http://api:4101";
    await native(toolInput, "PROXY_TOOL_VERIFIED");
    console.log(
      harness +
        " actual installed native turn and durable resume passed against synthetic gateway",
    );
  }
  const backgrounds = await Promise.all(
    ["pi-a", "pi-b"].map((name) =>
      request(
        "pi",
        "write",
        "background-" + name,
        "synthetic-background-" + name,
      ),
    ),
  );
  await Promise.all(
    backgrounds.map((input) => native(input, "BACKGROUND_WORK_STARTED")),
  );
  const before = await Promise.all(
    backgrounds.map((input) => waitForFile(input.conversationId)),
  );
  await pause(700);
  for (const [index, input] of backgrounds.entries())
    assert.notEqual(
      await readFile(join(workspace, input.conversationId), "utf8"),
      before[index],
      "Background work died after ordinary turn completion",
    );
  await runtime.stopSession(projectId, backgrounds[0].conversationId, 1);
  const firstStopped = await readFile(
    join(workspace, backgrounds[0].conversationId),
    "utf8",
  );
  const peerBefore = await readFile(
    join(workspace, backgrounds[1].conversationId),
    "utf8",
  );
  await pause(700);
  assert.equal(
    await readFile(join(workspace, backgrounds[0].conversationId), "utf8"),
    firstStopped,
  );
  assert.notEqual(
    await readFile(join(workspace, backgrounds[1].conversationId), "utf8"),
    peerBefore,
    "Stopping one Pi session must preserve sibling background work",
  );
  const resume = await request("pi", "read", "pi");
  await runtime.stopSession(projectId, "pi", 1);
  await native({ ...resume, generation: 1, resumeId: nativeIds.get("pi") });
  const held = await Promise.all([
    request("pi", "write", "cancel-a", "synthetic-hold-a"),
    request("pi", "write", "cancel-b", "synthetic-hold-b"),
  ]);
  const observers = held.map(() => new AbortController());
  const observed = [[], []];
  const running = held.map((input, index) =>
    runtime
      .execute(
        input,
        (event) => observed[index].push(event),
        observers[index].signal,
      )
      .then(
        () => null,
        (error) => error,
      ),
  );
  await Promise.all([waitForFile("descendant-a"), waitForFile("descendant-b")]);
  observers[1].abort();
  await running[1];
  const detachedBefore = await readFile(
    join(workspace, "descendant-b"),
    "utf8",
  );
  await pause(700);
  assert.notEqual(
    await readFile(join(workspace, "descendant-b"), "utf8"),
    detachedBefore,
    "Observer disconnect cancelled work",
  );
  const reattachedRuntime = new ProjectDockerRuntime(options);
  let connected;
  const connection = new Promise((resolve) => {
    connected = resolve;
  });
  const after =
    observed[1].filter((event) => event.sequence).at(-1)?.sequence ?? 0;
  const reattached = reattachedRuntime.attach(held[1].runId, after, (event) => {
    if (event.type === "attached") connected();
  });
  await connection;
  await reattachedRuntime.steer(held[1].runId, {
    id: randomUUID(),
    sequence: 2,
    authorId: "synthetic-colleague",
    authorName: "Synthetic colleague",
    content: "Keep the current workspace task active until cancellation.",
  });
  await runtime.cancel(held[0].runId);
  await running[0];
  const stopped = await readFile(join(workspace, "descendant-a"), "utf8"),
    siblingBefore = await readFile(join(workspace, "descendant-b"), "utf8");
  await pause(700);
  assert.equal(
    await readFile(join(workspace, "descendant-a"), "utf8"),
    stopped,
    "Cancelled descendant kept running",
  );
  assert.notEqual(
    await readFile(join(workspace, "descendant-b"), "utf8"),
    siblingBefore,
    "Cancelling one thread stopped its sibling",
  );
  await runtime.cancel(held[1].runId);
  await reattached;
  assert.equal(
    JSON.parse(await docker("inspect", container.Id))[0].State.Running,
    true,
  );
  const interruptedInput = await request(
    "pi",
    "write",
    "restart-interruption",
    "synthetic-hold-a",
  );
  const oldResult = await readFile(join(workspace, "descendant-a"), "utf8");
  const interrupted = runtime
    .execute(interruptedInput, () => {})
    .catch((error) => error);
  await waitForFile("descendant-a", (value) => value !== oldResult);
  await docker("restart", container.Id);
  await interrupted;
  await runtime.ensureProject(spec);
  const recovered = [];
  await new ProjectDockerRuntime(options).attach(
    interruptedInput.runId,
    0,
    (event) => recovered.push(event),
  );
  assert.equal(recovered.at(-1)?.code, "workspace_restarted");
  const stoppedByRestart = await readFile(
    join(workspace, backgrounds[1].conversationId),
    "utf8",
  );
  await pause(700);
  assert.equal(
    await readFile(join(workspace, backgrounds[1].conversationId), "utf8"),
    stoppedByRestart,
    "Restart unexpectedly replayed background work",
  );
  assert.equal(
    await readFile(join(workspace, "full-write-test"), "utf8"),
    "shared edit",
  );
  assert.equal(
    await readFile(
      join(
        sessions,
        organizationId,
        projectId,
        "sessions/writer/pi/write/private",
      ),
      "utf8",
    ),
    "writer state",
  );
  await mkdir(join(workspace, ".wme/schedules"), {
    recursive: true,
  });
  await writeFile(
    join(workspace, "scheduled.sh"),
    "#!/bin/sh\ncat /workspace/Shared/reference.txt > /workspace/scheduled-result\nif printf nope > /workspace/Shared/reference.txt; then exit 1; fi\nprintf done >> /workspace/scheduled-result\nwhile true; do date +%s%N > /workspace/schedule-heartbeat; sleep 0.2; done\n",
  );
  await writeFile(
    join(workspace, ".wme/schedules/read-share.json"),
    JSON.stringify({
      everyMinutes: 60,
      script: "scheduled.sh",
      args: [],
    }),
  );
  await chmod(join(workspace, "scheduled.sh"), 0o644);
  await chmod(join(workspace, ".wme/schedules/read-share.json"), 0o644);
  assert.equal(
    await waitForFile("scheduled-result", (value) => value.endsWith("done")),
    "library fixturedone",
  );
  await waitForFile("schedule-heartbeat");
  await runtime.updateProject({
    ...spec,
    scheduleMounts: [],
  });
  const lastHeartbeat = await readFile(
    join(workspace, "schedule-heartbeat"),
    "utf8",
  );
  await pause(700);
  assert.equal(
    await readFile(join(workspace, "schedule-heartbeat"), "utf8"),
    lastHeartbeat,
    "Revoked schedule kept running",
  );
  await writeFile(
    join(workspace, "revoked.sh"),
    "#!/bin/sh\nif cat /workspace/Shared/reference.txt >/dev/null 2>&1; then printf leaked > /workspace/revoked-result; else printf denied > /workspace/revoked-result; fi\n",
  );
  await writeFile(
    join(workspace, ".wme/schedules/revoked.json"),
    JSON.stringify({
      everyMinutes: 60,
      script: "revoked.sh",
      args: [],
    }),
  );
  await chmod(join(workspace, "revoked.sh"), 0o644);
  await chmod(join(workspace, ".wme/schedules/revoked.json"), 0o644);
  assert.equal(await waitForFile("revoked-result"), "denied");
  await docker("restart", container.Id);
  await runtime.ensureProject({
    ...spec,
    scheduleMounts: [],
  });
  await pause(32000);
  assert.equal(
    await readFile(join(workspace, "schedule-heartbeat"), "utf8"),
    lastHeartbeat,
    "Persisted admission receipt replayed after restart",
  );
  assert.equal(
    JSON.parse(await docker("inspect", container.Id))[0].State.Running,
    true,
  );
  await runtime.stopProject(spec);
  assert.equal(
    JSON.parse(await docker("inspect", container.Id))[0].State.Running,
    false,
  );
  await runtime.restoreProject(spec);
  assert.equal(
    await readFile(join(workspace, "full-write-test"), "utf8"),
    "shared edit",
  );
  complete = true;
  console.log(
    "Persistent runtime boundary, native protocols, shared workspace, restart and scheduled read-only share acceptance passed.",
  );
} finally {
  await Promise.all(
    hostListeners.map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(
      {
        passed: complete,
        allocation,
        liveProviderAcceptance: false,
      },
      null,
      2,
    ),
  );
  if (complete) {
    await runtime.stopProject(spec);
    await runtime.purgeProject(spec);
    const c = JSON.parse(await docker("inspect", ledger.gatewayId))[0];
    assert.equal(
      c.Config.Labels["com.wovenmatter.enterprise.acceptance"],
      allocation,
    );
    await docker("rm", "--force", c.Id);
    const n = JSON.parse(
      await docker("network", "inspect", ledger.bootstrapId),
    )[0];
    assert.equal(n.Labels["com.wovenmatter.enterprise.acceptance"], allocation);
    await docker("network", "rm", n.Id);
    for (const dir of [files, sessions, journal]) {
      const name = storageVolumeName(dir),
        volume = JSON.parse(await docker("volume", "inspect", name))[0];
      assert.equal(volume.Options.device, dir);
      assert.equal(volume.Labels["com.wovenmatter.enterprise.storage"], "true");
      await docker("volume", "rm", name);
    }
  } else
    console.error(
      "Failed fixture retained for exact-allocation inspection; see the private acceptance evidence directory.",
    );
}
