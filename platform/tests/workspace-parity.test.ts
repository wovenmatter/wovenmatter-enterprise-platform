import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { readFile,stat } from "node:fs/promises";
import { join } from "node:path";
import { platformFixture } from "./fixtures/platform.js";
import { migratePreferences } from "../apps/api/src/preferences.js";
import { executeSearch } from "../apps/api/src/workspace-content/search.js";
import { saveConversationHTML,htmlDocument } from "../apps/api/src/workspace-content/html.js";
import { workspaceUsage } from "../apps/api/src/workspace-content/library.js";
import { mcpRequest } from "../packages/runtime/src/workspace-mcp.js";
import { workspaceTools,workspaceToolCall } from "../packages/runtime/src/workspace-tools.js";

test("shared defaults are tenant scoped, administrator managed, inherited per harness and captured once",async t=>{
  const f=await platformFixture(t,{startConversations:false}),shared="/enterprise/api/organizations/"+f.orgA+"/agent-settings",local="/enterprise/api/projects/"+f.projectA+"/agent-settings";
  for(const actor of ["full","read","other"])assert.equal((await f.request(actor,"PATCH",shared,{harness:"pi",settings:{codeMode:"only"},revision:0})).statusCode,actor==="other"?404:403);
  assert.equal((await f.request("admin","PATCH",shared,{harness:"pi",settings:{codeMode:"only",subagentConcurrency:3,tools:{notes:false}},revision:0})).statusCode,200);
  let value=(await f.request("read","GET",local)).json();assert.equal(value.agents.pi.codeMode,"only");assert.equal(value.overrides.agents,undefined);
  const old=await f.conversations.create(f.users.full!,f.projectA,{});
  assert.equal(old.pi?.codeMode,"only");assert.equal(old.tools?.notes,false);
  for(const actor of ["full","read","other"])assert.equal((await f.request(actor,"PATCH",local,{harness:"pi",settings:{codeMode:"off"},revision:value.revision})).statusCode,actor==="other"?404:403);
  const patched=await f.request("admin","PATCH",local,{harness:"pi",settings:{codeMode:"off"},revision:value.revision});assert.equal(patched.statusCode,200,patched.body);
  value=patched.json();assert.equal(value.agents.pi.codeMode,"off");
  assert.equal((await f.request("admin","PATCH",local,{harness:"codex",settings:{permission:"agent-full-access"},revision:null})).statusCode,409);
  assert.equal((await f.conversations.get(f.users.full!,old.id)).pi?.codeMode,"only");
  assert.equal((await f.conversations.create(f.users.full!,f.projectA,{})).pi?.codeMode,"off");
  assert.equal((await f.request("admin","PATCH",local,{harness:"pi",settings:null,revision:value.revision})).json().agents.pi.codeMode,"only");
  assert.equal((await f.request("other","GET",shared)).statusCode,404);
});

test("preferences and dictations are private, bounded, persistent and require CSRF",async t=>{
  const f=await platformFixture(t,{startConversations:false});
  assert.equal((await f.request("full","PATCH","/enterprise/api/me/preferences",{dictationLanguage:"en-US",tools:{history:false}})).statusCode,200);
  assert.equal((await f.request("full","GET","/enterprise/api/me/preferences")).json().tools.history,false);
  assert.equal((await f.request("read","GET","/enterprise/api/me/preferences")).json().tools.history,true);
  assert.equal((await f.conversations.create(f.users.full!,f.projectA,{})).tools?.history,false);
  assert.equal((await f.request("full","PATCH","/enterprise/api/me/preferences",{dictationLanguage:"bad language"})).statusCode,400);
  assert.equal((await f.request("full","PATCH","/enterprise/api/me/preferences",{tools:{computer:true}})).statusCode,400);
  const created=await f.request("full","POST","/enterprise/api/me/dictations",{text:"Private synthetic dictation",language:"en-US"});
  assert.equal(created.statusCode,200,created.body);
  assert.equal((await f.request("read","GET","/enterprise/api/me/dictations")).json().items.length,0);
  await f.request("read","DELETE","/enterprise/api/me/dictations/"+created.json().id);
  assert.equal((await f.request("full","GET","/enterprise/api/me/dictations?search=synthetic")).json().items.length,1);
  assert.equal((await f.request("full","GET","/enterprise/api/me/dictations?search=missing")).json().items.length,0);
  assert.equal((await f.request("full","POST","/enterprise/api/me/dictations",{text:"x".repeat(100001)})).statusCode,400);
  const headers={...f.headers.full};delete (headers as any)["x-csrf-token"];
  assert.equal((await f.app.inject({method:"POST",url:"/enterprise/api/me/dictations",headers,payload:{text:"denied"}})).statusCode,403);
  await f.request("full","DELETE","/enterprise/api/me/dictations/"+created.json().id);
  assert.equal((await f.request("full","GET","/enterprise/api/me/dictations")).json().items.length,0);
});

