import test from "node:test";
import {request as httpRequest} from "node:http";
import assert from "node:assert/strict";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {platformFixture} from "./fixtures/platform.js";
async function setup(t:any,scopes=["notes","history"]){
 const f=await platformFixture(t,{startConversations:false}),base="/enterprise/api/projects/"+f.projectA+"/mcp-access";
 const issued=await f.request("full","POST",base,{label:"Synthetic outside agent",hours:1,scopes});assert.equal(issued.statusCode,200,issued.body);const grant=issued.json();
 await f.app.listen({host:"127.0.0.1",port:0});const address=f.app.server.address()as any,url="http://127.0.0.1:"+address.port+"/enterprise/api/mcp/"+f.projectA;
 const client=new Client({name:"Synthetic outside agent",version:"1"},{capabilities:{}});
 await client.connect(new StreamableHTTPClientTransport(new URL(url),{fetch:async(input,init)=>new Promise<Response>((resolve,reject)=>{
  // Node fetch normalizes Host; this actual HTTP fixture retains the configured portal host.
  const request=httpRequest(String(input),{method:init?.method,headers:{...Object.fromEntries(new Headers(init?.headers)),"host":"portal.test"}},response=>{const chunks:Buffer[]=[];response.on("data",chunk=>chunks.push(Buffer.from(chunk)));response.on("end",()=>resolve(new Response(response.statusCode===202?null:Buffer.concat(chunks),{status:response.statusCode,headers:response.headers as Record<string,string>})));});request.once("error",reject);request.end(init?.body);
 }),requestInit:{headers:{host:"portal.test",authorization:"Bearer "+grant.token}}}));t.after(()=>client.close());
 return {...f,base,grant,client,url};
}
test("outside MCP grants are explicit, expiring, hashed, private and expose only selected read tools",async t=>{
 const f=await setup(t),catalog=await f.client.listTools();
 assert.ok(catalog.tools.some(tool=>tool.name==="woven_notes_read"));assert.ok(catalog.tools.some(tool=>tool.name==="woven_history_read"));
 assert.ok(catalog.tools.every(tool=>tool.annotations?.readOnlyHint===true));assert.equal(catalog.tools.some(tool=>/create|update|remove|executor|browser|goals|timers|calendar|usage/.test(tool.name)),false);
 const listed=await f.request("full","GET",f.base);assert.equal(listed.body.includes(f.grant.token),false);
 assert.deepEqual((await f.request("read","GET",f.base)).json().items,[]);assert.equal((await f.request("read","DELETE",f.base+"/"+f.grant.id)).statusCode,404);
 const stored=await f.db.get<any>("SELECT token_hash FROM workspace_mcp_grants WHERE id=?",[f.grant.id]);assert.notEqual(stored.token_hash,f.grant.token);assert.equal(stored.token_hash.length,64);
 const bad=await f.client.callTool({name:"woven_notes_create",arguments:{title:"Denied"}});assert.equal(bad.isError,true);
 const list=await f.client.callTool({name:"woven_notes_list",arguments:{}});assert.equal(list.isError,undefined);
 await f.request("full","DELETE",f.base+"/"+f.grant.id);await assert.rejects(f.client.listTools());
});
test("scoped bearer never authenticates another workspace, expired grant or revoked member",async t=>{
 const f=await setup(t,["usage"]),headers={host:"portal.test",authorization:"Bearer "+f.grant.token,accept:"application/json,text/event-stream"};
 const request={jsonrpc:"2.0",id:1,method:"tools/list",params:{}};
 assert.equal((await f.app.inject({method:"POST",url:"/enterprise/api/mcp/"+f.projectB,headers,payload:request})).statusCode,403);
 assert.equal((await f.app.inject({method:"POST",url:"/enterprise/api/mcp/"+f.projectA,headers:{...headers,origin:"https://untrusted.example"},payload:request})).statusCode,403);
 assert.equal((await f.app.inject({method:"POST",url:"/enterprise/api/mcp/"+f.projectA,headers:{host:"portal.test",cookie:f.headers.full!.cookie},payload:request})).statusCode,401);
 await f.db.run("UPDATE workspace_mcp_grants SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",[f.grant.id]);await assert.rejects(f.client.listTools());
 await f.db.run("UPDATE workspace_mcp_grants SET expires_at=? WHERE id=?",[new Date(Date.now()+60000).toISOString(),f.grant.id]);
 await f.db.run("DELETE FROM project_members WHERE project_id=? AND user_id=?",[f.projectA,f.users.full!.id]);await assert.rejects(f.client.listTools());
});
test("outside reads preserve content-family scope and recheck revocation before returning data",async t=>{
 const f=await setup(t),note=await f.workspaceContent.service.create(f.users.full!,f.projectA,{kind:"note",title:"Private workspace note",body:"Synthetic read result"}),event=await f.workspaceContent.service.create(f.users.full!,f.projectA,{kind:"event",title:"Not in grant",data:{startsAt:"2030-01-01T12:00:00.000Z",timeZone:"UTC"}});
 const read=await f.client.callTool({name:"woven_notes_read",arguments:{id:note.id}});assert.ok(JSON.stringify(read).includes("Synthetic read result"));
 assert.equal((await f.client.callTool({name:"woven_notes_read",arguments:{id:event.id}})).isError,true);
 const original=f.workspaceContent.service.require.bind(f.workspaceContent.service);
 f.workspaceContent.service.require=async(...args)=>{const row=await original(...args);await f.db.run("UPDATE workspace_mcp_grants SET revoked=1 WHERE id=?",[f.grant.id]);return row;};
 const revoked=await f.client.callTool({name:"woven_notes_read",arguments:{id:note.id}});assert.equal(revoked.isError,true);assert.equal(JSON.stringify(revoked).includes("Synthetic read result"),false);
});
