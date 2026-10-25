import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {platformFixture} from "./fixtures/platform.js";

test("workspace native defaults are admin managed, shared across members, and choose compatible organization models",async t=>{
  const f=await platformFixture(t),base=`/enterprise/api/projects/${f.projectA}/agent-settings`;
  f.inference.models=async()=>[{id:'openai-fixture',provider:'openai',name:'OpenAI'},{id:'claude-fixture',provider:'anthropic',name:'Claude'}];
  for(const actor of ['full','read']) {
    assert.equal((await f.request(actor,'GET',base)).statusCode,200);
    assert.equal((await f.request(actor,'PATCH',base,{defaultHarness:'codex'})).statusCode,403);
    assert.equal((await f.request(actor,'GET',`/enterprise/api/projects/${f.projectA}/inference/accounts`)).statusCode,403);
    assert.equal((await f.request(actor,'GET',`/enterprise/api/projects/${f.projectA}/inference/models`)).statusCode,200);
  }
  assert.equal((await f.request('other','GET',base)).statusCode,404);
  assert.equal((await f.request('admin','PATCH',base,{defaultHarness:'claude_code',agents:{claude_code:{model:'claude-fixture',thinking:'high',permission:'ask'},pi:{codeMode:'only',subagentConcurrency:4}}})).statusCode,200);
  const created=await f.request('read','POST',`/enterprise/api/projects/${f.projectA}/conversations`,{title:'Native default'});
  assert.equal(created.statusCode,201,created.body);
  assert.equal(created.json().model,'claude-fixture');assert.equal(created.json().harness,'claude_code');assert.equal(created.json().mode,'write');
  const path=`/enterprise/api/conversations/${created.json().id}`;
  const changed=await f.request('full','PATCH',path,{harness:null,native:{thinking:'low'}});
  assert.equal(changed.statusCode,200,changed.body);
  assert.deepEqual(changed.json().native,{thinking:'low',permission:'ask'});
  assert.equal(changed.json().harness,'claude_code');
  const grok=await f.request('read','POST',`/enterprise/api/projects/${f.projectA}/conversations`,{harness:'grok_build'});
  assert.equal(grok.statusCode,201,grok.body);
  assert.equal(grok.json().model,'openai-fixture','Grok custom-provider defaults use compatible organization models');
});

test("OpenCode native model names map back to organization model IDs and response receipts are idempotent",async t=>{
  const deliveries:any[]=[];
  const f=await platformFixture(t,{startConversations:false,runtime:{async execute(){},async cancel(){},async recover(){return []},async steer(runId,input){deliveries.push({runId,input})}}});
  const chat=await f.conversations.create(f.users.full!,f.projectA,{harness:'opencode'}),runId=randomUUID(),userMessage=randomUUID(),assistantMessage=randomUUID(),now=new Date().toISOString();
  await f.db.batch([
    {sql:"INSERT INTO conversation_messages(id,conversation_id,run_id,role,content,citations,created_at) VALUES(?,?,?,'user','hello','[]',?)",params:[userMessage,chat.id,runId,now]},
    {sql:"INSERT INTO conversation_messages(id,conversation_id,run_id,role,content,citations,created_at) VALUES(?,?,?,'assistant','','[]',?)",params:[assistantMessage,chat.id,runId,now]},
    {sql:"INSERT INTO conversation_runs(id,conversation_id,org_id,project_id,user_id,request_id,user_message_id,assistant_message_id,status,mode,harness,model,created_at) VALUES(?,?,?,?,?,?,?,?,'running','write','opencode','fixture',?)",params:[runId,chat.id,f.orgA,f.projectA,f.users.full!.id,randomUUID(),userMessage,assistantMessage,now]},
    {sql:"INSERT INTO conversation_events(conversation_id,run_id,type,data,created_at) VALUES(?,?,'native.settings',?,?)",params:[chat.id,runId,JSON.stringify({model:'enterprise/fixture',models:[{id:'enterprise/fixture',label:'Fixture'}]}),now]},
    {sql:"INSERT INTO conversation_events(conversation_id,run_id,type,data,created_at) VALUES(?,?,'native.interaction',?,?)",params:[chat.id,runId,JSON.stringify({id:'approval:fixture',kind:'approval',options:[{id:'once',label:'Allow once'}]}),now]},
  ]);
  const path=`/enterprise/api/conversations/${chat.id}/native`;
  const view=(await f.request('read','GET',path)).json();assert.equal(view.settings.model,'fixture');assert.equal(view.settings.models[0].id,'fixture');
  const response={requestId:randomUUID(),interactionId:'approval:fixture',optionID:'once'};
  const first=await f.request('read','POST',path+'/respond',response);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().delivery,'accepted');
  assert.equal((await f.request('read','POST',path+'/respond',response)).statusCode,200);
  assert.equal(deliveries.length,1);assert.equal(deliveries[0].input.nativeResponse.optionID,'once');
  assert.equal((await f.request('read','POST',path+'/respond',{...response,optionID:'reject'})).statusCode,409);
  assert.equal((await f.request('other','POST',path+'/respond',response)).statusCode,404);
  await f.db.run("UPDATE conversation_runs SET status='completed' WHERE id=?",[runId]);
});
