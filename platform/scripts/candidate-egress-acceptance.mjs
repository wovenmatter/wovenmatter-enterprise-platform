// Explicit Linux-only acceptance. Synthetic fixtures; never mounts customer files or uses provider accounts.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const execute = promisify(execFile);
if (
  process.env.WME_RUN_CANDIDATE_EGRESS_ACCEPTANCE !== "1" ||
  process.platform !== "linux"
)
  throw new Error("Explicit Linux candidate egress acceptance is required");
const api = process.env.WME_API_CONTAINER ?? "wme-candidate-api";
const image = process.env.WME_AGENT_IMAGE;
if (!image || api !== "wme-candidate-api")
  throw new Error("Use the isolated candidate API and explicit runner image");
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const container = `wme-egress-check-${suffix}`,
  network = `${container}-net`,
  peer = `${container}-peer`,
  peerNetwork = `${peer}-net`;
async function docker(args) {
  return (
    await execute("docker", args, { timeout: 120_000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
}
async function script(target, source) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      ["exec", "-i", target, "node", "--input-type=module"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 1024 * 1024) child.kill();
    });
    child.stderr.resume(); // Do not leak scoped credentials or command diagnostics.
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              "Synthetic candidate probe failed" +
                (output
                  .match(
                    /^WME_EGRESS_FAILURE (curl|python3|node|npm|git|embedded|bypass|boundaries|codex|startup|gateway)(?: exit=[0-9]+)?(?: http=[0-9]{3})?$/m,
                  )?.[0]
                  ?.replace("WME_EGRESS_FAILURE", " at") ?? "") +
                "; no secret-bearing child output was printed",
            ),
          );
    });
    child.stdin.end(source);
  });
}
function coordinator() {
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "WME_RUN_CANDIDATE_EGRESS_COORDINATOR=1",
      api,
      "node",
      "platform/scripts/candidate-egress-coordinator.mjs",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.resume();
  let buffer = "",
    stopped = false;
  const queued = [],
    waiters = [];
  const fail = () => {
    stopped = true;
    for (const waiter of waiters.splice(0))
      waiter.reject(new Error("Synthetic coordinator exited"));
  };
  child.once("error", fail);
  child.once("exit", fail);
  child.stdin.on("error", fail);
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 128 * 1024) {
      child.kill();
      return;
    }
    for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        child.kill();
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value);
      else queued.push(value);
    }
  });
  const timer = setTimeout(() => {
    child.stdin.end("stop\n");
    child.kill();
  }, 180000);
  const next = () =>
    queued.length
      ? Promise.resolve(queued.shift())
      : stopped
        ? Promise.reject(new Error("Synthetic coordinator stopped"))
        : new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  return {
    next,
    async command(command) {
      child.stdin.write(command + "\n");
      return next();
    },
    async close() {
      clearTimeout(timer);
      if (!stopped) {
        child.stdin.end("stop\n");
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
        if (!stopped) child.kill();
      }
    },
  };
}
let control;
let fixture;
const createdNetworks = [],
  createdContainers = [];