test("idempotent upgrade retains legacy workspace defaults, chats and native state",async t=>{
  const f=await platformFixture(t,{startConversations:false}),chat=await f.conversations.create(f.users.full!,f.projectA,{title:"Legacy retained chat"});
  const legacy={defaultHarness:"codex",agents:{codex:{permission:"agent-full-access"},pi:{codeMode:"only",subagentConcurrency:7}}};
  await f.db.run("INSERT INTO workspace_agent_settings(project_id,settings,updated_at,updated_by) VALUES(?,?,?,?)",[f.projectA,JSON.stringify(legacy),new Date().toISOString(),f.users.admin!.id]);
  const before=await f.db.all("SELECT id,title,runtime_generation,native_options,pi_options FROM conversations");
  await migratePreferences(f.ctx);await migratePreferences(f.ctx);
  assert.deepEqual(await f.db.all("SELECT id,title,runtime_generation,native_options,pi_options FROM conversations"),before);
  const settings=await f.conversations.agentSettings(f.users.full!,f.projectA);
  assert.equal(settings.defaultHarness,"codex");assert.deepEqual(settings.agents,legacy.agents);
  assert.equal((await f.conversations.get(f.users.full!,chat.id)).title,"Legacy retained chat");
});

test("search account mutation is admin only and responses never disclose saved keys",async t=>{
  const f=await platformFixture(t,{startConversations:false}),base="/enterprise/api/organizations/"+f.orgA+"/search-accounts",key="synthetic-search-key-fixture-only";
  for(const actor of ["full","read","other"])assert.equal((await f.request(actor,"PUT",base+"/exa",{apiKey:key})).statusCode,actor==="other"?404:403);
  assert.equal((await f.request("admin","PUT",base+"/exa",{apiKey:key})).statusCode,200);
  const status=await f.request("full","GET",base);assert.equal(status.statusCode,200);assert.equal(status.body.includes(key),false);assert.equal(status.json().items[0].configured,true);
  const path=join(f.stateDir,"control/search-accounts",f.orgA,"exa.json");
  assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(JSON.parse(await readFile(path,"utf8")).key,key);
  assert.equal((await f.request("other","GET",base)).statusCode,404);
  await f.request("admin","DELETE",base+"/exa");
  assert.equal((await f.request("full","GET",base)).json().items[0].configured,false);
});

test("all three desktop search contracts are bounded and provider failures redact credentials",async()=>{
  const seen:{url:string;options:RequestInit}[]=[];
  const fetcher=async(input:any,options:any)=>{seen.push({url:String(input),options});return new Response(JSON.stringify(input.includes("exa")?{results:[{title:"Result",url:"https://example.test",text:"x".repeat(20000)}]}:input.includes("brave")?{grounding:{generic:[{title:"Brave",url:"https://example.test",snippets:["Context"]}]}}:{data:{web:[{title:"Firecrawl",url:"https://example.test",markdown:"Read"}]}}));};
  for(const selected of ["exa","brave","firecrawl"] as const){const result=await executeSearch(selected,"secret-synthetic-key",{query:"synthetic"},fetcher);assert.equal(result.results.length,1);assert.ok((result.results[0].text?.length??0)<=16000);}
  assert.ok(seen[0]!.url.endsWith("/search"));assert.ok(seen[1]!.url.endsWith("/llm/context"));assert.ok(seen[2]!.url.endsWith("/v2/search"));
  await assert.rejects(executeSearch("brave","secret",{url:"https://example.test"},fetcher),/search only/);
  await assert.rejects(executeSearch("exa","secret",{url:"file:\/\/etc/passwd"},fetcher),/public HTTP/);
  await assert.rejects(executeSearch("exa","secret",{query:"test"},async()=>{throw new Error("secret");}),error=>!String(error).includes("secret"));
});

