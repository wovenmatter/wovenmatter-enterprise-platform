// Real Linux isolation/protocol acceptance, with synthetic data and no upstream authentication.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  lstat,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createFixtureCleanup } from "./fixture-cleanup.mjs";
import {
  storageVolumeName,
  volumeMount,
} from "../packages/runtime/src/volumes.ts";
const exec = promisify(execFile);
if (
  process.platform !== "linux" ||
  process.env.WME_RUN_CONTAINER_ACCEPTANCE !== "1"
)
  throw new Error("Linux explicit container acceptance only");
const image = process.env.WME_AGENT_IMAGE;
if (!image) throw new Error("WME_AGENT_IMAGE is required");
const id = `wme-accept-${process.pid}-${Date.now()}`;
const root = await mkdtemp(join(tmpdir(), id));
const cleanupFixture = await createFixtureCleanup(root, id);
const containers = [],
  networks = [],
  volumes = [],
  firewallRules = [];
const docker = async (args) =>
  (
    await exec("docker", args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  ).stdout.trim();
const iptables = async (args) =>
  exec(
    process.getuid() === 0 ? "iptables" : "sudo",
    process.getuid() === 0 ? args : ["iptables", ...args],
    { timeout: 15000 },
  );
const common = [
  "--read-only",
  "--user",
  "10001:10001",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
  "--security-opt",
  "apparmor=wme-platform-agent",
  "--pids-limit",
  "128",
  "--memory",
  "1g",
  "--cpus",
  "1",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,size=128m,mode=1777",
  "--tmpfs",
  "/home/agent:rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700",
];
async function runProbe(network, mounts, script) {
  const name = `${id}-probe-${containers.length}`;
  containers.push(name);
  return docker([
    "run",
    "--rm",
    "--name",
    name,
    ...common,
    "--network",
    network,
    ...mounts.flatMap((m) => ["--mount", m]),
    "--entrypoint",
    "node",
    image,
    "-e",
    script,
  ]);
}
try {
  for (const dir of ["project", "shared", "secret", "sessions"]) {
    await mkdir(join(root, dir));
    await chmod(join(root, dir), 0o777);
  }
  await mkdir(join(root, "project", "Shared"));
  await writeFile(join(root, "project", "original.txt"), "fixture");
  await writeFile(join(root, "shared", "reference.txt"), "shared-fixture");
  await writeFile(
    join(root, "secret", "control-plane-key"),
    "never-mounted-fixture",
  );
  const storage = storageVolumeName(root);
  await docker([
    "volume",
    "create",
    "--driver",
    "local",
    "--opt",
    "type=none",
    "--opt",
    "o=bind",
    "--opt",
    `device=${root}`,
    storage,
  ]);
  volumes.push(storage);
  const a = `${id}-a`,
    b = `${id}-b`,
    gateway = `${id}-gateway`,
    peer = `${id}-peer`;
  for (const net of [a, b]) {
    const bridge =
      "br-wmerun" + createHash("sha256").update(net).digest("hex").slice(0, 6);
    await docker([
      "network",
      "create",
      "--internal",
      "--subnet",
      net === a ? "10.252.0.0/28" : "10.252.0.16/28",
      "--opt",
      "com.docker.network.bridge.name=" + bridge,
      net,
    ]);
    networks.push(net);
    const rule = [
      "INPUT",
      "-i",
      bridge,
      "-m",
      "conntrack",
      "--ctstate",
      "NEW",
      "-j",
      "REJECT",
    ];
    await iptables(["-I", ...rule]);
    firewallRules.push(rule);
  }
  await docker([
    "run",
    "-d",
    "--name",
    gateway,
    ...common,
    "--network",
    a,
    "--network-alias",
    "api",
    "--entrypoint",
    "node",
    image,
    "-e",
    await readFile(new URL("./protocol-fixture.mjs", import.meta.url), "utf8"),
  ]);
  containers.push(gateway);
  await docker(["network", "connect", "--alias", "api", b, gateway]);
  const readMounts = [
    `type=volume,src=${storage},dst=/workspace,volume-subpath=project,volume-nocopy,readonly`,
    `type=volume,src=${storage},dst=/workspace/Shared,volume-subpath=shared,volume-nocopy,readonly`,
  ];
  const probe = `const fs=require('fs'),assert=require('assert/strict');assert.equal(process.getuid(),10001);const status=fs.readFileSync('/proc/self/status','utf8');assert.match(status,/NoNewPrivs:\\s+1/);assert.match(status,/Seccomp:\\s+2/);assert.match(status,/CapEff:\\s+0+\\n/);assert.match(fs.readFileSync('/proc/self/attr/current','utf8'),/^wme-platform-agent \\(enforce\\)/);assert.equal(fs.readFileSync('/workspace/original.txt','utf8'),'fixture');assert.throws(()=>fs.writeFileSync('/workspace/no.txt','x'));assert.throws(()=>fs.writeFileSync('/workspace/Shared/no.txt','x'));assert.throws(()=>fs.readFileSync('/var/run/docker.sock'));assert.throws(()=>fs.readFileSync(${JSON.stringify(join(root, "secret", "control-plane-key"))}));assert.throws(()=>fs.writeFileSync('/etc/escape','x'));fs.writeFileSync('/tmp/allowed','x');console.log('read-only and kernel boundaries passed')`;
  console.log(await runProbe(a, readMounts, probe));
  const fullMounts = [
    `type=volume,src=${storage},dst=/workspace,volume-subpath=project,volume-nocopy`,
    readMounts[1],
  ];
  console.log(
    await runProbe(
      a,
      fullMounts,
      `const fs=require('fs'),assert=require('assert/strict');fs.writeFileSync('/workspace/writable.txt','okay');assert.throws(()=>fs.writeFileSync('/workspace/Shared/no.txt','x'));console.log('write access and shared ceiling passed')`,
    ),
  );
  const ordinaryName = 'Résumé, "Q4" (2026)';
  await mkdir(join(root, ordinaryName));
  await chmod(join(root, ordinaryName), 0o755);
  await mkdir(join(root, "project", ordinaryName));
  await writeFile(
    join(root, ordinaryName, "reference.txt"),
    "punctuation fixture",
  );
  console.log(
    await runProbe(
      a,
      [
        readMounts[0],
        volumeMount(
          join(root, ordinaryName),
          `/workspace/${ordinaryName}`,
          [root],
          true,
        ),
      ],
      `const fs=require('fs'),assert=require('assert/strict');
    assert.equal(fs.readFileSync(${JSON.stringify(`/workspace/${ordinaryName}/reference.txt`)},'utf8'),'punctuation fixture');
    assert.throws(()=>fs.writeFileSync(${JSON.stringify(`/workspace/${ordinaryName}/reference.txt`)},'changed'));
    console.log('Unicode and CSV punctuation share mounts passed')`,
    ),
  );
  // A source swapped after authorization to an in-volume sibling must fail the
  // trusted launcher's inode gate; volume-subpath alone permits in-volume symlinks.
  const before = await lstat(join(root, "shared"), { bigint: true });
  const evidence = [
    {
      target: "/workspace/Shared",
      device: String(before.dev),
      inode: String(before.ino),
      kind: "directory",
    },
  ];
  await rename(join(root, "shared"), join(root, "shared-original"));
  await symlink("secret", join(root, "shared"));
  console.log(
    await runProbe(
      a,
      readMounts,
      `(async()=>{const {verifyMountEvidence}=await import('/opt/runtime/src/mount-evidence.js');await require('assert/strict').rejects(verifyMountEvidence(${JSON.stringify(evidence)}),/changed during admission/);console.log('swapped source inode admission rejected')})().catch(e=>{console.error(e);process.exit(1)})`,
    ),
  );
  await rm(join(root, "shared"));
  await symlink("/etc", join(root, "shared"));
  await assert.rejects(
    runProbe(a, readMounts, `throw new Error('Host escape must never launch')`),
  );
  await rm(join(root, "shared"));
  await rename(join(root, "shared-original"), join(root, "shared"));
  await docker([
    "run",
    "-d",
    "--name",
    peer,
    ...common,
    "--network",
    a,
    "--entrypoint",
    "node",
    image,
    "-e",
    `require('http').createServer((q,s)=>s.end('private')).listen(8009,'0.0.0.0')`,
  ]);
  containers.push(peer);
  const peerIp = await docker([
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks "${a}").IPAddress}}`,
    peer,
  ]);
  const bridgeGateway = await docker([
    "network",
    "inspect",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
    b,
  ]);
  console.log(
    await runProbe(
      b,
      [],
      `(async()=>{const assert=require('assert/strict');assert.equal(await(await fetch('http://api:4100',{signal:AbortSignal.timeout(5000)})).text(),'gateway-fixture');await assert.rejects(fetch('http://${peerIp}:8009',{signal:AbortSignal.timeout(1500)}));await assert.rejects(fetch('http://${bridgeGateway}:22',{signal:AbortSignal.timeout(1500)}));await assert.rejects(fetch('https://example.com',{signal:AbortSignal.timeout(1500)}));console.log('gateway-only, host denial and cross-project exclusion passed')})().catch(e=>{console.error(e);process.exit(1)})`,
    ),
  );
  await writeFile(
    join(root, "project", "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  );
  await writeFile(
    join(root, "project", "main.tsx"),
    `import React from 'react';import {createRoot} from 'react-dom/client';createRoot(document.getElementById('root')!).render(<h1>Offline dashboard</h1>);`,
  );
  const documentSmoke = `from pathlib import Path
from tempfile import TemporaryDirectory
from pypdf import PdfWriter, PdfReader
from docx import Document
from openpyxl import Workbook, load_workbook
with TemporaryDirectory(prefix="wme-readers-", dir="/tmp") as directory:
    root = Path(directory)
    pdf = root / "fixture.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(str(pdf))
    assert len(PdfReader(str(pdf)).pages) == 1
    word = root / "fixture.docx"
    document = Document()
    document.add_paragraph("Document reader fixture")
    document.save(str(word))
    assert Document(str(word)).paragraphs[0].text == "Document reader fixture"
    sheet = root / "fixture.xlsx"
    workbook = Workbook()
    workbook.active["A1"] = "Spreadsheet reader fixture"
    workbook.save(str(sheet))
    workbook.close()
    reopened = load_workbook(str(sheet), read_only=True)
    assert reopened.active["A1"].value == "Spreadsheet reader fixture"
    reopened.close()
print("PDF, Word, and spreadsheet write/read smoke passed")`;
  console.log(
    await runProbe(
      b,
      fullMounts,
      `const {execFileSync}=require('child_process');const fs=require('fs');execFileSync('wme-build',['/workspace'],{stdio:'inherit'});if(!fs.existsSync('/workspace/dist/index.html'))throw new Error('Offline build missing');execFileSync('python',['-c',${JSON.stringify(documentSmoke)}],{stdio:'inherit'});console.log('offline React build passed')`,
    ),
  );
  // Initialize native JSONL protocols against deliberately synthetic credentials only.
  const nativeProbe = `
    const {spawn,execFileSync}=require('child_process'),assert=require('assert/strict');
    for(const path of ['/tmp/codex','/tmp/grok'])require('fs').mkdirSync(path,{recursive:true});
    assert.match(execFileSync('codex',['--version'],{encoding:'utf8'}),/0\\.158\\.0/);
    assert.match(execFileSync('grok',['--version'],{encoding:'utf8'}),/1\\.0\\.41/);
    async function init(command,args,env,method,params){return new Promise((resolve,reject)=>{let b='',stderr='',settled=false;const child=spawn(command,args,{cwd:'/tmp',env:{PATH:process.env.PATH,HOME:'/home/agent',...env},stdio:['pipe','pipe','pipe']});const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGKILL');error?reject(error):resolve()};const timer=setTimeout(()=>finish(new Error(command+' initialization timeout: '+stderr.slice(-2048))),15000);child.on('error',finish);child.on('close',code=>finish(new Error(command+' exited '+code+': '+stderr.slice(-2048))));child.stdin.on('error',finish);child.stderr.on('data',c=>{stderr=(stderr+c).slice(-2048)});child.stdout.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){let m;try{m=JSON.parse(b.slice(0,n))}catch(error){finish(error);return}b=b.slice(n+1);if(m.id===1)finish(m.error?new Error(command+' rejected initialization'):undefined)}});child.stdin.write(JSON.stringify({id:1,method,params})+'\\n');})}
    (async()=>{await init('codex',['app-server'],{CODEX_HOME:'/tmp/codex'},'initialize',{clientInfo:{name:'wme_acceptance',version:'1.0.0'}});await init('grok',['agent','--no-leader','stdio'],{GROK_HOME:'/tmp/grok',XAI_API_KEY:'synthetic-fixture-not-a-provider-key',GROK_XAI_API_BASE_URL:'http://api:4100/v1',GROK_DISABLE_AUTOUPDATER:'1'},'initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'wme-acceptance',version:'1.0.0'}});await import('/opt/runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');await import('/opt/runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js');console.log('native binaries, RPC initialization, and SDK imports passed')})().catch(e=>{console.error(e);process.exit(1)});
  `;
  console.log(await runProbe(b, [], nativeProbe));
  const sessionMount = `type=volume,src=${storage},dst=/session,volume-subpath=sessions,volume-nocopy`;
  console.log(
    await runProbe(
      b,
      [...readMounts, sessionMount],
      `(async()=>{
    const assert=require('node:assert/strict');
    const {runCodex,runGrok,prepareNativeConfiguration,applyEgressEnvironment}=await import('/opt/runtime/src/native.js');
    const {runClaude,runPi}=await import('/opt/runtime/src/sdk.js');
    const {validateEvent}=await import('/opt/runtime/src/validation.js');
    const {JsonRpcProcess}=await import('/opt/runtime/src/rpc.js');
    const fixtureRpc=(command,args,env)=>{
      const rpc=new JsonRpcProcess(command,args,env);let lines='',diagnostics=0;
      const send=rpc.send.bind(rpc);rpc.send=message=>{if(command==='grok'&&message.id!==undefined&&!message.method&&diagnostics++<24)console.error('Grok fixture client response',JSON.stringify({id:message.id,outcome:message.result?.outcome?.outcome,error:!!message.error}));send(message)};
      rpc.child.stdout.on('data',chunk=>{lines+=chunk;let end;while((end=lines.indexOf('\\n'))>=0){const line=lines.slice(0,end);lines=lines.slice(end+1);try{
        const message=JSON.parse(line);if(message.error)console.error('Synthetic fixture protocol rejection:',command,JSON.stringify({code:message.error.code,message:message.error.message}));
        const update=message.params?.update;
        if(command==='grok'&&diagnostics<24&&(message.id!==undefined&&message.method||['tool_call','tool_call_update'].includes(update?.sessionUpdate))){diagnostics++;console.error('Grok fixture metadata',JSON.stringify({method:message.method,id:message.id,options:message.params?.options?.map(o=>o.kind),update:update?.sessionUpdate,status:update?.status,kind:update?.kind,successMarker:JSON.stringify(update?.content??'').includes('PROXY_TOOL_OK'),failureMarker:JSON.stringify(update?.content??'').includes('PROXY_TOOL_FAILED')}))}
      }catch{}}});return rpc;
    };
    for(const [harness,run] of [['codex',runCodex],['grok',runGrok],['claude',runClaude],['pi',runPi]]){
      const request={runId:'acceptance_'+harness,projectId:'synthetic_project',harness,model:'synthetic-acceptance-model',prompt:'This is a synthetic protocol test. Reply with SYNTHETIC_RUNTIME_ACCEPTANCE.',access:'read',gateway:{baseUrl:'http://api:4100',token:'synthetic-scoped-fixture-key'}};
      const events=[]; await prepareNativeConfiguration(request); await run(request,event=>events.push(validateEvent(event)),AbortSignal.timeout(20000),fixtureRpc);
      assert.equal(events.filter(e=>e.type==='assistant_delta').map(e=>e.delta).join(''),'SYNTHETIC_RUNTIME_ACCEPTANCE');
      const sessionId=events.find(e=>e.type==='native_session')?.sessionId; assert.ok(sessionId);
      const continued=[]; await run({...request,runId:request.runId+'_resume',resumeId:sessionId},event=>continued.push(validateEvent(event)),AbortSignal.timeout(20000),fixtureRpc);
      assert.equal(continued.find(e=>e.type==='native_session')?.sessionId,sessionId);
      assert.equal(continued.filter(e=>e.type==='assistant_delta').map(e=>e.delta).join(''),'SYNTHETIC_RUNTIME_ACCEPTANCE');
      console.log(harness+' real native turn and persisted resume against synthetic gateway passed');
      const proxyRequest={...request,runId:request.runId+'_proxy',model:'synthetic-proxy-'+harness,prompt:'Run the synthetic proxy tool check. Never print environment variables or credentials.',egressProxyUrl:'http://api:4101'};
      const proof=[]; await prepareNativeConfiguration(proxyRequest); const restore=applyEgressEnvironment(proxyRequest);
      try { await run(proxyRequest,event=>proof.push(validateEvent(event)),AbortSignal.timeout(20000),fixtureRpc); }
      catch(error){console.error(harness+' synthetic tool status',await(await fetch('http://api:4100/fixture-status/'+harness)).text());console.error(harness+' normalized event metadata',JSON.stringify(proof.map(e=>({type:e.type,status:e.status,bytes:e.type==='assistant_delta'?e.delta.length:undefined}))));throw error}
      finally { restore(); }
      assert.ok(proof.some(e=>e.type==='tool_start'),harness+' did not execute a native tool');
      assert.equal(proof.filter(e=>e.type==='assistant_delta').map(e=>e.delta).join(''),'PROXY_TOOL_VERIFIED',harness+' scoped proxy tool failed');
      console.log(harness+' installed native tool used scoped proxy and direct gateway bypass');
    }
  })().catch(e=>{console.error(e);process.exit(1)})`,
    ),
  );
  console.log(
    "Linux container acceptance passed; no live provider inference was attempted.",
  );
} finally {
  for (const name of containers.reverse())
    await docker(["rm", "--force", name]).catch(() => {});
  for (const name of networks.reverse())
    await docker(["network", "rm", name]).catch(() => {});
  for (const rule of firewallRules.reverse())
    await iptables(["-D", ...rule]).catch(() => {});
  for (const name of volumes.reverse())
    await docker(["volume", "rm", name]).catch(() => {});
  await cleanupFixture();
}
