import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
import {runNative, nativeEnvironment, nativeCommand, harnessCatalog, nativeRunTokens, grokConfiguration} from "../src/native-harnesses.ts";
import {JsonRpcProcess} from "../src/rpc.ts";
import {SteeringChannel} from "../src/steering.ts";
import type {ContainerRequest, Harness, RuntimeEvent} from "../src/types.ts";
import type {NativeSessionState} from "../src/native.ts";

const request = (harness: Harness, directory: string): ContainerRequest => ({runId:"fixture-run",projectId:"fixture-project",harness,model:"fixture-model",prompt:"hello",access:"write",workingDirectory:directory,gateway:{baseUrl:"http://127.0.0.1:4101/inference",token:"fixture_local_broker_capability_only"}});
async function fixture(t: any, harness: Harness) {
  const home = await mkdtemp(join(tmpdir(), "wme-native-fixture-"));
  const trace = join(home,"trace.jsonl"), retained: NativeSessionState = {}, processes: JsonRpcProcess[] = [];
  t.after(async()=> {for(const process of processes)process.close();await Promise.all(processes.map(p=>p.stopped));await rm(home,{recursive:true,force:true});});
  const launch = (command: string,args: string[],env: Record<string,string>,cwd: string) => {
    assert.equal(command,nativeCommand(request(harness,home)).command);
    if(harness==='grok_build')assert.deepEqual(args.slice(-3),['agent','--no-leader','stdio']);
    assert.equal(cwd,home);
    assert.equal(existsSync(join(home,'.codex')),true,'Codex home must exist before the real adapter starts');
    const child = new JsonRpcProcess(process.execPath,[join(process.cwd(),"platform/runtime/native-protocol-fixture.mjs"),command,...args],{...env,FIXTURE_TRACE:trace},cwd);
    processes.push(child);return child;
  };
  return {home,trace,retained,launch,readTrace:async()=> (await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line))};
}

