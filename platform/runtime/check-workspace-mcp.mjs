// Run only in a disposable --network none container with the synthetic /session fixture.
// Uses the production built stdio entrypoint, fixed loopback broker and exact grant file.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {readFile} from "node:fs/promises";
const grant=JSON.parse(await readFile("/session/.wme-workspace.json","utf8"));
assert.equal(grant.token,"synthetic-current-run-capability-only");
let revoked=false,calls=0;
const server=createServer(async(req,res)=>{
  assert.equal(req.url,"/inference/workspace/list");assert.equal(req.headers.authorization,"Bearer "+grant.token);calls++;
  let body="";for await(const part of req)body+=part;
  assert.deepEqual(JSON.parse(body),{kind:"note"});
  res.setHeader("content-type","application/json");
  if(revoked){res.writeHead(403);res.end(JSON.stringify({error:{message:"The current run is revoked."}}));}
  else res.end(JSON.stringify({items:[{id:"synthetic-note",title:"Broker integration"}]}));
});
await new Promise(resolve=>server.listen(4101,"127.0.0.1",resolve));
const child=spawn(process.execPath,["/opt/runtime/src/workspace-mcp.js"],{stdio:["pipe","pipe","pipe"]}),pending=new Map();
createInterface({input:child.stdout}).on("line",line=>{const response=JSON.parse(line);pending.get(response.id)?.(response);pending.delete(response.id);});
let next=0;
async function request(method,params){const id=++next;const response=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("MCP response timed out")),10000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});});child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");return (await response).result;}
try {
  assert.equal((await request("initialize",{})).serverInfo.name,"wovenmatter-workspace");
  const tools=(await request("tools/list",{})).tools;assert.ok(tools.some(tool=>tool.name==="woven_notes_list"));
  const result=await request("tools/call",{name:"woven_notes_list",arguments:{}});assert.equal(result.structuredContent.items[0].id,"synthetic-note");
  revoked=true;const denied=await request("tools/call",{name:"woven_notes_list",arguments:{}});assert.equal(denied.isError,true);assert.ok(denied.content[0].text.includes("revoked"));
  const unknown=await request("tools/call",{name:"host_exec",arguments:{command:"ignored"}});assert.equal(unknown.isError,true);assert.equal(calls,2);
  process.stdout.write(JSON.stringify({stdioInitialize:true,typedCatalog:true,brokerSuccess:true,currentRunRevocation:true,unknownToolRejected:true,externalNetwork:false})+"\n");
} finally {child.stdin.end();await new Promise(resolve=>child.once("close",resolve));await new Promise(resolve=>server.close(resolve));}