let attachedApi = false;
try {
  const detail = JSON.parse(await docker(["inspect", api]))[0];
  assert.equal(
    detail.Config.Labels["com.docker.compose.project"],
    "wovenmatter-enterprise-candidate",
  );
  assert.ok(
    !detail.HostConfig.PortBindings?.["4101/tcp"],
    "Internal proxy must not be host-published",
  );
  control = coordinator();
  fixture = await control.next();
  assert.ok(
    fixture.token && Number.isInteger(fixture.port),
    "Synthetic coordinator did not become ready",
  );
  assert.ok(
    !detail.HostConfig.PortBindings?.[`${fixture.port}/tcp`],
    "Synthetic proxy must not be host-published",
  );
  await docker([
    "network",
    "create",
    "--internal",
    "--subnet",
    "10.252.0.32/28",
    "--opt",
    `com.docker.network.bridge.name=br-wmerun${suffix.slice(0, 6)}`,
    network,
  ]);
  createdNetworks.push(network);
  await docker(["network", "connect", "--alias", "api", network, api]);
  attachedApi = true;
  await docker([
    "network",
    "create",
    "--internal",
    "--subnet",
    "10.252.0.48/28",
    "--opt",
    `com.docker.network.bridge.name=br-wmerun${suffix.slice(6, 12)}`,
    peerNetwork,
  ]);
  createdNetworks.push(peerNetwork);
  const limits = [
    "--read-only",
    "--user",
    "10001:10001",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    "apparmor=wme-platform-agent",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,uid=10001,gid=10001,size=64m",
    "--tmpfs",
    "/session:rw,nosuid,nodev,uid=10001,gid=10001,mode=0700,size=16m",
  ];
  await docker([
    "run",
    "--detach",
    "--name",
    peer,
    "--network",
    peerNetwork,
    ...limits,
    "--entrypoint",
    "node",
    image,
    "-e",
    "require('http').createServer((q,r)=>r.end('synthetic')).listen(8080,'0.0.0.0')",
  ]);
  createdContainers.push(peer);
  await docker([
    "run",
    "--detach",
    "--name",
    container,
    "--network",
    network,
    ...limits,
    "--entrypoint",
    "node",
    image,
    "-e",
    "setInterval(()=>{},60000)",
  ]);
  createdContainers.push(container);
  const peerDetail = JSON.parse(await docker(["inspect", peer]))[0];
  fixture.peerAddress =
    peerDetail.NetworkSettings.Networks[peerNetwork].IPAddress;
  const checks = `
import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import{promisify}from'node:util';import{request}from'node:http';
import {egressEnvironment,applyEgressEnvironment,prepareNativeConfiguration,runtimeEnvironment}from'/opt/runtime/src/native.js';
import {JsonRpcProcess}from'/opt/runtime/src/rpc.js';
let stage='startup';process.on('uncaughtException',()=>{console.log('WME_EGRESS_FAILURE '+stage);process.exit(1)});
const f=${JSON.stringify(fixture)};
const req={projectId:f.project,gateway:{baseUrl:'http://api:4100/api/runtime/inference/'+f.project,token:f.token},egressProxyUrl:'http://api:'+f.port,access:'read',model:'fixture',harness:'codex'};
const env={...process.env,...egressEnvironment(req),HOME:'/tmp',npm_config_cache:'/tmp/npm-cache'};
const execute=promisify(execFile);
async function command(file,args){stage=args.some(a=>a.includes('/healthz'))?'gateway':file;try{return await execute(file,args,{env,timeout:25000,maxBuffer:1024*1024});}catch(e){const code=Number(e.code);if(Number.isInteger(code)&&code>=0)stage+=' exit='+code;const status=String(e.stderr??'').match(/(?:error:|returned error:|response) ([0-9]{3})/)??String(e.stdout??'').match(/^([0-9]{3})$/);if(status)stage+=' http='+status[1];throw Error('Public tool probe failed: '+file)}}
const initialConnect=await connect('example.com:443');if(initialConnect!==200){stage+=' http='+initialConnect;throw Error('Synthetic tunnel failed')}
assert.equal((await command('curl',['--silent','--show-error','--fail','--max-time','20','--output','/dev/null','--write-out','%{http_code}','https://example.com/'])).stdout,'200');
assert.equal((await command('python3',['-c',"import urllib.request; print(urllib.request.urlopen('https://example.com/',timeout=20).status)"])).stdout.trim(),'200');
assert.equal((await command('node',['-e',"fetch('https://example.com/').then(async r=>{await r.body.cancel();if(r.status!==200)process.exit(1);console.log(r.status)}).catch(()=>process.exit(1))"])).stdout.trim(),'200');
assert.equal((await command('npm',['view','react@19.2.0','version','--registry=https://registry.npmjs.org','--fetch-retries=0'])).stdout.trim(),'19.2.0');
assert.match((await command('git',['-c','protocol.version=0','ls-remote','https://github.com/octocat/Hello-World.git','HEAD'])).stdout,/^[a-f0-9]+\\s+HEAD/m);
stage='embedded';const restore=applyEgressEnvironment(req);try{const r=await fetch('https://example.com/');assert.equal(r.status,200);await r.body.cancel();}finally{restore()}
assert.equal((await command('curl',['--silent','--show-error','--fail','http://api:4100/healthz'])).stdout,'{"status":"ok"}');
stage='bypass';for(const url of ['https://example.com/','http://'+f.peerAddress+':8080/']){
let blocked=false;try{await execute('curl',['--noproxy','*','--silent','--max-time','3','--fail',url],{env,timeout:5000})}catch{blocked=true}assert.ok(blocked,'Direct network bypass unexpectedly succeeded');}
async function connect(target,auth=true,project=f.project){return new Promise((resolve,reject)=>{const q=request({host:'api',port:f.port,method:'CONNECT',path:target,headers:auth?{'proxy-authorization':'Basic '+Buffer.from(project+':'+f.token).toString('base64')}:{},agent:false});q.on('connect',(r,s)=>{s.destroy();resolve(r.statusCode)});q.on('response',r=>{r.resume();resolve(r.statusCode)});q.on('error',reject);q.setTimeout(5000,()=>q.destroy(Error('timeout')));q.end()})}
stage='boundaries';for(const target of ['127.0.0.1:443','169.254.169.254:443','10.0.0.1:443',f.peerAddress+':443',...f.boundary.addresses.map(a=>(a.includes(':')?'['+a+']':a)+':443'),...f.boundary.hostnames.map(h=>h+':443')])assert.equal(await connect(target),403,'Private/host boundary not denied');
assert.equal(await connect('example.com:443',false),407);assert.equal(await connect('example.com:443',true,'unrelated-project'),407);
stage='codex';await prepareNativeConfiguration(req);
const rpc=new JsonRpcProcess('codex',['app-server','--listen','stdio://'],{...runtimeEnvironment(),...egressEnvironment(req),CODEX_HOME:'/session/codex',WME_INFERENCE_TOKEN:f.token});
try{await rpc.request('initialize',{clientInfo:{name:'wme-network-acceptance',version:'1.0.0'}});rpc.send({method:'initialized'});const result=await rpc.request('command/exec',{command:['curl','--silent','--show-error','--fail','--max-time','20','--output','/dev/null','--write-out','%{http_code}','https://example.com/'],cwd:'/workspace',sandboxPolicy:{type:'dangerFullAccess'}});assert.equal(result.exitCode,0);assert.equal(result.stdout,'200');}finally{rpc.close()}
console.log('Public HTTPS curl/Python/npm/Git/Node/Pi/Codex tool access and gateway bypass passed; direct/host/private/peer/unauthorized paths denied.');
`;
  process.stdout.write(await script(container, checks));
  const revokedResult = await control.command("revoke");
  assert.equal(revokedResult.revoked, true);
  const revoked = `import assert from'node:assert/strict';import{request}from'node:http';const q=request({host:'api',port:${fixture.port},method:'CONNECT',path:'example.com:443',headers:{'proxy-authorization':'Basic '+Buffer.from(${JSON.stringify(fixture.project + ":" + fixture.token)}).toString('base64')}},r=>{r.resume();assert.equal(r.statusCode,407);console.log('Revoked actual run token denied.');});q.on('connect',(r,s)=>{s.destroy();assert.equal(r.statusCode,407);console.log('Revoked actual run token denied.');});q.end();`;
  process.stdout.write(await script(container, revoked));
} finally {
  await control?.close();
  for (const name of createdContainers.reverse())
    await docker(["rm", "--force", name]).catch(() => {});
  if (attachedApi)
    await docker(["network", "disconnect", "--force", network, api]).catch(
      () => {},
    );
  for (const name of createdNetworks.reverse())
    await docker(["network", "rm", name]).catch(() => {});
}
