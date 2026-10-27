/** WovenMatter 07e7bdaa ExecutorBroker / ApplicationModel+Executor.
 * Uses the upstream V2 managed-profile API unchanged. Manager material stays at
 * the coordinator; model calls can use only user-selected profiles in this chat.
 */
import {randomUUID,randomBytes} from "node:crypto";
import {mkdir,readFile,writeFile,rename} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import type {FastifyInstance} from "fastify";
import {AppError,objectBody,type AppContext,type User} from "../context.js";
import {readConversationTools,withConversationTools} from "../conversations/conversation-tools.js";
import type {WorkspaceAutomation} from "./automation.js";
type Profile={id:string;app:string;name:string;account?:string;profileName:string};
type Configuration={id:string;origin:string;apiKey:string;apps:Profile[];defaultProfiles:string[]};
type Broker=any;
const invalid=(message:string,status=400)=>new AppError(status,"executor_unavailable",message);
function allowedOrigins(ctx:AppContext){return Array.isArray(ctx.config.executorOrigins)?ctx.config.executorOrigins as string[]:[];}
export class WorkspaceExecutor {
  private brokers=new Map<string,Promise<{broker:Broker;config:Configuration}>>();
  private fences=new Map<string,number>();
  constructor(readonly ctx:AppContext,readonly automation:WorkspaceAutomation,readonly dependencies:{fetcher?:typeof fetch;connect?:any}={}){}
  private directory(orgId:string){return join(this.ctx.config.stateDir,"control","executor",orgId);}
  private async configuration(orgId:string):Promise<Configuration|undefined>{try{return JSON.parse(await readFile(join(this.directory(orgId),"configuration.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}}
  private async saveConfiguration(orgId:string,config:Configuration){const directory=this.directory(orgId);await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,"configuration.json"),temp=path+"."+randomUUID()+".tmp";await writeFile(temp,JSON.stringify(config),{mode:0o600,flag:"wx"});await rename(temp,path);}
  private async load(orgId:string){
    let pending=this.brokers.get(orgId);
    if(!pending){pending=(async()=>{
      const config=await this.configuration(orgId);if(!config)throw invalid("Ask an organization administrator to configure Executor.",409);
      if(!allowedOrigins(this.ctx).includes(config.origin))throw invalid("The Executor origin is no longer approved by the platform operator.",403);
      const module=await import(pathToFileURL(fileURLToPath(new URL("../../../../packages/runtime/src/embedded/default-agent/src/executor/broker.mjs",import.meta.url))).href);
      const fetcher:typeof fetch=async(input,init)=>{
        const target=new URL(String(input));if(target.origin!==config.origin)throw invalid("Executor attempted an unapproved destination.",403);
        const response=await (this.dependencies.fetcher??fetch)(target,{...init,redirect:"error"});
        if(response.redirected||response.status>=300&&response.status<400)throw invalid("Executor redirects are not permitted.",403);
        return response;
      };
      const broker=await new module.ExecutorBroker(this.directory(orgId),{fetcher,beforeDispatch:async(job:any)=>{const user=await this.automation.conversations.user(job.ownerId),chat=await this.automation.chat(user,job.session);if(!readConversationTools(chat.tool_settings).executor||(this.fences.get(job.session)??0)!==job.enterpriseFence)throw invalid("App grants or membership changed before dispatch.",403);},...(this.dependencies.connect?{connect:this.dependencies.connect}:{})}).load();
      broker.state.servers[config.id]={origin:config.origin,location:"remote",apiKey:config.apiKey,encryptionKey:broker.state.servers[config.id]?.encryptionKey??randomBytes(32).toString("hex"),port:new URL(config.origin).port?Number(new URL(config.origin).port):443};
      broker.config={id:config.id,location:"remote",origin:config.origin};broker.server=broker.state.servers[config.id];broker.origin=config.origin;await broker.save();
      return {broker,config};
    })();this.brokers.set(orgId,pending);pending.catch(()=>{if(this.brokers.get(orgId)===pending)this.brokers.delete(orgId);});}
    return pending;
  }
  async status(user:User,orgId:string,refresh=false){
    await this.ctx.requireOrgMember(user,orgId);const config=await this.configuration(orgId);
    if(!config)return {configured:false,allowedOrigins:allowedOrigins(this.ctx),apps:[],defaultProfiles:[]};
    if(refresh){const loaded=await this.load(orgId),broker=loaded.broker;await broker.request("/v1/apps");config.apps=await broker.inventory();config.defaultProfiles=config.defaultProfiles.filter(id=>config.apps.some(profile=>profile.id===id));Object.assign(loaded.config,config);await this.saveConfiguration(orgId,config);}
    return {configured:true,origin:config.origin,apps:config.apps,defaultProfiles:config.defaultProfiles,allowedOrigins:allowedOrigins(this.ctx)};
  }
  async configure(user:User,orgId:string,input:Record<string,unknown>){
    await this.ctx.requireOrgAdmin(user,orgId);
    const old=await this.configuration(orgId);
    const origin=typeof input.origin==="string"?input.origin:old?.origin;
    if(!origin||!allowedOrigins(this.ctx).includes(origin))throw invalid("Choose an Executor origin approved by the platform operator.",403);
    const parsed=new URL(origin);if(parsed.origin!==origin||parsed.username||parsed.password)throw invalid("Choose a plain approved service origin.");
    const apiKey=input.apiKey===undefined?old?.apiKey:input.apiKey;
    if(typeof apiKey!=="string"||!/^[a-f0-9]{64}$/i.test(apiKey))throw invalid("Provide the service's 64-character management key.");
    // Validate a replacement key before withdrawing the existing working configuration.
    try{
      const response=await (this.dependencies.fetcher??fetch)(origin+"/v1/apps",{headers:{authorization:"Bearer "+apiKey},signal:AbortSignal.timeout(30000),redirect:"error"});
      if(!response.ok||response.redirected)throw new Error("unavailable");
      await response.json();
    }catch{throw invalid("Executor service could not be verified. The previous configuration was retained.",502);}
    const previous=this.brokers.get(orgId);this.brokers.delete(orgId);if(previous){const {broker}=await previous;for(const job of broker.jobs.values())await broker.cancel(job);await broker.stop();}
    const config:Configuration={id:old?.origin===origin?old.id:randomUUID(),origin,apiKey,apps:old?.origin===origin?old.apps:[],defaultProfiles:old?.origin===origin?old.defaultProfiles:[]};
    await this.saveConfiguration(orgId,config);
    const status=await this.status(user,orgId,true);
    await this.ctx.audit(user,orgId,"executor.configuration.updated",orgId,{});
    return status;
  }
  async defaults(user:User,orgId:string,selected:unknown){
    await this.ctx.requireOrgAdmin(user,orgId);const config=await this.configuration(orgId);if(!config)throw invalid("Configure Executor first.",409);
    config.defaultProfiles=this.profiles(config,selected).map(profile=>profile.id);const pending=this.brokers.get(orgId);if(pending)Object.assign((await pending).config,config);await this.saveConfiguration(orgId,config);return this.status(user,orgId);
  }
  private profiles(config:Configuration,selected:unknown){if(!Array.isArray(selected)||selected.length>200||selected.some(id=>typeof id!=="string"||!config.apps.some(profile=>profile.id===id)))throw invalid("Choose current app profiles from this organization.");return config.apps.filter(profile=>selected.includes(profile.id));}
  async selected(user:User,chatId:string){const chat=await this.automation.chat(user,chatId),project=await this.ctx.requireProject(user,chat.project_id),config=await this.configuration(project.orgId),row=await this.ctx.db.get<{profiles:string}>("SELECT profiles FROM conversation_executor_profiles WHERE conversation_id=?",[chatId]);return {chat,orgId:project.orgId,config,ids:row?JSON.parse(row.profiles):config?.defaultProfiles??[]};}
  async view(user:User,chatId:string){
    const {config,ids,orgId}=await this.selected(user,chatId),pending=this.brokers.get(orgId);
    let jobs:any[]=[];
    if(pending){const {broker}=await pending;jobs=[...broker.jobs.values()].filter((job:any)=>job.session===chatId&&job.connection===config?.id).map((job:any)=>({...broker.publicJob(job),code:job.code??"",interaction:job.pending??null}));}
    return {configured:Boolean(config),apps:config?.apps??[],selectedProfiles:ids,enabled:readConversationTools((await this.automation.chat(user,chatId)).tool_settings).executor,jobs};
  }
  async setProfiles(user:User,chatId:string,selected:unknown){
    const {config,orgId,chat}=await this.selected(user,chatId);if(!config)throw invalid("Configure Executor first.",409);
    const profiles=this.profiles(config,selected),next=profiles.map(profile=>profile.id);
    await this.ctx.requireProject(user,chat.project_id,"write");
    this.fences.set(chatId,(this.fences.get(chatId)??0)+1);
    const pending=this.brokers.get(orgId);if(pending){const {broker}=await pending;await broker.cancelSession(chatId);await broker.scope(chatId,profiles,readConversationTools(chat.tool_settings).executor);}
    await this.ctx.db.run("INSERT INTO conversation_executor_profiles(conversation_id,profiles) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET profiles=excluded.profiles",[chatId,JSON.stringify(next)]);
    return this.view(user,chatId);
  }
  private policy(chat:any){
    if(chat.harness==="pi")return "full";
    const mode=JSON.parse(chat.native_options??"{}").permission;
    if((chat.harness==="codex"&&mode==="agent-full-access")||(["claude_code","grok_build"].includes(chat.harness)&&mode==="bypassPermissions")||(chat.harness==="opencode"&&["allow","full","auto"].includes(mode)))return "full";
    return ["dontAsk","plan","deny"].includes(mode)?"deny":"ask";
  }
  async tool(user:User,chatId:string,input:Record<string,unknown>){
    const selected=await this.selected(user,chatId);if(!selected.config)throw invalid("Executor is not configured for this organization.",409);
    const {broker,config}=await this.load(selected.orgId),profiles=this.profiles(config,selected.ids),action=String(input.action),fence=this.fences.get(chatId)??0;
    if(!readConversationTools(selected.chat.tool_settings).executor)throw invalid("Connected app tools are disabled.",403);
    if(action==="status")return broker.publicJob(broker.owned(String(input.id),chatId));
    if(action==="cancel"){await broker.cancel(broker.owned(String(input.id),chatId));return {cancelled:true};}
    if(!profiles.length)throw invalid("Choose app profiles in this chat's settings before using Executor.",403);
    if(!["search","skills","execute"].includes(action))throw invalid("Choose a supported Executor operation.");
    const code=action==="search"?"return await tools.search("+JSON.stringify({query:String(input.query??""),limit:Math.min(100,Math.max(1,Number(input.limit)||20))})+");":action==="skills"?"":typeof input.code==="string"?input.code:"";
    if(action==="execute"&&(!code.trim()||code.length>65536))throw invalid("Provide JavaScript up to 64 KiB.");
    if(action==="execute"&&this.policy(selected.chat)==="deny")throw invalid("This chat's confirmed permission mode does not permit external app programs.",403);
    const scope=await broker.scope(chatId,profiles,true);
    await this.automation.chat(user,chatId);if((this.fences.get(chatId)??0)!==fence)throw invalid("App profile grants changed before dispatch.",409);
    const result=await broker.start({id:input.requestID,session:chatId,code,action,scope}),job=broker.owned(result.id,chatId);job.ownerId=user.id;job.enterpriseFence=fence;
    if(job.status==="awaiting-approval"&&(action!=="execute"||this.policy(selected.chat)==="full"))await broker.advance(job,{action:"accept"});
    return broker.publicJob(job);
  }
  async respond(user:User,chatId:string,jobId:string,response:Record<string,unknown>){
    const {orgId,chat}=await this.selected(user,chatId);await this.ctx.requireProject(user,chat.project_id,"write");const {broker}=await this.load(orgId),job=broker.owned(jobId,chatId);
    if(!readConversationTools(chat.tool_settings).executor)throw invalid("Connected app tools are disabled.",403);
    if(response.action==="cancel")await broker.cancel(job);else await broker.advance(job,response);return this.view(user,chatId);
  }
  async revoke(chatId:string){
    this.fences.set(chatId,(this.fences.get(chatId)??0)+1);
    const chat=await this.ctx.db.get<{org_id:string}>("SELECT org_id FROM conversations WHERE id=?",[chatId]),pending=chat?this.brokers.get(chat.org_id):undefined;
    if(!pending)return;const {broker,config}=await pending;await broker.cancelSession(chatId);if(broker.state.scopes[config.id+":"+chatId])await broker.scope(chatId,[],false);
  }
  async audit(){
    for(const pending of this.brokers.values()){const {broker}=await pending;for(const job of broker.jobs.values()){
      if(["completed","cancelled","interrupted"].includes(job.status))continue;
      try{const user=await this.automation.conversations.user(job.ownerId),chat=await this.automation.chat(user,job.session);if(!readConversationTools(chat.tool_settings).executor)throw invalid("Disabled");if(job.status==="approval-required"&&this.policy(chat)==="full")await broker.advance(job,{action:"accept"});if(this.policy(chat)==="deny")await broker.cancel(job);}
      catch{await this.revoke(job.session).catch(()=>{});}
    }}
  }
  async close(){for(const pending of this.brokers.values())await (await pending).broker.stop();}
}
export async function registerWorkspaceExecutor(app:FastifyInstance,ctx:AppContext,automation:WorkspaceAutomation){
  await ctx.db.migrate("workspace-executor-v1","CREATE TABLE conversation_executor_profiles(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),profiles TEXT NOT NULL DEFAULT '[]');");
  const service=new WorkspaceExecutor(ctx,automation),orgBase="/enterprise/api/organizations/:orgId/executor",chatBase="/enterprise/api/conversations/:conversationId/executor";
  app.get(orgBase,async request=>service.status(await ctx.requireUser(request),(request.params as {orgId:string}).orgId));
  app.post(orgBase+"/refresh",async request=>{const user=await ctx.requireUser(request),orgId=(request.params as {orgId:string}).orgId;await ctx.requireOrgAdmin(user,orgId);return service.status(user,orgId,true);});
  app.put(orgBase,async request=>service.configure(await ctx.requireUser(request),(request.params as {orgId:string}).orgId,objectBody(request.body)));
  app.patch(orgBase+"/defaults",async request=>service.defaults(await ctx.requireUser(request),(request.params as {orgId:string}).orgId,objectBody(request.body).profiles));
  app.get(chatBase,async request=>service.view(await ctx.requireUser(request),(request.params as {conversationId:string}).conversationId));
  app.patch(chatBase+"/profiles",async request=>{const user=await ctx.requireUser(request),id=(request.params as {conversationId:string}).conversationId;return withConversationTools(ctx,id,()=>service.setProfiles(user,id,objectBody(request.body).profiles));});
  app.post(chatBase+"/jobs/:id/respond",async request=>{const user=await ctx.requireUser(request),{conversationId,id}=request.params as {conversationId:string;id:string};return withConversationTools(ctx,conversationId,()=>service.respond(user,conversationId,id,objectBody(request.body)));});
  const timer=setInterval(()=>void service.audit().catch(()=>{}),3000);timer.unref();
  ctx.onConversationToolsChanged=async(id,group,enabled)=>{if(group==="executor"&&!enabled)await service.revoke(id);};
  const priorStop=ctx.onConversationStopped;
  ctx.onConversationStopped=async id=>{await priorStop?.(id);await service.revoke(id);};
  app.addHook("onClose",async()=>{clearInterval(timer);await service.close();});return service;
}
