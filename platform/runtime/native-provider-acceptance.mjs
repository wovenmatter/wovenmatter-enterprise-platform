// Actual pinned native CLIs against local synthetic protocols. Run inside the
// runtime image with --network none; no upstream account or credentials needed.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
if(process.env.WME_RUN_CONTAINER_ACCEPTANCE!=='1')throw Error('Explicit native acceptance required');
const runtime=process.env.WME_NATIVE_RUNTIME_DIR??'/opt/runtime/src';
const {runNative}=await import(pathToFileURL(join(runtime,'native-harnesses.js')));
const {SteeringChannel}=await import(pathToFileURL(join(runtime,'steering.js')));
const harness=process.argv[2]??'grok_build';
assert.ok(['grok_build','codex','claude_code'].includes(harness));
const root=await mkdtemp(join(tmpdir(),'wme-native-provider-'));
await writeFile(join(root,'gateway.cjs'),await readFile(new URL('./protocol-fixture.mjs',import.meta.url)));
const {handler}=createRequire(import.meta.url)(join(root,'gateway.cjs'));
const calls=[],token='synthetic-scoped-fixture-key';
const server=createServer((req,res)=>{
  let raw='';const path=req.url;
  req.on('data',chunk=>raw+=chunk);
  req.on('end',()=>{if(req.method==='POST')calls.push({path,body:JSON.parse(raw),auth:req.headers.authorization??req.headers['x-api-key']});});
  void handler(req,res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
  for(const [api,path] of (harness==='grok_build'?[['openai-responses','/v1/responses'],['openai-compatible','/v1/chat/completions'],['anthropic-messages','/v1/messages']]:[['openai-compatible',harness==='codex'?'/v1/responses':'/v1/messages']])) {
    const home=join(root,api),model='organization/'+api,retained={};
    const request={runId:'new-'+api,projectId:'fixture-project',harness,model,prompt:'Reply SYNTHETIC_RUNTIME_ACCEPTANCE',access:'write',workingDirectory:root,pi:{api,supportsReasoning:false},gateway:{baseUrl:`http://127.0.0.1:${server.address().port}/enterprise/api/runtime/inference/fixture-project`,token}};
    const run=async(r,state)=>{
      const events=[];
      const timer=setTimeout(()=>state.native?.rpc?.close(),45000);
      try {await runNative(r,e=>events.push(e),AbortSignal.timeout(40000),new SteeringChannel(),state,{home});}
      finally {clearTimeout(timer);}
      const answer=events.filter(e=>e.type==='assistant_delta').map(e=>e.delta).join('');
      assert.equal(harness==='codex'?answer.replace(/^Warning: Model metadata for `[^`]+` not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.\n\n/,''):answer,'SYNTHETIC_RUNTIME_ACCEPTANCE');
      return events.find(e=>e.type==='native_session')?.sessionId;
    };
    let cold={};
    try {
      const id=await run(request,retained);assert.ok(id);
      assert.equal(await run({...request,runId:'warm-'+api,resumeId:id},retained),id);
      retained.native.rpc.close();await retained.native.rpc.stopped;
      assert.equal(await run({...request,runId:'cold-'+api,resumeId:id},cold),id);
      const actual=calls.filter(call=>call.body.model===model);
      assert.ok(actual.length>=3,'Each native turn must reach its selected provider protocol');
      for(const call of actual){const pathname=new URL(call.path,'http://fixture').pathname;assert.ok(pathname.endsWith(path)||pathname.endsWith(path+'/count_tokens'),call.path);assert.ok([token,'Bearer '+token].includes(call.auth));}
      if(harness==='grok_build')assert.ok(!(await readFile(join(home,'.grok/config.toml'),'utf8')).includes(token));
      console.log(JSON.stringify({harness,api,model,newSession:true,warmResume:true,coldResume:true,requests:actual.length}));
    } finally {
      for(const state of [retained,cold])if(state.native?.rpc){state.native.rpc.close();await state.native.rpc.stopped;}
    }
  }
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