test("MCP publishes typed tools, rejects unknown arguments and never elevates arbitrary commands",async()=>{
  const list=await mcpRequest({method:"tools/list"}) as any;
  assert.equal(list.tools.length,workspaceTools.length);
  assert.equal(list.tools.find((tool:any)=>tool.name==="woven_notes_create").annotations.readOnlyHint,false);
  assert.throws(()=>workspaceToolCall("woven_notes_create",{title:"Note",command:"cat /etc/passwd"}),/Unknown/);
  assert.throws(()=>workspaceToolCall("woven_history_read",{id:42}),/Invalid/);
  assert.throws(()=>workspaceToolCall("host_exec",{}),/Unknown/);
  const called=await mcpRequest({method:"tools/call",params:{name:"woven_usage_read",arguments:{}}},async(name,args)=>({content:[{type:"text",text:JSON.stringify({name,args})}],structuredContent:{}}));
  assert.ok(JSON.stringify(called).includes("woven_usage_read"));
  const error=await mcpRequest({method:"tools/call",params:{name:"woven_usage_read"}},async()=>{throw new TypeError("credential-secret");});
  assert.equal(JSON.stringify(error).includes("credential-secret"),false);
});

async function running(f:Awaited<ReturnType<typeof platformFixture>>) {
  const chat=await f.conversations.create(f.users.full!,f.projectA,{}),run=randomUUID(),message=randomUUID(),assistant=randomUUID(),at=new Date().toISOString(),token="wme_run_"+randomUUID();
  for(const[id,role]of[[message,"user"],[assistant,"assistant"]])await f.db.run("INSERT INTO conversation_messages(id,conversation_id,role,author_id,content,created_at) VALUES(?,?,?,?,?,?)",[id!,chat.id,role!,f.users.full!.id,"Synthetic",at]);
  await f.db.run("INSERT INTO conversation_runs(id,conversation_id,org_id,project_id,user_id,request_id,user_message_id,assistant_message_id,status,mode,harness,model,created_at) VALUES(?,?,?,?,?,?,?,?,'running','write','pi','fixture',?)",[run,chat.id,f.orgA,f.projectA,f.users.full!.id,randomUUID(),message,assistant,at]);
  await f.db.run("INSERT INTO inference_gateway_tokens(token_hash,org_id,project_id,user_id,run_id,conversation_id,model,harness,expires_at,revoked) VALUES(?,?,?,?,?,?,'fixture','pi',?,0)",[createHash("sha256").update(token).digest("hex"),f.orgA,f.projectA,f.users.full!.id,run,chat.id,new Date(Date.now()+60000).toISOString()]);
  return {chat,run,token};
}
test("HTML is durable, idempotent, scoped to current conversation, isolated and unavailable after revocation",async t=>{
  const f=await platformFixture(t,{startConversations:false}),{chat,run,token}=await running(f),html="<button onclick=\"this.textContent='Clicked'\">Interact</button>",input={html,title:"Synthetic visual",height:200,requestID:randomUUID()};
  const publish=await f.app.inject({method:"POST",url:"/enterprise/api/runtime/inference/"+f.projectA+"/workspace/html",headers:{host:"portal.test",authorization:"Bearer "+token},payload:input});
  assert.equal(publish.statusCode,200,publish.body);
  const page=publish.json();assert.equal((await saveConversationHTML(f.ctx,chat.id,run,input)).id,page.id);
  await assert.rejects(saveConversationHTML(f.ctx,chat.id,run,{...input,html:"changed"}),/already used/);
  const path="/enterprise/api/conversations/"+chat.id+"/html/"+page.id,loaded=await f.request("read","GET",path);
  assert.equal(loaded.statusCode,200);assert.ok(loaded.body.includes(html));assert.ok(loaded.headers["content-security-policy"]?.includes("connect-src 'none'"));
  assert.equal((await f.request("other","GET",path)).statusCode,404);
  assert.equal((await f.db.get<any>("SELECT COUNT(*) count FROM conversation_activity WHERE kind='html'"))!.count,1);
  await f.db.run("DELETE FROM project_members WHERE project_id=? AND user_id=?",[f.projectA,f.users.full!.id]);
  assert.equal((await f.request("full","GET",path)).statusCode,404);
  assert.equal((await f.app.inject({method:"POST",url:"/enterprise/api/runtime/inference/"+f.projectA+"/workspace/html",headers:{host:"portal.test",authorization:"Bearer "+token},payload:{...input,requestID:randomUUID()}})).statusCode,403);
  assert.ok(htmlDocument(html).startsWith("<!doctype html>"));
});

