#!/usr/bin/env node
/** Stdio MCP facade. Connection material comes from the trusted per-run session broker. */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { workspaceTools, workspaceToolCall } from "./workspace-tools.js";
export async function callWorkspaceTool(name:string,args:unknown,signal?:AbortSignal) {
  const {definition,input} = workspaceToolCall(name,args);
  const grant = JSON.parse(await readFile("/session/.wme-workspace.json","utf8"));
  if (grant.baseUrl!=="http://127.0.0.1:4101/inference" || typeof grant.token!=="string") throw new Error("Workspace tools are unavailable.");
  const response = await fetch(grant.baseUrl+"/workspace/"+definition.operation,{method:"POST",headers:{authorization:"Bearer "+grant.token,"content-type":"application/json"},body:JSON.stringify(input),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  const result = await response.json() as Record<string,unknown> & {error?:{message?:string}};
  if (!response.ok) throw new Error(result.error?.message ?? "Workspace operation failed. Read current state before retrying.");
  return {content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result};
}
export async function mcpRequest(message: {method?:string;params?:Record<string,unknown>},call=callWorkspaceTool) {
  if (message.method==="initialize") return {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"wovenmatter-workspace",version:"1"}};
  if (message.method==="ping") return {};
  if (message.method==="tools/list") return {tools:workspaceTools.map(({name,description,inputSchema,readOnly})=>({name,description,inputSchema,annotations:{readOnlyHint:readOnly,idempotentHint:readOnly}}))};
  if (message.method==="tools/call") {
    try { return await call(String(message.params?.name),message.params?.arguments ?? {}); }
    catch(error) { return {isError:true,content:[{type:"text",text:error instanceof Error && !["TypeError","TimeoutError","AbortError"].includes(error.name)?error.message:"Operation outcome is uncertain. Read current state before retrying."}]}; }
  }
  throw new Error("Unsupported MCP method.");
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const lines = createInterface({input:process.stdin,crlfDelay:Infinity});
  for await (const line of lines) {
    let message: {id?:unknown;method?:string;params?:Record<string,unknown>};
    try { if (Buffer.byteLength(line)>2*1024*1024) throw new Error("Request too large."); message=JSON.parse(line); }
    catch { process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Invalid request."}})+"\n"); continue; }
    if (message.id===undefined) continue;
    try { process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result:await mcpRequest(message)})+"\n"); }
    catch { process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"Unsupported method."}})+"\n"); }
  }
}
