import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {platformFixture} from "./fixtures/platform.js";
import {workspaceToolCall} from "../packages/runtime/src/workspace-tools.js";
import {agentInstructions} from "../packages/runtime/src/native.js";
async function fixture(t:any){
  const f=await platformFixture(t,{startConversations:false});
  f.inference.models=async()=>[{id:"fixture-model",name:"Deterministic model",provider:"openai",thinkingLevels:["off","high"]}];
  f.inference.validateSelection=async()=>{};
  const source=await f.conversations.create(f.users.full!,f.projectA,{title:"Source",model:"fixture-model"});
  return {...f,source,automation:f.workspaceContent.automation};
}
async function active(f:Awaited<ReturnType<typeof fixture>>){
  const run=randomUUID(),message=randomUUID(),assistant=randomUUID(),at=new Date().toISOString(),token="wme_run_"+randomUUID();
  for(const[id,role]of[[message,"user"],[assistant,"assistant"]])await f.db.run("INSERT INTO conversation_messages(id,conversation_id,role,author_id,content,created_at) VALUES(?,?,?,?,?,?)",[id!,f.source.id,role!,f.users.full!.id,"Synthetic",at]);
  await f.db.run("INSERT INTO conversation_runs(id,conversation_id,org_id,project_id,user_id,request_id,user_message_id,assistant_message_id,status,mode,harness,model,created_at) VALUES(?,?,?,?,?,?,?,?,'running','write','pi','fixture-model',?)",[run,f.source.id,f.orgA,f.projectA,f.users.full!.id,randomUUID(),message,assistant,at]);
  await f.db.run("INSERT INTO inference_gateway_tokens(token_hash,org_id,project_id,user_id,run_id,conversation_id,model,harness,expires_at,revoked) VALUES(?,?,?,?,?,?,'fixture-model','pi',?,0)",[createHash("sha256").update(token).digest("hex"),f.orgA,f.projectA,f.users.full!.id,run,f.source.id,new Date(Date.now()+60000).toISOString()]);
  const tool=(operation:string,payload:unknown)=>f.app.inject({method:"POST",url:"/enterprise/api/runtime/inference/"+f.projectA+"/workspace/"+operation,headers:{host:"portal.test",authorization:"Bearer "+token},payload:payload as any});
  return {run,tool};
}
test("managed chat creation preserves user permissions/tools and stable receipts even at capacity",async t=>{
  const f=await fixture(t);
  await f.conversations.updateAgentSettings(f.users.admin!,f.projectA,{harness:"codex",settings:{model:"fixture-model",permission:"read-only",tools:{history:false}}});
  await f.request("full","PATCH","/enterprise/api/me/preferences",{maximumManagedSessions:1});
  const input={action:"create",title:"Delegated fixture",text:"Read the synthetic note",purpose:"Explicit synthetic user delegation",harness:"codex",thinking:"high",requestID:randomUUID()};
  const created:any=await f.automation.sessions(f.users.full!,f.source.id,input),child=await f.conversations.get(f.users.full!,created.sessionId);
  assert.equal(child.harness,"codex");assert.equal(child.tools?.history,false);
  const row=await f.db.get<any>("SELECT native_options FROM conversations WHERE id=?",[child.id]);assert.deepEqual(JSON.parse(row.native_options),{thinking:"high",permission:"read-only"});
  const replay:any=await f.automation.sessions(f.users.full!,f.source.id,input);assert.equal(replay.sessionId,child.id);assert.equal(replay.replayed,true);
  assert.equal((await f.db.get<any>("SELECT COUNT(*) count FROM workspace_session_links WHERE source_id=?",[f.source.id]))!.count,1);
  await assert.rejects(f.automation.sessions(f.users.full!,f.source.id,{...input,requestID:randomUUID()}),/limit/);
  assert.throws(()=>workspaceToolCall("woven_sessions_create",{title:"X",text:"Y",purpose:"Z",permission:"agent-full-access",requestID:randomUUID()}),/Unknown/);
});
test("existing-chat coordination requires human consent and every send is fenced by the current epoch",async t=>{
  const f=await fixture(t),target=await f.conversations.create(f.users.full!,f.projectA,{title:"Target",model:"fixture-model"}),requestId=randomUUID();
  const pending:any=await f.automation.sessions(f.users.full!,f.source.id,{action:"manage",id:target.id,purpose:"Approved synthetic coordination",requestID:requestId});assert.equal(pending.state,"pending");
  await assert.rejects(f.automation.sessions(f.users.full!,f.source.id,{action:"send",id:target.id,epoch:"not-approved",text:"Denied",requestID:randomUUID()}),/epoch/);
  await assert.rejects(f.automation.decideCoordination(f.users.other!,f.projectA,requestId,true),/access|member|found/i);
  const approved=await f.automation.decideCoordination(f.users.read!,f.projectA,requestId,true);
  const request2=randomUUID();await f.automation.sessions(f.users.full!,f.source.id,{action:"manage",id:target.id,purpose:"New epoch",requestID:request2});const next=await f.automation.decideCoordination(f.users.read!,f.projectA,request2,true);assert.notEqual(next.epoch,approved.epoch);
  await assert.rejects(f.automation.sessions(f.users.full!,f.source.id,{action:"send",id:target.id,epoch:approved.epoch,text:"Stale",requestID:randomUUID()}),/epoch/);
  const input={action:"send",id:target.id,epoch:next.epoch,text:"Current epoch task",requestID:randomUUID()};
  const result:any=await f.automation.sessions(f.users.full!,f.source.id,input);assert.ok(result.id);await f.automation.sessions(f.users.full!,f.source.id,input);
  assert.equal((await f.db.get<any>("SELECT COUNT(*) count FROM conversation_inputs WHERE conversation_id=? AND request_id=?",[target.id,input.requestID]))!.count,1);
  await f.automation.sessions(f.users.full!,f.source.id,{action:"release",id:target.id,epoch:next.epoch});
  await assert.rejects(f.automation.sessions(f.users.full!,f.source.id,{...input,requestID:randomUUID()}),/epoch/);
});
test("session tools cannot cross projects and disabling the group fences the current run",async t=>{
  const f=await fixture(t),foreign=await f.conversations.create(f.users.other!,f.projectB,{title:"Other tenant",model:"fixture-model"}),{tool}=await active(f);
  assert.equal((await tool("sessions",{action:"status",id:foreign.id})).statusCode,404);
  await f.request("read","PATCH","/enterprise/api/conversations/"+f.source.id+"/tools",{group:"sessions",enabled:false});
  assert.equal((await tool("sessions",{action:"list"})).statusCode,403);
  await f.db.run("DELETE FROM project_members WHERE project_id=? AND user_id=?",[f.projectA,f.users.full!.id]);
  assert.equal((await tool("goals",{action:"set",objective:"Denied goal"})).statusCode,403);
});
test("uncertain session deliveries are retained and never automatically replayed",async t=>{
  const f=await fixture(t),target=await f.conversations.create(f.users.full!,f.projectA,{model:"fixture-model"}),requestId=randomUUID();
  await f.automation.sessions(f.users.full!,f.source.id,{action:"manage",id:target.id,purpose:"Fixture",requestID:requestId});const grant=await f.automation.decideCoordination(f.users.read!,f.projectA,requestId,true);
  let admitted=0;f.conversations.admit=async()=>{admitted++;throw new Error("Uncertain native acknowledgment");};
  const input={action:"send",id:target.id,epoch:grant.epoch,text:"One instruction",requestID:randomUUID()};
  await assert.rejects(f.automation.sessions(f.users.full!,f.source.id,input),/Uncertain/);
  const retry:any=await f.automation.sessions(f.users.full!,f.source.id,input);assert.equal(retry.status,"uncertain");await f.automation.tick();assert.equal(admitted,1);
});
test("goal continuation uses durable admission once and blocks a turn without new progress",async t=>{
  const f=await fixture(t),created:any=await f.automation.goal(f.users.full!,f.source.id,{action:"set",objective:"Explicit synthetic persistent goal",turnBudget:3});
  await f.automation.tick();await f.automation.tick();
  const inputs=await f.db.all<any>("SELECT * FROM conversation_inputs WHERE conversation_id=?",[f.source.id]);assert.equal(inputs.length,1);
  await f.db.run("UPDATE conversation_runs SET status='completed' WHERE conversation_id=?",[f.source.id]);await f.db.run("UPDATE conversation_inputs SET delivery='accepted' WHERE conversation_id=?",[f.source.id]);
  await f.automation.tick();const final:any=await f.automation.goal(f.users.full!,f.source.id);
  assert.equal(final.goal.status,"blocked");assert.match(final.goal.evidence,/checkpoint/);
  assert.equal((await f.db.get<any>("SELECT COUNT(*) count FROM conversation_inputs WHERE conversation_id=?",[f.source.id]))!.count,1);
  await assert.rejects(f.automation.goal(f.users.full!,f.source.id,{action:"resume",id:"foreign-goal"}),/changed/);
  assert.equal(created.goal.objective,"Explicit synthetic persistent goal");
});
for(const variant of ["tokens","missing","failure"]as const)test("goal accounting fences "+variant,async t=>{
  const f=await fixture(t),{run}=await active(f),created:any=await f.automation.goal(f.users.full!,f.source.id,{action:"set",objective:"Explicit budget goal",tokenBudget:10},run);
  await f.automation.goal(f.users.full!,f.source.id,{action:"checkpoint",id:created.goal.id,evidence:"Measured synthetic progress"});
  await f.db.run("UPDATE conversation_runs SET status=? WHERE id=?",[variant==="failure"?"interrupted":"completed",run]);
  if(variant==="tokens")await f.db.run("INSERT INTO conversation_events(conversation_id,run_id,type,data,created_at) VALUES(?,?,'native.usage',?,?)",[f.source.id,run,JSON.stringify({totalTokens:10}),new Date().toISOString()]);
  await f.automation.tick();const result:any=await f.automation.goal(f.users.full!,f.source.id);
  assert.equal(result.goal.status,variant==="tokens"?"budget_limited":"blocked");
  assert.equal((await f.db.get<any>("SELECT COUNT(*) count FROM workspace_agent_deliveries WHERE kind='goal'"))!.count,0);
});
test("Stop and authority removal pause unattended goal/timer work before further admission",async t=>{
  const f=await fixture(t),{run}=await active(f);
  await f.automation.goal(f.users.full!,f.source.id,{action:"set",objective:"Synthetic cancellable goal"},run);
  const timer:any=await f.automation.timers(f.users.full!,f.source.id,{action:"create",text:"Future fixture",at:new Date(Date.now()+60000).toISOString(),requestID:randomUUID()});
  await f.conversations.cancel(f.users.read!,f.source.id,run);
  assert.equal((await f.automation.goal(f.users.full!,f.source.id)as any).goal.status,"paused");
  assert.equal((await f.automation.timers(f.users.full!,f.source.id,{action:"list"})).items.find((item:any)=>item.id===timer.id)!.status,"paused");
  await f.automation.goal(f.users.full!,f.source.id,{action:"set",objective:"Goal must lose access"});
  await f.db.run("DELETE FROM project_members WHERE project_id=? AND user_id=?",[f.projectA,f.users.full!.id]);await f.automation.tick();
  const row=await f.db.get<any>("SELECT data FROM workspace_goals WHERE conversation_id=?",[f.source.id]);assert.equal(JSON.parse(row.data).status,"paused");
});
test("timers skip missed bursts, serialize current-chat work, pause on disable and reject stale updates",async t=>{
  const f=await fixture(t),now=new Date(),created:any=await f.automation.timers(f.users.full!,f.source.id,{action:"create",text:"Synthetic repeated timer",at:new Date(now.getTime()-100000).toISOString(),every:1,requestID:randomUUID()});
  await f.automation.tick(now);await f.automation.tick(new Date(now.getTime()+10000));
  assert.equal((await f.db.get<any>("SELECT COUNT(*) count FROM workspace_agent_deliveries WHERE kind='timer'"))!.count,1);
  const timer=await f.db.get<any>("SELECT * FROM workspace_session_timers WHERE id=?",[created.id]);assert.ok(timer.next_at>now.toISOString());
  await assert.rejects(f.automation.timers(f.users.full!,f.source.id,{action:"pause",id:created.id,revision:0}),/changed/);
  await f.request("read","PATCH","/enterprise/api/conversations/"+f.source.id+"/tools",{group:"timers",enabled:false});
  assert.equal((await f.db.get<any>("SELECT status FROM workspace_session_timers WHERE id=?",[created.id]))!.status,"paused");
  await f.request("read","PATCH","/enterprise/api/conversations/"+f.source.id+"/tools",{group:"timers",enabled:true});
  assert.equal((await f.db.get<any>("SELECT status FROM workspace_session_timers WHERE id=?",[created.id]))!.status,"paused");
});
test("automation APIs do not expose foreign goals, timers, browser or coordination requests",async t=>{
  const f=await fixture(t);
  for(const suffix of ["/goal","/timers"])assert.equal((await f.request("other","GET","/enterprise/api/conversations/"+f.source.id+suffix)).statusCode,404);
  assert.equal((await f.request("other","POST","/enterprise/api/conversations/"+f.source.id+"/browser",{action:"tabs"})).statusCode,404);
  assert.equal((await f.request("other","GET","/enterprise/api/projects/"+f.projectA+"/coordination-requests")).statusCode,404);
});
test("every harness gets MCP-first instructions while assets keep dedicated scoped authority",async()=>{
  const instructions=await readFile("platform/runtime/AGENTS.md","utf8");
  assert.match(instructions,/Woven MCP tools first/);assert.match(instructions,/wme-workspace remains a deliberate compatibility fallback/);assert.match(instructions,/Asset conversations retain only their dedicated asset operation/);
  assert.match(agentInstructions,/typed Woven MCP/);assert.match(agentInstructions,/Asset chats keep their dedicated wme-asset authority/);
  for(const name of ["woven_sessions_create","woven_goals_set","woven_timers_create","woven_browser","woven_executor_execute"])assert.doesNotThrow(()=>workspaceToolCall(name,Object.fromEntries((name==="woven_sessions_create"?[["title","X"],["text","Y"],["purpose","Z"],["requestID",randomUUID()]]:name==="woven_goals_set"?[["objective","Explicit goal"]]:name==="woven_timers_create"?[["text","Later"],["at",new Date().toISOString()],["requestID",randomUUID()]]:name==="woven_browser"?[["action","tabs"]]:[["code","return 1"],["requestID",randomUUID()]]))));
});