test("five harness catalog and native auth route only to session gateway",()=>{
  assert.deepEqual(harnessCatalog.map(h=>h.id),['pi','codex','claude_code','grok_build','opencode']);
  for(const harness of ['codex','claude_code','grok_build','opencode'] as const) {
    const r=request(harness,'/workspace'),env=nativeEnvironment(r);
    assert.equal(env.HOME,'/session/native-home');
    assert.ok(!JSON.stringify(env).includes('api.openai.com'));
    assert.ok(!JSON.stringify(env).includes('api.anthropic.com'));
    assert.ok(!Object.keys(env).includes('AWS_SECRET_ACCESS_KEY'));
    assert.ok(Object.values(env).some(value=>value.includes(r.gateway.token)));
  }
});
test("native usage accepts exact counts and leaves missing or inconsistent accounting unknown",()=>{
  assert.equal(nativeRunTokens({usage:{totalTokens:37}}),37);
  assert.equal(nativeRunTokens({usage:{inputTokens:10,outputTokens:5,cachedReadTokens:2,cachedWriteTokens:1}}),18);
  for(const usage of [undefined,{}, {inputTokens:10}, {inputTokens:-1,outputTokens:5}, {inputTokens:10,outputTokens:5,cachedReadTokens:-1}])assert.equal(nativeRunTokens({usage}),undefined);
});
test("Grok custom models preserve all three native protocols and never serialize credentials",()=>{
  for(const [api,backend] of [["openai-responses","responses"],["openai-compatible","chat_completions"],["anthropic-messages","messages"]] as const) {
    const r={...request('grok_build','/workspace'),model:'organization/model.with-dots',pi:{api,supportsReasoning:true}};
    const config=grokConfiguration(r);
    assert.ok(config.includes('[model."organization/model.with-dots"]'));
    assert.ok(config.includes(`api_backend = "${backend}"`));
    assert.ok(config.includes('base_url = "http://127.0.0.1:4101/inference/v1"'));
    assert.ok(config.includes('env_key = "XAI_API_KEY"'));
    assert.ok(!config.includes(r.gateway.token));
  }
});
for(const harness of ['codex','claude_code','grok_build'] as const) {
  test(`${harness} command, root ordering, native settings, stream, retained session and load`,async t=>{
    const f=await fixture(t,harness), events: RuntimeEvent[]=[], channel=new SteeringChannel();
    const r={...request(harness,f.home),prompt:'steer',native:{thinking:'high'}};
    const running=runNative(r,e=>{events.push(e)},new AbortController().signal,channel,f.retained,f);
    await channel.submit({id:'steer',sequence:1,authorId:'user',authorName:'User',content:'Continue'});
    await running; await channel.settle();
    const trace=await f.readTrace();
    assert.ok(trace.findIndex(m=>m.method==='session/prompt')<trace.findIndex(m=>['_session/steering','_x.ai/interject'].includes(m.method)));
    assert.ok(events.some(e=>e.type==='assistant_delta'&&e.delta==='answer'));
    assert.ok(events.some(e=>e.type==='native_update'&&e.update.sessionUpdate==='woven_native_settings'));
    if(harness==='grok_build') {
      const settings=events.find(e=>e.type==='native_update'&&e.update.sessionUpdate==='woven_native_settings') as any;
      assert.deepEqual(settings.update.settings.permissions.map((option:any)=>option.id),['default','acceptEdits','auto','dontAsk','bypassPermissions']);
      assert.equal(settings.update.settings.permission,'auto');
    }
    assert.ok(events.some(e=>e.type==='native_update'&&e.update.sessionUpdate==='woven_usage'&&(e.update.usage as any).totalTokens===37));
    assert.equal(trace.find(m=>m.method==='session/set_config_option').params.value,'high');
    const next={...r,...(harness==='grok_build'?{native:{thinking:'high',permission:'dontAsk'}}:{})};
    await runNative({...next,runId:'second',prompt:'hello',resumeId:'native_fixture'},()=>{},new AbortController().signal,new SteeringChannel(),f.retained,f);
    (f.retained.native as any).rpc.close();await (f.retained.native as any).rpc.stopped;
    await runNative({...next,runId:'third',prompt:'hello',resumeId:'native_fixture'},()=>{},new AbortController().signal,new SteeringChannel(),{},f);
    assert.equal((await f.readTrace()).filter(m=>m.method==='session/new').length,1);
    assert.equal((await f.readTrace()).filter(m=>m.method==='session/load').length,harness==='grok_build'?2:1);
  });
  test(`${harness} native approval and form questions validate responses`,async t=>{
    const f=await fixture(t,harness), channel=new SteeringChannel(), receipts: Promise<void>[]=[], interactions: any[]=[];
    await runNative({...request(harness,f.home),prompt:'approval'},event=>{
      if(event.type==='native_update'&&event.update.sessionUpdate==='woven_interaction') {
        const value=event.update.interaction as any;interactions.push(value);
        receipts.push((async()=>{
          if(value.kind==='question')await assert.rejects(channel.submit({id:'invalid-answer',sequence:2,authorId:'u',authorName:'User',content:'',nativeResponse:{interactionId:value.id,answers:{answer:['unlisted']}}}),{code:'native_response_invalid'});
          await channel.submit({id:'response'+interactions.length,sequence:value.kind==='approval'?1:3,authorId:'u',authorName:'User',content:'',nativeResponse:{interactionId:value.id,...(value.kind==='approval'?{optionID:'once'}:{answers:{answer:['yes']}})}});
        })());
      }
    },new AbortController().signal,channel,f.retained,f);
    await Promise.all(receipts);
    assert.deepEqual(interactions.map(i=>i.kind),['approval','question']);
  });
  test(`${harness} uncertain input is never replayed`,async t=>{
    const f=await fixture(t,harness), r={...request(harness,f.home),prompt:'disconnect'};
    await assert.rejects(runNative(r,()=>{},new AbortController().signal,new SteeringChannel(),f.retained,f));
    await assert.rejects(runNative(r,()=>{},new AbortController().signal,new SteeringChannel(),f.retained,f),{code:'native_outcome_uncertain'});
    assert.equal((await f.readTrace()).filter(m=>m.method==='session/prompt').length,1);
    await runNative({...r,runId:'explicit-next-run',prompt:'hello',resumeId:'native_fixture'},()=>{},new AbortController().signal,new SteeringChannel(),f.retained,f);
    assert.equal((await f.readTrace()).filter(m=>m.method==='session/prompt').length,2,'A new explicit user turn can resume without replaying the old prompt');
  });
  test(`${harness} cancellation uses the native cancel notification`,async t=>{
    const f=await fixture(t,harness), controller=new AbortController(), channel=new SteeringChannel();
    const running=runNative({...request(harness,f.home),prompt:'wait'},()=>{},controller.signal,channel,f.retained,f);
    while(!(await f.readTrace().catch(()=>[])).some(m=>m.method==='session/prompt'))await new Promise(r=>setTimeout(r,5));
    controller.abort();await running;
    assert.ok((await f.readTrace()).some(m=>m.method==='session/cancel'));
  });
}

