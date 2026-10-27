import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {randomUUID} from "node:crypto";
import {platformFixture} from "./fixtures/platform.js";
async function fixture(t:any){
  const key="a".repeat(64),connections=new Map<string,unknown>(),calls:{path:string;authorization:string;body:any}[]=[];
  let origin="",programCalls=0,redirect=false,uncertain=false;let beforeInitialize:(()=>Promise<void>)|undefined;
  const server=createServer(async(request,response)=>{
    let source="";for await(const part of request)source+=part;
    const url=new URL(request.url!,origin),body=source?request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")?Object.fromEntries(new URLSearchParams(source)):JSON.parse(source):{};
    const path=url.pathname,authorization=String(request.headers.authorization??"");calls.push({path,authorization,body});
    const reply=(value:unknown,status=200,headers:Record<string,string>={})=>{response.writeHead(status,{"content-type":"application/json",...headers});response.end(JSON.stringify(value));};
    if(path==="/v1/apps"){if(redirect){response.writeHead(302,{location:"http://127.0.0.1:1/private"});response.end();return;}return reply({apps:[],version:"2.0.0"},authorization==="Bearer "+key?200:401);}
    if(path==="/dashboard/api/overview")return reply({apps:[{id:"fixture-app",name:"Scoped fixture app",requirements:{accounts:{primary:{scope:"user"}}}},{id:"manager",name:"Manager",owner:"executor-local"}],accounts:[{id:"fixture-account",label:"Synthetic shared account"}],links:[{app:"fixture-app",account:"fixture-account"}]});
    if(path.startsWith("/dashboard/api/mcp/connections")){if(authorization!=="Bearer "+key)return reply({},403);const id=path.split("/").at(-1)==="connections"?body.id:path.split("/").at(-1);connections.set(id,body.apps);return reply({id});}
    if(path==="/auth/pair")return reply({url:origin+"/#pair=synthetic-pair"});
    if(path==="/auth/exchange")return reply({ok:true},200,{"set-cookie":"executor_fixture=synthetic; HttpOnly"});
    if(path==="/api/auth/oauth2/register")return reply({client_id:"synthetic-client"});
    if(path==="/api/auth/oauth2/authorize")return reply({url:origin+"/consent"+url.search});
    if(path==="/api/auth/oauth2/consent"){const query=new URLSearchParams(body.oauth_query);return reply({url:"http://127.0.0.1:9/woven-executor-callback?code=synthetic&state="+query.get("state")});}
    if(path==="/api/auth/oauth2/token"){const resource=new URL(body.resource);return reply({access_token:"scoped-"+resource.searchParams.get("connection"),refresh_token:"synthetic-refresh",expires_in:3600});}
    if(path==="/mcp"){
      if(request.method==="GET"){response.writeHead(405);response.end();return;}
      const connection=url.searchParams.get("connection");
      if(authorization!=="Bearer scoped-"+connection||!connections.has(connection!))return reply({},403);
      if(body.id===undefined){response.writeHead(202);response.end();return;}
      if(body.method==="initialize"){await beforeInitialize?.();return reply({jsonrpc:"2.0",id:body.id,result:{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"Synthetic Executor V2",version:"2.0.0"}}});}
      if(body.method==="tools/call"){
        programCalls++;if(uncertain){request.socket.destroy();return;}
        const result=body.params.name==="execute"&&body.params.arguments.code.includes("approval")?{status:"approval-required",requestId:"synthetic-action"}:{status:"completed",profiles:connections.get(connection!),value:"Synthetic app result"};
        return reply({jsonrpc:"2.0",id:body.id,result:{content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result}});
      }
      return reply({jsonrpc:"2.0",id:body.id,result:{tools:[]}});
    }
    return reply({error:"unsupported fixture path"},404);
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));origin="http://127.0.0.1:"+(server.address()as any).port;
  const f=await platformFixture(t,{startConversations:false});f.ctx.config.executorOrigins=[origin];
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const chat=await f.conversations.create(f.users.full!,f.projectA,{title:"Executor fixture"});
  return {...f,key,origin,calls,chat,connections,programCalls:()=>programCalls,beforeInitialize:(handler:()=>Promise<void>)=>{beforeInitialize=handler;},setRedirect:(value:boolean)=>{redirect=value;},setUncertain:(value:boolean)=>{uncertain=value;},service:f.workspaceContent.executor};
}
async function prepared(t:any,harness="pi",permission?:string){
  const f=await fixture(t);
  if(harness!=="pi")await f.db.run("UPDATE conversations SET harness=?,native_options=? WHERE id=?",[harness,JSON.stringify(permission?{permission}:{}),f.chat.id]);
  await f.service.configure(f.users.admin!,f.orgA,{origin:f.origin,apiKey:f.key});
  await f.request("read","PATCH","/enterprise/api/conversations/"+f.chat.id+"/tools",{group:"executor",enabled:true});
  await f.service.setProfiles(f.users.read!,f.chat.id,["fixture-app:account:fixture-account"]);
  return f;
}
async function settled(service:any,user:any,chat:string,id:string){
  for(let index=0;index<200;index++){const status=await service.tool(user,chat,{action:"status",id});if(!["running","awaiting-approval"].includes(status.status))return status;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error("Synthetic Executor did not settle.");
}
test("Executor configuration uses only operator-approved origins and keeps management keys server side",async t=>{
  const f=await fixture(t),base="/enterprise/api/organizations/"+f.orgA+"/executor";
  assert.equal((await f.request("full","PUT",base,{origin:f.origin,apiKey:f.key})).statusCode,403);
  assert.equal((await f.request("admin","PUT",base,{origin:"http://169.254.169.254",apiKey:f.key})).statusCode,403);
  const saved=await f.request("admin","PUT",base,{origin:f.origin,apiKey:f.key});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.body.includes(f.key),false);
  assert.equal(saved.json().apps.length,1,"The service management app is never granted to an agent");
  assert.equal((await f.request("other","GET",base)).statusCode,404);
  const status=await f.request("full","GET",base);assert.equal(status.statusCode,200);assert.equal(status.body.includes(f.key),false);
  await assert.rejects(f.service.configure(f.users.admin!,f.orgA,{origin:f.origin,apiKey:"b".repeat(64)}),/previous configuration was retained/);
  assert.equal((await f.service.status(f.users.full!,f.orgA)).configured,true);
});
test("actual V2 service profile scopes and MCP program calls never expose manager authority",async t=>{
  const f=await prepared(t),requestID=randomUUID(),result=await f.service.tool(f.users.full!,f.chat.id,{action:"execute",code:"return 1",requestID});
  const final=await settled(f.service,f.users.full!,f.chat.id,result.id);assert.equal(final.status,"completed",JSON.stringify(final));assert.equal(f.programCalls(),1);
  assert.equal(final.result.profiles.length,1);assert.deepEqual(final.result.profiles[0].runsAs,[{kind:"account",id:"fixture-account"}]);
  const mcp=f.calls.filter(call=>call.path==="/mcp");assert.ok(mcp.length>0);assert.ok(mcp.every(call=>call.authorization.startsWith("Bearer scoped-")));assert.ok(mcp.every(call=>!JSON.stringify(call).includes(f.key)));
  await f.service.tool(f.users.full!,f.chat.id,{action:"execute",code:"return 1",requestID});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.programCalls(),1);
  await assert.rejects(f.service.setProfiles(f.users.full!,f.chat.id,["manager:app"]),/current app profiles/);
  await assert.rejects(f.service.tool(f.users.other!,f.chat.id,{action:"execute",code:"return 2",requestID:randomUUID()}),/found|access|member/i);
});
test("external programs wait for current human approval when native Full Access is not confirmed",async t=>{
  const f=await prepared(t,"codex"),result=await f.service.tool(f.users.full!,f.chat.id,{action:"execute",code:"return 1",requestID:randomUUID()});
  assert.equal(result.status,"awaiting-approval");assert.equal(f.programCalls(),0);
  await assert.rejects(f.service.respond(f.users.other!,f.chat.id,result.id,{action:"accept"}),/found|access|member/i);
  await f.service.respond(f.users.read!,f.chat.id,result.id,{action:"accept"});
  const final=await settled(f.service,f.users.full!,f.chat.id,result.id);assert.equal(final.status,"completed",JSON.stringify(final));
  const second=await f.service.tool(f.users.full!,f.chat.id,{action:"execute",code:"return 2",requestID:randomUUID()});await f.service.respond(f.users.read!,f.chat.id,second.id,{action:"cancel"});assert.equal(f.programCalls(),1);
});
test("uncertain Executor transport is a durable interrupted receipt and the program is not replayed",async t=>{
  const f=await prepared(t);f.setUncertain(true);
  const input={action:"execute",code:"uncertain program",requestID:randomUUID()},result=await f.service.tool(f.users.full!,f.chat.id,input),final=await settled(f.service,f.users.full!,f.chat.id,result.id);
  assert.equal(final.status,"interrupted");assert.equal(f.programCalls(),1);
  f.setUncertain(false);await f.service.tool(f.users.full!,f.chat.id,input);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.programCalls(),1);
});
test("profile changes and disabled tools cancel pending app work and do not broaden grants",async t=>{
  const f=await prepared(t,"codex"),job=await f.service.tool(f.users.full!,f.chat.id,{action:"execute",code:"return 1",requestID:randomUUID()});
  await f.service.setProfiles(f.users.read!,f.chat.id,[]);assert.equal((await f.service.view(f.users.full!,f.chat.id)).jobs.find((item:any)=>item.id===job.id).status,"cancelled");
  await assert.rejects(f.service.tool(f.users.full!,f.chat.id,{action:"execute",code:"return 2",requestID:randomUUID()}),/Choose app profiles/);
  await f.service.setProfiles(f.users.read!,f.chat.id,["fixture-app:account:fixture-account"]);
  const second=await f.service.tool(f.users.full!,f.chat.id,{action:"execute",code:"return 3",requestID:randomUUID()});
  await f.request("read","PATCH","/enterprise/api/conversations/"+f.chat.id+"/tools",{group:"executor",enabled:false});
  assert.equal((await f.service.view(f.users.full!,f.chat.id)).jobs.find((item:any)=>item.id===second.id).status,"cancelled");assert.equal(f.programCalls(),0);
});
test("Executor rejects redirects before replacing the existing service configuration",async t=>{
  const f=await fixture(t);f.setRedirect(true);
  await assert.rejects(f.service.configure(f.users.admin!,f.orgA,{origin:f.origin,apiKey:f.key}),/could not be verified/);
  assert.equal((await f.service.status(f.users.full!,f.orgA)).configured,false);assert.equal(f.calls.some(call=>call.path==="/private"),false);
});

test("Executor rechecks membership after connecting and before dispatching any app program",async t=>{
 const f=await prepared(t);
 f.beforeInitialize(async()=>{await f.db.run("DELETE FROM project_members WHERE project_id=? AND user_id=?",[f.projectA,f.users.full!.id]);});
 const result=await f.service.tool(f.users.full!,f.chat.id,{action:"execute",code:"must never dispatch",requestID:randomUUID()});
 for(let n=0;n<100;n++){const view=await f.service.view(f.users.read!,f.chat.id);if(view.jobs[0]?.status==="interrupted")break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(f.programCalls(),0);
 assert.equal((await f.service.view(f.users.read!,f.chat.id)).jobs.find((item:any)=>item.id===result.id).status,"interrupted");
});
test("confirmed native deny permissions cannot execute external app programs",async t=>{
 const f=await prepared(t,"claude_code","dontAsk");
 await assert.rejects(f.service.tool(f.users.full!,f.chat.id,{action:"execute",code:"return 1",requestID:randomUUID()}),/does not permit/);assert.equal(f.programCalls(),0);
});