test("usage aggregates exact measurements without invented missing costs and filters tenant activity",async t=>{
  const f=await platformFixture(t,{startConversations:false}),{chat,run}=await running(f),at=new Date().toISOString();
  for(const usage of [{totalTokens:15,input:10,output:5},{totalTokens:8,input:6,output:2}])await f.db.run("INSERT INTO conversation_events(conversation_id,run_id,type,data,created_at) VALUES(?,?,'native.usage',?,?)",[chat.id,run,JSON.stringify(usage),at]);
  const result=await workspaceUsage(f.ctx,f.users.full!,f.projectA);
  assert.equal(result.items[0].totalTokens,23);assert.equal(result.items[0].inputTokens,16);assert.equal(result.items[0].outputTokens,7);assert.equal(result.items[0].cost,null);assert.equal(result.items[0].measuredRuns,1);
  assert.equal((await workspaceUsage(f.ctx,f.users.full!,f.projectA,{harness:"codex"})).items.length,0);
  await assert.rejects(workspaceUsage(f.ctx,f.users.other!,f.projectA),/access|member|organization/i);
});

test("execution inventory exposes scoped active work without host paths or unrelated tenants",async t=>{
  const f=await platformFixture(t,{startConversations:false}),{run}=await running(f),path="/enterprise/api/projects/"+f.projectA+"/execution",response=await f.request("read","GET",path);
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().architecture,"persistent-container");assert.equal(response.json().runs[0].id,run);assert.equal(response.body.includes(f.stateDir),false);
  assert.equal((await f.request("other","GET",path)).statusCode,404);assert.equal((await f.request(undefined,"GET",path)).statusCode,401);
});


test("calendar read-only agent policy preserves reads and human edits while fencing broker writes",async t=>{
  const f=await platformFixture(t,{startConversations:false}),{token}=await running(f),note=await f.workspaceContent.service.create(f.users.full!,f.projectA,{kind:"event",title:"Read-only fixture",data:{startsAt:"2026-10-27T12:00:00.000Z"}});
  await f.request("full","PATCH","/enterprise/api/me/preferences",{calendarAccess:"readOnly"});
  const call=(operation:string,payload:unknown)=>f.app.inject({method:"POST",url:"/enterprise/api/runtime/inference/"+f.projectA+"/workspace/"+operation,headers:{host:"portal.test",authorization:"Bearer "+token},payload:payload as any});
  assert.equal((await call("read",{id:note.id})).statusCode,200);assert.equal((await call("update",{id:note.id,expectedRevision:1,title:"Denied"})).statusCode,403);
  assert.equal((await f.request("full","PATCH","/enterprise/api/projects/"+f.projectA+"/workspace-content/"+note.id,{expectedRevision:1,title:"Human edit"})).statusCode,200);
});