test('OpenCode v2 HTTP lifecycle preserves cwd, native receipts, approval and transcript snapshots',async t=>{
  const home=await mkdtemp(join(tmpdir(),'wme-opencode-fixture-'));
  let session:any,active=false,approved=false,answered=false,messageId='',prompts=0;
  const paths:string[]=[],auth='Basic '+Buffer.from('opencode:fixture-secret').toString('base64');
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,auth);paths.push(req.method+' '+req.url);
    let body='';for await(const chunk of req)body+=chunk;
    const input=body?JSON.parse(body):{},path=new URL(req.url!,'http://localhost').pathname;
    let result:any;
    if(path==='/api/info')result={pid:123,version:'2.1.2'};
    else if(path==='/api/session/active')result={data:active?{[session.id]:true}:{}};
    else if(path==='/api/session'&&req.method==='POST'){session={...input,model:{providerID:'enterprise',id:'fixture-model'}};result={data:session};}
    else if(path==='/api/model')result={data:[{providerID:'enterprise',id:'fixture-model',enabled:true,variants:[]}]};
    else if(path==='/api/model/default')result={data:{providerID:'enterprise',id:'fixture-model'}};
    else if(path.endsWith('/model')){session.model=input.model;result={};}
    else if(path.endsWith('/prompt')){prompts++;active=true;approved=false;messageId=input.id;result={data:{id:messageId}};}
    else if(path.endsWith('/permission/per_fixture/reply')){assert.equal(input.reply,'once');approved=true;result={};}
    else if(path.endsWith('/permission'))result={data:active&&!approved?[{id:'per_fixture',sessionID:session.id,action:'read',resources:['fixture.txt']}]:[]};
    else if(path.endsWith('/form/form_fixture/reply')){assert.deepEqual(input.answer,{count:2});answered=true;active=false;result={};}
    else if(path.endsWith('/form'))result={data:approved&&!answered?[{id:'form_fixture',sessionID:session.id,title:'Count',fields:[{key:'count',type:'integer',minimum:1,maximum:3,required:true}]}]:[]};
    else if(path.endsWith('/message'))result={data:approved?[{id:'msg_answer_'+prompts,sessionID:session.id,role:'assistant',parts:[{type:'text',text:'OpenCode answer'}]},{id:messageId,sessionID:session.id,role:'user',parts:[]}]:[]};
    else result={data:session};
    res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(home,{recursive:true,force:true});});
  const registrationPath=join(home,'registration.json');
  await writeFile(registrationPath,JSON.stringify({pid:123,version:'2.1.2',password:'fixture-secret',url:`http://127.0.0.1:${(server.address() as any).port}`}));
  const state:NativeSessionState={},events:RuntimeEvent[]=[],channel=new SteeringChannel(),responses:Promise<void>[]=[];
  await runNative(request('opencode',home),event=>{
    events.push(event);
    if(event.type==='native_update'&&event.update.sessionUpdate==='woven_interaction') {
      const interaction=event.update.interaction as any;
      responses.push((async()=>{
        if(interaction.kind==='question')await assert.rejects(channel.submit({id:'invalid-form',sequence:2,authorId:'u',authorName:'U',content:'',nativeResponse:{interactionId:interaction.id,answers:{count:['4']}}}),{code:'native_response_invalid'});
        await channel.submit({id:interaction.kind,sequence:interaction.kind==='approval'?1:3,authorId:'u',authorName:'U',content:'',nativeResponse:{interactionId:interaction.id,...(interaction.kind==='approval'?{optionID:'once'}:{answers:{count:['2']}})}});
      })());
    }
  },new AbortController().signal,channel,state,{home,instances:{registrationPath,async action(){}}});
  await Promise.all(responses);
  assert.equal(session.location.directory,home);assert.equal(prompts,1);
  assert.ok(events.some(e=>e.type==='native_records'));
  assert.ok(events.some(e=>e.type==='native_update'&&e.update.sessionUpdate==='agent_message_chunk'));
  assert.ok(paths.some(path=>path.endsWith('/prompt')));
  assert.equal(paths.filter(path=>path.endsWith('/form/form_fixture/reply')).length,1,'Invalid response must never cross the native transport');
  assert.ok(!JSON.stringify(events).includes('fixture-secret'));
});