test("human browser enablement uses current chat controls without starting a native turn and disable denies immediately",async t=>{
 let calls=0,turns=0;
 const f=await platformFixture(t,{startConversations:false,runtime:{async ensureProject(){},async execute(){turns++;},async recover(){return [];},async cancel(){},async browser(_project,_chat,input){calls++;return {input};}}});
 const chat=await f.conversations.create(f.users.full!,f.projectA,{title:"Retained browser fixture"}),base="/enterprise/api/conversations/"+chat.id;
 await f.request("read","PATCH",base+"/tools",{group:"browser",enabled:false});
 assert.equal((await f.request("full","POST",base+"/browser",{action:"tabs"})).statusCode,403);assert.equal(calls,0);
 await f.request("read","PATCH",base+"/tools",{group:"browser",enabled:true});
 assert.equal((await f.request("full","POST",base+"/browser",{action:"tabs"})).statusCode,200);assert.equal(calls,1);assert.equal(turns,0);
 await f.request("read","PATCH",base+"/tools",{group:"browser",enabled:false});
 assert.equal((await f.request("full","POST",base+"/browser",{action:"tabs"})).statusCode,403);assert.equal(calls,1);
});

test("pre-upgrade personal tool defaults retain old choices while new groups get explicit safe defaults",async t=>{
 const f=await fixture(t);
 await f.db.run("INSERT INTO personal_preferences(user_id,settings) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings=excluded.settings",[f.users.full!.id,JSON.stringify({tools:{notes:false,history:true,usage:false,calendar:true,library:true}})]);
 const preferences=(await f.request("full","GET","/enterprise/api/me/preferences")).json();
 assert.equal(preferences.tools.notes,false);assert.equal(preferences.tools.usage,false);assert.equal(preferences.tools.browser,true);assert.equal(preferences.tools.executor,false);
});

