/** SettingsMCPAccessSection / external read-only access, desktop75f6903a.
 * Explicit expiring user/project grants on the existing HTTPS listener only.
 * Bearer authority never authenticates browser cookies or expands CORS.
 */
import {randomBytes,randomUUID,createHash} from "node:crypto";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {ListToolsRequestSchema,CallToolRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import type {FastifyInstance,FastifyRequest} from "fastify";
import {AppError,objectBody,type AppContext} from "../context.js";
import {workspaceTools,workspaceToolCall} from "../../../../packages/runtime/src/workspace-tools.js";
import {contentToolGroup,readToolConversation} from "../conversations/conversation-tools.js";
import type {ConversationService} from "../conversations/service.js";
import {WorkspaceContent,contentView} from "./service.js";
import {workspaceLibrary,workspaceUsage} from "./library.js";
import {databaseOperation} from "./databases.js";
const scopes=["notes","history","calendar","library","usage","databases"];
const hash=(token:string)=>createHash("sha256").update(token).digest("hex");
const denied=()=>new AppError(403,"mcp_access_denied","This read-only workspace grant is unavailable.");
type Grant={id:string;user_id:string;project_id:string;scopes:string;expires_at:string;revoked:number};
export async function registerExternalWorkspaceMCP(app:FastifyInstance,ctx:AppContext,conversations:ConversationService,content:WorkspaceContent){
 await ctx.db.migrate("external-workspace-mcp-v1","CREATE TABLE workspace_mcp_grants(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),token_hash TEXT NOT NULL UNIQUE,label TEXT NOT NULL,scopes TEXT NOT NULL,expires_at TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,last_used_at TEXT);CREATE INDEX workspace_mcp_grants_owner ON workspace_mcp_grants(user_id,project_id);");
 const base="/enterprise/api/projects/:projectId/mcp-access",endpoint=(id:string)=>ctx.config.publicOrigin+"/enterprise/api/mcp/"+encodeURIComponent(id);
 app.get(base,async request=>{
  const user=await ctx.requireUser(request),{projectId}=request.params as {projectId:string};await ctx.requireProject(user,projectId);
  return {endpoint:endpoint(projectId),items:await ctx.db.all("SELECT id,label,scopes,expires_at AS expiresAt,revoked,created_at AS createdAt,last_used_at AS lastUsedAt FROM workspace_mcp_grants WHERE user_id=? AND project_id=? ORDER BY created_at DESC",[user.id,projectId])};
 });
 app.post(base,async request=>{
  const user=await ctx.requireUser(request),{projectId}=request.params as {projectId:string},input=objectBody(request.body);const project=await ctx.requireProject(user,projectId);
  if(typeof input.label!=="string"||!input.label.trim()||input.label.length>120||!Number.isInteger(input.hours)||Number(input.hours)<1||Number(input.hours)>168||!Array.isArray(input.scopes)||!input.scopes.length||input.scopes.some(scope=>!scopes.includes(String(scope))))throw new AppError(400,"invalid_grant","Choose a label, read scopes and an expiry from 1 to168 hours.");
  const existing=await ctx.db.get<{count:number}>("SELECT COUNT(*) count FROM workspace_mcp_grants WHERE user_id=? AND project_id=? AND revoked=0 AND expires_at>?",[user.id,projectId,new Date().toISOString()]);if((existing?.count??0)>=10)throw new AppError(409,"grant_limit","Revoke an existing grant before creating another.");
  const id=randomUUID(),token="wme_mcp_"+randomBytes(32).toString("base64url"),expiresAt=new Date(Date.now()+Number(input.hours)*3600000).toISOString();
  await ctx.db.run("INSERT INTO workspace_mcp_grants(id,user_id,project_id,token_hash,label,scopes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",[id,user.id,projectId,hash(token),input.label.trim(),JSON.stringify([...new Set(input.scopes)]),expiresAt,new Date().toISOString()]);
  await ctx.audit(user,project.orgId,"workspace_mcp.grant.created",id,{});
  return {id,token,endpoint:endpoint(projectId),expiresAt,scopes:input.scopes};
 });
 app.delete(base+"/:id",async request=>{
  const user=await ctx.requireUser(request),{projectId,id}=request.params as {projectId:string;id:string};const project=await ctx.requireProject(user,projectId);
  const changed=await ctx.db.run("UPDATE workspace_mcp_grants SET revoked=1 WHERE id=? AND user_id=? AND project_id=?",[id,user.id,projectId]);if(!changed.changes)throw new AppError(404,"not_found","Grant not found.");
  await ctx.audit(user,project.orgId,"workspace_mcp.grant.revoked",id,{});return {revoked:true};
 });
 async function authorize(request:FastifyRequest){
  const {projectId}=request.params as {projectId:string},token=/^Bearer (wme_mcp_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization??"")?.[1];if(!token)throw new AppError(401,"mcp_token_required","An explicit read-only workspace grant is required.");
  const grant=await ctx.db.get<Grant>("SELECT * FROM workspace_mcp_grants WHERE token_hash=? AND project_id=? AND revoked=0 AND expires_at>?",[hash(token),projectId,new Date().toISOString()]);if(!grant)throw denied();
  const user=await conversations.user(grant.user_id);await ctx.requireProject(user,projectId);return {grant,user,projectId,allowed:JSON.parse(grant.scopes)as string[]};
 }
 const family=(name:string)=>name.startsWith("woven_notes_")?"notes":name.startsWith("woven_history_")?"history":name.startsWith("woven_calendar_")?"calendar":name==="woven_library_list"?"library":name==="woven_usage_read"?"usage":undefined;
 const reads=workspaceTools.filter(tool=>tool.readOnly&&family(tool.name));
 let active=0;const rates=new Map<string,{at:number;count:number}>();
 const path="/enterprise/api/mcp/:projectId";
 app.post(path,{bodyLimit:256*1024,config:{externalWorkspaceMCP:true}},async(request,reply)=>{
  const initial=await authorize(request),now=Date.now(),rate=rates.get(initial.grant.id);
  if(active>=4||rate&&now-rate.at<60000&&rate.count>=120)throw new AppError(429,"mcp_busy","Read-only MCP access is busy. Try later.");
  rates.set(initial.grant.id,rate&&now-rate.at<60000?{at:rate.at,count:rate.count+1}:{at:now,count:1});if(rates.size>10000)for(const[id,value]of rates)if(now-value.at>60000)rates.delete(id);
  const server=new Server({name:"WovenMatter read-only workspace",version:"1.0.0"},{capabilities:{tools:{}}});
  const tools=()=>[...reads.filter(tool=>initial.allowed.includes(family(tool.name)!)).map(tool=>({name:tool.name,description:tool.description,inputSchema:tool.inputSchema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true}})),...(initial.allowed.includes("databases")?[{name:"woven_databases_read",description:"Read managed database inventory or read-only query results. No create, execute or copy.",inputSchema:{type:"object" as const,additionalProperties:false,properties:{action:{type:"string",enum:["list","query","data"]},id:{type:"string"},sql:{type:"string"},sqliteQuery:{type:"string"}},required:["action"]},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true}}]:[])];
  server.setRequestHandler(ListToolsRequestSchema,async()=>{await authorize(request);return {tools:tools()};});
  server.setRequestHandler(CallToolRequestSchema,async call=>{
   try{
    const current=await authorize(request),{user,projectId,allowed}=current;
    if(!tools().some(tool=>tool.name===call.params.name))throw denied();
    const args=objectBody(call.params.arguments??{});let result:unknown;
    if(call.params.name==="woven_databases_read"){
     if(!allowed.includes("databases")||!["list","query","data"].includes(String(args.action))||Object.keys(args).some(key=>!["action","id","sql","sqliteQuery"].includes(key)))throw denied();
     result=await databaseOperation(ctx,user,projectId,args);
    }else{
     const {definition,input}=workspaceToolCall(call.params.name,args),operation=definition.operation,id=typeof input.id==="string"?input.id:"";
     if(!allowed.includes(family(call.params.name)!))throw denied();
     if(input.kind==="conversation"){
      result=operation==="list"?{items:(await conversations.list(user,projectId)).items.map(item=>({id:item.id,title:item.title,updatedAt:item.updatedAt}))}:await readToolConversation(ctx,user,projectId,id,input);
     }else if(operation==="list"){
      const group=contentToolGroup(input.kind);if(!allowed.includes(group))throw denied();
      result={items:(await content.list(user,projectId,String(input.kind))).items.map(item=>({id:item.id,kind:item.kind,title:item.title,revision:item.revision,updatedAt:item.updatedAt}))};
     }else if(operation==="read"||operation==="versions"){
      const row=await content.require(user,projectId,id);if(!allowed.includes(contentToolGroup(row.kind)))throw denied();
      result=operation==="read"?contentView(row):await content.versions(user,projectId,id);
     }else if(operation==="library")result=await workspaceLibrary(ctx,user,projectId);
     else if(operation==="usage")result=await workspaceUsage(ctx,user,projectId);
     else throw denied();
    }
    await authorize(request);const encoded=JSON.stringify(result);if(Buffer.byteLength(encoded)>2*1024*1024)throw new AppError(413,"mcp_result_limit","Choose a smaller read or query.");
    await ctx.db.run("UPDATE workspace_mcp_grants SET last_used_at=? WHERE id=?",[new Date().toISOString(),current.grant.id]);
    return {content:[{type:"text"as const,text:encoded}],structuredContent:result as Record<string,unknown>};
   }catch{return {isError:true,content:[{type:"text"as const,text:"Read denied or unavailable. Check current grant scopes, expiry and workspace access."}]};}
  });
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  active++;reply.header("cache-control","no-store");reply.hijack();
  reply.raw.once("close",()=>{void server.close().catch(()=>{});});
  try{await server.connect(transport);await transport.handleRequest(request.raw,reply.raw,request.body);}
  finally{active--;}
 });
 for(const method of ["GET","DELETE","OPTIONS"]as const)app.route({method,url:path,config:{externalWorkspaceMCP:true},handler:async(request,reply)=>{await authorize(request);return reply.code(405).send({error:"Stateless read-only MCP uses POST."});}});
}
