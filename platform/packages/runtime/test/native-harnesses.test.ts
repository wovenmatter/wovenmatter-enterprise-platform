import test from "node:test";
import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
import {fileURLToPath} from "node:url";
import {runNative, nativeEnvironment, nativeCommand, harnessCatalog, nativeRunTokens, grokConfiguration} from "../src/native-harnesses.ts";
import {JsonRpcProcess} from "../src/rpc.ts";
import {SteeringChannel} from "../src/steering.ts";
import type {ContainerRequest, Harness, RuntimeEvent} from "../src/types.ts";
import type {NativeSessionState} from "../src/native.ts";

const request = (harness: Harness, directory: string): ContainerRequest => ({runId:"fixture-run",projectId:"fixture-project",harness,model:"fixture-model",prompt:"hello",access:"write",workingDirectory:directory,gateway:{baseUrl:"http://127.0.0.1:4101/inference",token:"fixture_local_broker_capability_only"}});
async function fixture(t: any, harness: Harness, directory?: string) {
  const home = await mkdtemp(join(tmpdir(), "wme-native-fixture-"));
  const trace = join(home,"trace.jsonl"), retained: NativeSessionState = {}, processes: JsonRpcProcess[] = [];
  t.after(async()=> {for(const process of processes)process.close();await Promise.all(processes.map(p=>p.stopped));await rm(home,{recursive:true,force:true});});
  const launch = (command: string,args: string[],env: Record<string,string>,cwd: string) => {
    assert.equal(command,nativeCommand(request(harness,home)).command);
    if(harness==='grok_build')assert.deepEqual(args.slice(-3),['agent','--no-leader','stdio']);
    assert.equal(cwd,directory ?? home);
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
  test(`${harness} named and scratch cwd survive native reopen while files use private multimodal snapshots`,async t=>{
    const root=await mkdtemp(join(tmpdir(),'wme-native-folders-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    for(const kind of ['Named folder','scratch/2026-10-23-example-12345678']) {
      const directory=join(root,'.WovenMatter',kind);
      await mkdir(directory,{recursive:true});
      const f=await fixture(t,harness,directory),channel=new SteeringChannel();
      const attachments=[
        {name:'pixel.png',mimeType:'image/png',data:Buffer.from('synthetic image bytes').toString('base64')},
        {name:'note.txt',mimeType:'text/plain',data:Buffer.from('Résumé snapshot').toString('base64')},
        {name:'document.pdf',mimeType:'application/pdf',data:Buffer.from('%PDF-fixture').toString('base64')},
      ];
      const input={...request(harness,directory),prompt:'steer',attachments};
      const running=runNative(input,()=>{},new AbortController().signal,channel,f.retained,f);
      await channel.submit({id:'attached-steering',sequence:1,authorId:'u',authorName:'User',content:'Use attached files',attachments});
      await running;await channel.settle();
      const trace=await f.readTrace();
      const inputs=trace.filter(item=>item.method==='session/prompt'||item.method==='_session/steering');
      assert.equal(inputs.length,2);
      for(const item of inputs) {
        assert.deepEqual(item.params.prompt.find((block:any)=>block.type==='image'),{type:'image',mimeType:'image/png',data:attachments[0].data});
        const resource=item.params.prompt.find((block:any)=>block.type==='resource').resource;
        assert.equal(resource.text,'Résumé snapshot');
        const linked=item.params.prompt.find((block:any)=>block.type==='resource_link');
        const path=fileURLToPath(linked.uri);
        assert.ok(path.startsWith(f.home+'/attachments/'));
        assert.ok(!path.startsWith(directory+'/'));
        assert.ok(item.params.prompt[0].text.includes(path));
        assert.equal(await readFile(path,'utf8'),'%PDF-fixture');
      }
      assert.equal(trace.some(item=>item.method==='_x.ai/interject'),false,'Grok file input must use its concurrent multimodal prompt');
      (f.retained.native as any).rpc.close();await (f.retained.native as any).rpc.stopped;
      await runNative({...input,runId:'cold-reopen',prompt:'Continue',resumeId:'native_fixture'},()=>{},new AbortController().signal,new SteeringChannel(),{},f);
      const final=await f.readTrace();
      assert.equal(final.find(item=>item.method==='session/new').params.cwd,directory);
      assert.equal(final.find(item=>item.method==='session/load').params.cwd,directory);
      assert.equal(existsSync(join(directory,'.codex')),false,'Private native home must not be created in the project folder');
    }
  });
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

test('OpenCode named and scratch sessions send image files on initial input and ordered steering',async t=>{
  const root=await mkdtemp(join(tmpdir(),'wme-opencode-attachments-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const kind of ['Named folder','scratch/2026-10-23-opencode-12345678']) {
    const directory=join(root,'.WovenMatter',kind),home=await mkdtemp(join(tmpdir(),'wme-opencode-private-'));
    await mkdir(directory,{recursive:true});
    t.after(()=>rm(home,{recursive:true,force:true}));
    let session:any,active=false,creations=0;
    const submissions:any[]=[];
    const server=createServer(async(req,res)=>{
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=raw?JSON.parse(raw):{},path=new URL(req.url!,'http://localhost').pathname;
      let value:any;
      if(path==='/api/info')value={pid:123,version:'2.1.2'};
      else if(path==='/api/session/active')value={data:active?{[session.id]:true}:{}};
      else if(path==='/api/session'&&req.method==='POST'){creations++;session={...body,model:{providerID:'enterprise',id:'fixture-model'}};value={data:session};}
      else if(path==='/api/model')value={data:[{providerID:'enterprise',id:'fixture-model',enabled:true,variants:[]}]};
      else if(path==='/api/model/default')value={data:{providerID:'enterprise',id:'fixture-model'}};
      else if(path.endsWith('/model')){session.model=body.model;value={};}
      else if(path.endsWith('/prompt')){submissions.push(body);active=submissions.length===1;value={data:{id:body.id}};}
      else if(path.endsWith('/permission')||path.endsWith('/form'))value={data:[]};
      else if(path.endsWith('/message'))value={data:submissions.length<2?[]:submissions.slice().reverse().flatMap((item,index)=>[{id:'answer-'+item.id,sessionID:session.id,role:'assistant',parts:[{type:'text',text:'Files inspected '+index}]},{id:item.id,sessionID:session.id,role:'user',parts:[]}])};
      else value={data:session};
      res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const registrationPath=join(home,'registration.json');
      await writeFile(registrationPath,JSON.stringify({pid:123,version:'2.1.2',password:'fixture-secret',url:`http://127.0.0.1:${(server.address() as any).port}`}));
      const attachments=[{name:'photo.png',mimeType:'image/png',data:Buffer.from('synthetic photo').toString('base64')}];
      const channel=new SteeringChannel(),events:RuntimeEvent[]=[];
      const running=runNative({...request('opencode',directory),attachments},event=>{events.push(event)},new AbortController().signal,channel,{}, {home,instances:{registrationPath,async action(){}}});
      await channel.submit({id:'image-steering',sequence:1,authorId:'u',authorName:'User',content:'Inspect again',attachments});
      await running;await channel.settle();
      assert.equal(session.location.directory,directory);
      assert.equal(submissions.length,2);
      assert.equal(submissions[1].delivery,'steer');
      assert.notEqual(submissions[0].id,submissions[1].id);
      for(const input of submissions)assert.deepEqual(input.files,[{name:'photo.png',uri:'data:image/png;base64,'+attachments[0].data}]);
      assert.ok(events.some(event=>event.type==='native_update'&&event.update.sessionUpdate==='woven_native_settings'&&(event.update.settings as any).canSteer===true));
      await runNative({...request('opencode',directory),runId:'cold-reopen',resumeId:session.id,attachments},()=>{},new AbortController().signal,new SteeringChannel(),{}, {home,instances:{registrationPath,async action(){}}});
      assert.equal(creations,1,'Cold reopen must resume the saved native session');
      assert.equal(session.location.directory,directory);
      assert.equal(submissions.length,3);
    } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
  }
});