test("running delivery receipts reach completion so recurring timers can admit the next occurrence",async t=>{
 const f=await fixture(t),now=new Date();
 await f.automation.timers(f.users.full!,f.source.id,{action:"create",text:"Lifecycle fixture",at:now.toISOString(),every:1,requestID:randomUUID()});
 await f.automation.tick(now);
 const first=await f.db.get<any>("SELECT * FROM workspace_agent_deliveries WHERE kind='timer'");
 await f.db.run("UPDATE conversation_runs SET status='running' WHERE id=?",[first.run_id]);await f.db.run("UPDATE conversation_inputs SET delivery='accepted' WHERE request_id=?",[first.id]);
 await f.automation.tick(now);assert.equal((await f.db.get<any>("SELECT status FROM workspace_agent_deliveries WHERE id=?",[first.id])).status,"running");
 await f.db.run("UPDATE conversation_runs SET status='completed' WHERE id=?",[first.run_id]);
 await f.automation.tick(new Date(now.getTime()+2000));
 assert.equal((await f.db.get<any>("SELECT status FROM workspace_agent_deliveries WHERE id=?",[first.id])).status,"completed");
 assert.equal((await f.db.get<any>("SELECT COUNT(*) count FROM workspace_agent_deliveries WHERE kind='timer'")).count,2);
});
