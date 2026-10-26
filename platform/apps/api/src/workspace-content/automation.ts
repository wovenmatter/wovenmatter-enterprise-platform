/** WovenMatter 07e7bdaa: WorkspaceAgentTools, Goals, session coordination and timers.
 * Cloud adaptation: every relationship and delivery stays inside one current project.
 * Durable intents use existing conversation admission receipts; uncertainty never replays.
 */
import {createHash,randomUUID} from "node:crypto";
import type {FastifyInstance} from "fastify";
import {AppError,objectBody,type AppContext,type User} from "../context.js";
import type {ConversationService} from "../conversations/service.js";
import {withConversationTools,readConversationTools} from "../conversations/conversation-tools.js";
import {personalPreferences} from "../preferences.js";
type Chat={id:string;project_id:string;creator_id:string;title:string;harness:string;model:string;native_options:string;tool_settings:string;deleted_at:string|null};
type Goal={id:string;objective:string;status:"active"|"paused"|"complete"|"blocked"|"budget_limited";tokenBudget?:number;turnBudget?:number;completedTurns:number;tokensUsed?:number;progressRevision:number;pendingProgressRevision:number;evidence?:string;createdAt:string;updatedAt:string;baseline:number;pendingDeliveryID?:string;runs:Record<string,{settled:boolean;tokens?:number;success?:boolean}>};
const fail=(message:string,code="invalid_automation",status=400)=>new AppError(status,code,message);
const text=(value:unknown,label:string,max=4096)=>{if(typeof value!=="string"||!value.trim()||value.length>max)throw fail(label+" must contain 1–"+max+" characters.");return value.trim();};
const uuid=(value:unknown)=>{if(typeof value!=="string"||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))throw fail("Provide an operation UUID.");return value.toLowerCase();};
const json=(value:unknown)=>JSON.stringify(value);
const timestamp=()=>new Date().toISOString();
export class WorkspaceAutomation {
  private timer?:ReturnType<typeof setInterval>;private running?:Promise<void>;
  constructor(readonly ctx:AppContext,readonly conversations:ConversationService){}
  async initialize(){
    await this.ctx.db.migrate("workspace-automation-v1",[
      "CREATE TABLE workspace_coordination_requests(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES conversations(id),target_id TEXT NOT NULL REFERENCES conversations(id),project_id TEXT NOT NULL REFERENCES projects(id),requested_by TEXT NOT NULL REFERENCES users(id),purpose TEXT NOT NULL,state TEXT NOT NULL,epoch TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);",
      "CREATE TABLE workspace_session_links(target_id TEXT PRIMARY KEY REFERENCES conversations(id),source_id TEXT NOT NULL REFERENCES conversations(id),project_id TEXT NOT NULL REFERENCES projects(id),requested_by TEXT NOT NULL REFERENCES users(id),epoch TEXT NOT NULL,purpose TEXT NOT NULL,notifications INTEGER NOT NULL DEFAULT 1,last_notified_run TEXT);",
      "CREATE TABLE workspace_automation_receipts(source_id TEXT NOT NULL REFERENCES conversations(id),request_id TEXT NOT NULL,kind TEXT NOT NULL,input_hash TEXT NOT NULL,status TEXT NOT NULL,result TEXT,target_id TEXT,created_at TEXT NOT NULL,PRIMARY KEY(source_id,request_id));",
      "CREATE TABLE workspace_agent_deliveries(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES conversations(id),target_id TEXT NOT NULL REFERENCES conversations(id),created_by TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT,created_at TEXT NOT NULL);",
      "CREATE TABLE workspace_goals(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),user_id TEXT NOT NULL REFERENCES users(id),data TEXT NOT NULL);",
      "CREATE TABLE workspace_session_timers(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),user_id TEXT NOT NULL REFERENCES users(id),instruction TEXT NOT NULL,next_at TEXT,interval_seconds INTEGER,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,last_delivery_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);",
    ].join("\n"));
  }
  start(){this.timer=setInterval(()=>void this.tick().catch(()=>{}),3000);this.timer.unref();}
  async close(){if(this.timer)clearInterval(this.timer);await this.running;}
  async chat(user:User,id:string,projectId?:string):Promise<Chat>{
    const row=await this.ctx.db.get<Chat>("SELECT * FROM conversations WHERE id=? AND deleted_at IS NULL AND project_id IS NOT NULL AND asset_id IS NULL",[id]);
    if(!row||projectId&&row.project_id!==projectId)throw fail("Workspace chat not found.","not_found",404);
    await this.ctx.requireProject(user,row.project_id);return row;
  }
  async once(source:string,requestID:unknown,kind:string,input:unknown,action:(id:string)=>Promise<unknown>){
    const id=uuid(requestID),hash=createHash("sha256").update(json(input)).digest("hex"),old=await this.ctx.db.get<any>("SELECT * FROM workspace_automation_receipts WHERE source_id=? AND request_id=?",[source,id]);
    if(old){if(old.kind!==kind||old.input_hash!==hash)throw fail("Operation identity was already used.","request_conflict",409);if(old.status!=="complete")return {requestID:id,targetId:old.target_id,status:"uncertain",message:"This operation may have been accepted. Inspect current state; it was not replayed."};return {...JSON.parse(old.result),replayed:true};}
    await this.ctx.db.run("INSERT INTO workspace_automation_receipts(source_id,request_id,kind,input_hash,status,created_at) VALUES(?,?,?,?,'pending',?)",[source,id,kind,hash,timestamp()]);
    try{const result=await action(id);await this.ctx.db.run("UPDATE workspace_automation_receipts SET status='complete',result=? WHERE source_id=? AND request_id=?",[json(result),source,id]);return result;}
    catch(error){await this.ctx.db.run("UPDATE workspace_automation_receipts SET status='uncertain' WHERE source_id=? AND request_id=?",[source,id]);throw error;}
  }
  async delivery(user:User,source:string,target:string,instruction:string,kind:string,id:string=randomUUID(),comment=false){
    await this.chat(user,source);await this.chat(user,target,(await this.chat(user,source)).project_id);
    const old=await this.ctx.db.get<any>("SELECT * FROM workspace_agent_deliveries WHERE id=?",[id]);
    if(old)return old;
    await this.ctx.db.run("INSERT INTO workspace_agent_deliveries(id,source_id,target_id,created_by,kind,content,status,created_at) VALUES(?,?,?,?,?,?,'admitting',?)",[id,source,target,user.id,kind,instruction,timestamp()]);
    try{
      const receipt=await this.conversations.admit(user,target,{requestId:id,content:instruction,kind:comment?"comment":"message"});
      const status=receipt.message.delivery,runId=receipt.run?.id??null;
      await this.ctx.db.run("UPDATE workspace_agent_deliveries SET status=?,run_id=? WHERE id=?",[status,runId,id]);
      return {id,targetId:target,status,runId};
    }catch(error){await this.ctx.db.run("UPDATE workspace_agent_deliveries SET status='uncertain' WHERE id=?",[id]);throw error;}
  }
  async sessions(user:User,sourceId:string,input:Record<string,unknown>){
    const source=await this.chat(user,sourceId),action=String(input.action);
    if(action==="list")return this.conversations.list(user,source.project_id);
    if(action==="folders")return {items:await this.ctx.db.all("SELECT id,name,root_path AS rootPath FROM project_folders WHERE project_id=? AND deleted_at IS NULL ORDER BY position",[source.project_id])};
    if(action==="harnesses")return {items:["pi","codex","claude_code","grok_build","opencode"]};
    if(action==="receipts")return {items:await this.ctx.db.all("SELECT id,target_id AS targetId,kind,status,run_id AS runId,created_at AS createdAt FROM workspace_agent_deliveries WHERE source_id=? ORDER BY created_at DESC LIMIT 100",[sourceId])};
    if(action==="create"){
      const purpose=text(input.purpose,"Purpose",2000),title=text(input.title,"Title",200),instruction=text(input.text,"Task",100000);
      const limit=(await personalPreferences(this.ctx,user.id)).maximumManagedSessions;
      return this.once(sourceId,input.requestID,"session.create",input,async requestId=>{
        const count=await this.ctx.db.get<{count:number}>("SELECT COUNT(*) count FROM workspace_session_links WHERE source_id=?",[sourceId]);
        if((count?.count??0)>=limit)throw fail("This coordinator reached its managed-session limit. Release a session first.","managed_session_limit",409);
        const selected=String(input.harness??source.harness),defaults=await this.conversations.agentSettings(user,source.project_id),configured=defaults.agents[selected as keyof typeof defaults.agents]??{};
        const target=await this.conversations.create(user,source.project_id,{title,harness:selected,...(input.model?{model:input.model}:{}),...(input.thinking?(selected==="pi"?{pi:{...Object.fromEntries(Object.entries(configured).filter(([key])=>["codeMode","subagentConcurrency"].includes(key))),thinking:input.thinking}}:{native:{...(configured.permission?{permission:configured.permission}:{}),thinking:input.thinking}}):{}),folderId:input.folder??null});
        await this.ctx.db.run("UPDATE workspace_automation_receipts SET target_id=? WHERE source_id=? AND request_id=?",[target.id,sourceId,requestId]);
        const epoch=randomUUID();
        await this.ctx.db.run("INSERT INTO workspace_session_links(target_id,source_id,project_id,requested_by,epoch,purpose) VALUES(?,?,?,?,?,?)",[target.id,sourceId,source.project_id,user.id,epoch,purpose]);
        const receipt=await this.delivery(user,sourceId,target.id,"Coordinator task ("+source.title+"): "+instruction,"session",requestId);
        return {sessionId:target.id,epoch,purpose,delivery:receipt};
      });
    }
    const target=await this.chat(user,text(input.id,"Chat ID",256),source.project_id);
    if(action==="status"){
      const [chat,link,native]=await Promise.all([this.conversations.get(user,target.id),this.ctx.db.get<any>("SELECT source_id AS coordinatorId,epoch,purpose,notifications FROM workspace_session_links WHERE target_id=?",[target.id]),this.conversations.nativeStatus(user,target.id)]);
      return {chat,coordination:link??null,native};
    }
    if(action==="manage"){
      const purpose=text(input.purpose,"Purpose",2000),id=uuid(input.requestID);
      const existing=await this.ctx.db.get<any>("SELECT * FROM workspace_coordination_requests WHERE id=?",[id]);
      if(existing){if(existing.source_id!==sourceId||existing.target_id!==target.id||existing.purpose!==purpose)throw fail("Request identity was already used.","request_conflict",409);return {requestID:id,state:existing.state,epoch:existing.epoch};}
      if(target.id===sourceId)throw fail("A chat cannot coordinate itself.");
      await this.ctx.db.run("INSERT INTO workspace_coordination_requests(id,source_id,target_id,project_id,requested_by,purpose,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?)",[id,sourceId,target.id,source.project_id,user.id,purpose,timestamp(),timestamp()]);
      return {requestID:id,state:"pending",message:"A workspace member must approve coordination from Background execution. Pending consent is not approval."};
    }
    const link=await this.ctx.db.get<any>("SELECT * FROM workspace_session_links WHERE target_id=? AND source_id=?",[target.id,sourceId]);
    if(!link||typeof input.epoch!=="string"||link.epoch!==input.epoch)throw fail("This coordination epoch is unavailable. Ask for access or inspect current status.","coordination_changed",403);
    if(action==="release"){await this.ctx.db.run("DELETE FROM workspace_session_links WHERE target_id=? AND source_id=? AND epoch=?",[target.id,sourceId,input.epoch]);return {released:true};}
    if(action==="notifications"){if(typeof input.enabled!=="boolean")throw fail("Choose true or false.");await this.ctx.db.run("UPDATE workspace_session_links SET notifications=? WHERE target_id=? AND epoch=?",[Number(input.enabled),target.id,input.epoch]);return {enabled:input.enabled};}
    if(action==="send")return this.once(sourceId,input.requestID,"session.send",input,id=>this.delivery(user,sourceId,target.id,"Coordinator message ("+source.title+"): "+text(input.text,"Message",100000),"session",id));
    throw fail("Choose a supported session operation.");
  }
  async coordination(user:User,projectId:string){await this.ctx.requireProject(user,projectId);return {items:await this.ctx.db.all("SELECT q.id,q.source_id AS sourceId,q.target_id AS targetId,s.title AS sourceTitle,t.title AS targetTitle,q.purpose,q.state,q.created_at AS createdAt FROM workspace_coordination_requests q JOIN conversations s ON s.id=q.source_id JOIN conversations t ON t.id=q.target_id WHERE q.project_id=? AND q.state='pending' AND s.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY q.created_at",[projectId])};}
  async decideCoordination(user:User,projectId:string,id:string,approve:boolean){
    await this.ctx.requireProject(user,projectId,"write");
    const request=await this.ctx.db.get<any>("SELECT * FROM workspace_coordination_requests WHERE id=? AND project_id=?",[id,projectId]);
    if(!request)throw fail("Coordination request not found.","not_found",404);
    if(request.state!=="pending")return {state:request.state,epoch:request.epoch};
    const requester=await this.conversations.user(request.requested_by),source=await this.chat(requester,request.source_id,projectId);
    await this.chat(user,request.target_id,projectId);
    if(!readConversationTools(source.tool_settings).sessions)throw fail("Session tools were disabled.","tool_disabled",403);
    if(approve){const count=await this.ctx.db.get<{count:number}>("SELECT COUNT(*) count FROM workspace_session_links WHERE source_id=? AND target_id!=?",[request.source_id,request.target_id]);if((count?.count??0)>=(await personalPreferences(this.ctx,requester.id)).maximumManagedSessions)throw fail("This coordinator reached its managed-session limit.","managed_session_limit",409);}
    const epoch=approve?randomUUID():null;
    await this.ctx.db.batch([
      {sql:"UPDATE workspace_coordination_requests SET state=?,epoch=?,updated_at=? WHERE id=? AND state='pending'",params:[approve?"approved":"rejected",epoch,timestamp(),id],expectChanges:1},
      ...(approve?[{sql:"INSERT INTO workspace_session_links(target_id,source_id,project_id,requested_by,epoch,purpose) VALUES(?,?,?,?,?,?) ON CONFLICT(target_id) DO UPDATE SET source_id=excluded.source_id,requested_by=excluded.requested_by,epoch=excluded.epoch,purpose=excluded.purpose,notifications=1,last_notified_run=NULL",params:[request.target_id,request.source_id,projectId,request.requested_by,epoch,request.purpose]}]:[]),
    ]);
    await this.ctx.audit(user,(await this.ctx.requireProject(user,projectId)).orgId,"session.coordination."+ (approve?"approved":"rejected"),id,{});
    return {state:approve?"approved":"rejected",epoch};
  }
  async goal(user:User,id:string,input:Record<string,unknown>={action:"get"},currentRunId?:string){
    await this.chat(user,id);
    const row=await this.ctx.db.get<{data:string}>("SELECT data FROM workspace_goals WHERE conversation_id=?",[id]),previous=row?.data,goal:Goal|undefined=previous?JSON.parse(previous):undefined,action=String(input.action);
    if(action==="get")return {goal:goal??null};
    let next=goal;
    if(action==="set"){
      const objective=text(input.objective,"Objective",4096);
      for(const [key,max] of [["tokenBudget",1_000_000_000],["turnBudget",10000]] as const)if(input[key]!==undefined&&(!Number.isSafeInteger(input[key])||Number(input[key])<1||Number(input[key])>max))throw fail("Choose a valid positive "+key+".");
      const latest=await this.ctx.db.get<{sequence:number}>("SELECT COALESCE(MAX(rowid),0) sequence FROM conversation_runs WHERE conversation_id=?",[id]);
      next={id:randomUUID(),objective,status:"active",completedTurns:0,tokensUsed:0,progressRevision:0,pendingProgressRevision:-1,baseline:latest?.sequence??0,createdAt:timestamp(),updatedAt:timestamp(),runs:{},...(input.tokenBudget?{tokenBudget:Number(input.tokenBudget)}:{}),...(input.turnBudget?{turnBudget:Number(input.turnBudget)}:{})};
      if(currentRunId)next.runs[currentRunId]={settled:false};
    }else{
      if(!goal||input.id!==goal.id)throw fail("This goal changed. Refresh before updating it.","goal_changed",409);
      if(action==="clear"){await this.ctx.db.run("DELETE FROM workspace_goals WHERE conversation_id=? AND data=?",[id,previous!]);return {goal:null};}
      if(action==="pause"){if(goal.status==="complete")throw fail("Set a new goal after completion.");goal.status="paused";}
      else if(action==="resume"){if(goal.status==="complete")throw fail("Set a new goal after completion.");if(goal.tokenBudget!==undefined&&goal.tokensUsed===undefined)throw fail("Token usage is unavailable. Set a goal without a token budget to resume.");if(this.goalBudget(goal))throw fail("The goal budget was reached. Set an increased budget before resuming.");goal.status="active";goal.pendingProgressRevision=goal.progressRevision-1;delete goal.evidence;delete goal.pendingDeliveryID;}
      else if(["complete","block","checkpoint"].includes(action)){if(goal.status!=="active")throw fail("Only active goals can report progress.");const evidence=text(input.evidence,"Evidence",4096);if(action==="checkpoint"){if(goal.evidence!==evidence)goal.progressRevision++;}else goal.status=action==="complete"?"complete":"blocked";goal.evidence=evidence;}
      else throw fail("Choose a supported goal operation.");
      goal.updatedAt=timestamp();
    }
    const result=await this.ctx.db.run("INSERT INTO workspace_goals(conversation_id,user_id,data) VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET user_id=excluded.user_id,data=excluded.data WHERE workspace_goals.data=?",[id,user.id,json(next),previous??null]);
    if(!result.changes)throw fail("The goal changed. Refresh before saving.","goal_changed",409);
    return {goal:next};
  }
  private goalBudget(goal:Goal){return goal.turnBudget!==undefined&&goal.completedTurns>=goal.turnBudget||goal.tokenBudget!==undefined&&(goal.tokensUsed??0)>=goal.tokenBudget;}
  async timers(user:User,id:string,input:Record<string,unknown>){
    await this.chat(user,id);const action=String(input.action);
    if(action==="list")return {items:await this.ctx.db.all("SELECT t.id,t.instruction,t.next_at AS nextAt,t.interval_seconds AS every,t.status,t.revision,t.last_delivery_id AS lastDeliveryId,d.status AS lastDeliveryStatus FROM workspace_session_timers t LEFT JOIN workspace_agent_deliveries d ON d.id=t.last_delivery_id WHERE t.conversation_id=? ORDER BY t.created_at DESC LIMIT 200",[id])};
    if(action==="create")return this.once(id,input.requestID,"timer.create",input,async requestId=>{
      const instruction=text(input.text,"Timer instruction",100000),at=typeof input.at==="string"&&Number.isFinite(Date.parse(input.at))?new Date(input.at).toISOString():null;
      if(!at)throw fail("Choose a valid next fire time.");
      if(input.every!==undefined&&(!Number.isSafeInteger(input.every)||Number(input.every)<1||Number(input.every)>31536000))throw fail("Choose a repeat interval from 1 second to one year.");
      const now=timestamp();
      await this.ctx.db.run("INSERT INTO workspace_session_timers(id,conversation_id,user_id,instruction,next_at,interval_seconds,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",[requestId,id,user.id,instruction,at,input.every===undefined?null:Number(input.every),input.paused===true?"paused":"active",now,now]);
      return {id:requestId,status:input.paused===true?"paused":"active",nextAt:at};
    });
    const timer=await this.ctx.db.get<any>("SELECT * FROM workspace_session_timers WHERE id=? AND conversation_id=?",[text(input.id,"Timer ID",256),id]);
    if(!timer)throw fail("Timer not found.","not_found",404);
    if(input.revision!==undefined&&input.revision!==timer.revision)throw fail("Timer changed. Refresh before editing.","revision_conflict",409);
    if(action==="update"){
      const instruction=text(input.text,"Timer instruction",100000),at=typeof input.at==="string"&&Number.isFinite(Date.parse(input.at))?new Date(input.at).toISOString():null;
      if(!at)throw fail("Choose a valid next fire time.");
      if(input.every!==undefined&&(!Number.isSafeInteger(input.every)||Number(input.every)<1||Number(input.every)>31536000))throw fail("Choose a repeat interval from 1 second to one year.");
      const changed=await this.ctx.db.run("UPDATE workspace_session_timers SET instruction=?,next_at=?,interval_seconds=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",[instruction,at,input.every===undefined?timer.interval_seconds:Number(input.every),input.paused===true?"paused":"active",timestamp(),timer.id,timer.revision]);
      if(!changed.changes)throw fail("Timer changed. Refresh before editing.","revision_conflict",409);return {id:timer.id,updated:true};
    }
    if(action==="remove"){await this.ctx.db.run("DELETE FROM workspace_session_timers WHERE id=? AND revision=?",[timer.id,timer.revision]);return {removed:true};}
    if(action==="pause"||action==="resume"){await this.ctx.db.run("UPDATE workspace_session_timers SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",[action==="pause"?"paused":"active",timestamp(),timer.id,timer.revision]);return {id:timer.id,status:action==="pause"?"paused":"active"};}
    throw fail("Choose a supported timer operation.");
  }
  tick(now=new Date()){if(this.running)return this.running;this.running=this.run(now).finally(()=>{this.running=undefined;});return this.running;}
  private async run(now:Date){
    const pending=await this.ctx.db.all<any>("SELECT * FROM workspace_agent_deliveries WHERE status IN ('admitting','pending','accepted','queued','dispatching','running','cancelling')");
    for(const item of pending){const receipt=await this.ctx.db.get<any>("SELECT i.delivery,i.run_id,r.status FROM conversation_inputs i LEFT JOIN conversation_runs r ON r.id=i.run_id WHERE i.conversation_id=? AND i.request_id=?",[item.target_id,item.id]);await this.ctx.db.run("UPDATE workspace_agent_deliveries SET status=?,run_id=? WHERE id=?",[!receipt?"uncertain":receipt.delivery==="accepted"?receipt.status??"accepted":receipt.delivery,receipt?.run_id??item.run_id,item.id]);}
    const timers=await this.ctx.db.all<any>("SELECT * FROM workspace_session_timers WHERE status='active' AND next_at<=? ORDER BY next_at LIMIT 32",[now.toISOString()]);
    for(const timer of timers)await withConversationTools(this.ctx,timer.conversation_id,async()=>{
      try{
        const user=await this.conversations.user(timer.user_id),chat=await this.chat(user,timer.conversation_id);
        if(!readConversationTools(chat.tool_settings).timers)throw fail("Timer tools are disabled.");
        if(timer.last_delivery_id){const old=await this.ctx.db.get<any>("SELECT status FROM workspace_agent_deliveries WHERE id=?",[timer.last_delivery_id]);if(!old||["uncertain","rejected","failed","interrupted"].includes(old.status))throw fail("Previous timer delivery is uncertain or failed.");if(["admitting","pending","accepted","queued","dispatching","running","cancelling"].includes(old.status))return;}
        if(await this.ctx.db.get("SELECT 1 FROM conversation_runs WHERE conversation_id=? AND status IN ('queued','dispatching','running','cancelling')",[chat.id]))return;
        const deliveryId=randomUUID(),next=timer.interval_seconds?new Date(Date.parse(timer.next_at)+(Math.floor((now.getTime()-Date.parse(timer.next_at))/(timer.interval_seconds*1000))+1)*timer.interval_seconds*1000).toISOString():null;
        const claimed=await this.ctx.db.run("UPDATE workspace_session_timers SET next_at=?,status=?,last_delivery_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='active'",[next,next?"active":"complete",deliveryId,timestamp(),timer.id,timer.revision]);if(!claimed.changes)return;
        await this.delivery(user,chat.id,chat.id,"Scheduled timer: "+timer.instruction,"timer",deliveryId);
      }catch{await this.ctx.db.run("UPDATE workspace_session_timers SET status='paused',revision=revision+1,updated_at=? WHERE id=?",[timestamp(),timer.id]);}
    });
    const links=await this.ctx.db.all<any>("SELECT l.*,r.id run_id,r.status run_status,m.content result FROM workspace_session_links l JOIN conversation_runs r ON r.id=(SELECT rr.id FROM conversation_runs rr WHERE rr.conversation_id=l.target_id ORDER BY rr.created_at DESC LIMIT 1) LEFT JOIN conversation_messages m ON m.id=r.assistant_message_id WHERE l.notifications=1 AND r.status IN ('completed','failed','cancelled','interrupted') AND (l.last_notified_run IS NULL OR l.last_notified_run!=r.id)");
    for(const link of links)await withConversationTools(this.ctx,link.source_id,async()=>{
      try{
        const user=await this.conversations.user(link.requested_by),source=await this.chat(user,link.source_id,link.project_id);await this.chat(user,link.target_id,link.project_id);
        if(!readConversationTools(source.tool_settings).sessions)return;
        const id=randomUUID(),claimed=await this.ctx.db.run("UPDATE workspace_session_links SET last_notified_run=? WHERE target_id=? AND epoch=? AND (last_notified_run IS NULL OR last_notified_run!=?)",[link.run_id,link.target_id,link.epoch,link.run_id]);if(!claimed.changes)return;
        await this.delivery(user,source.id,source.id,"Managed session "+link.target_id+" "+link.run_status+": "+String(link.result??"Inspect its saved run for details.").slice(0,6000),"notification",id,true);
      }catch{/* Changed authority ends notification delivery; never replay an uncertain external effect. */}
    });
    const goals=await this.ctx.db.all<{conversation_id:string;user_id:string;data:string}>("SELECT * FROM workspace_goals WHERE json_extract(data,'$.status')='active'");
    for(const row of goals)await withConversationTools(this.ctx,row.conversation_id,async()=>{
      const goal:Goal=JSON.parse(row.data);let user:User,chat:Chat;
      const persist=()=>this.ctx.db.run("UPDATE workspace_goals SET data=? WHERE conversation_id=? AND data=?",[json(goal),row.conversation_id,row.data]);
      try{user=await this.conversations.user(row.user_id);chat=await this.chat(user,row.conversation_id);}
      catch{goal.status="paused";goal.evidence="Workspace authority or execution ownership changed.";await persist();return;}
      if(JSON.parse(chat.native_options??"{}").permission==="plan"){goal.status="paused";goal.evidence="Goal continuation is paused in Plan mode.";await persist();return;}
      const runs=await this.ctx.db.all<any>("SELECT rowid sequence,id,status FROM conversation_runs WHERE conversation_id=? AND rowid>=? ORDER BY rowid",[chat.id,goal.baseline]);
      for(const run of runs){if(run.sequence>goal.baseline)goal.runs[run.id]??={settled:false};const item=goal.runs[run.id];if(!item||item.settled||["queued","dispatching","running","cancelling"].includes(run.status))continue;item.settled=true;item.success=run.status==="completed";const usage=await this.ctx.db.get<{tokens:number|null}>("SELECT SUM(json_extract(data,'$.totalTokens')) tokens FROM conversation_events WHERE run_id=? AND type='native.usage'",[run.id]);if(usage?.tokens!==null&&usage?.tokens!==undefined)item.tokens=usage.tokens;if(!item.success){goal.status="blocked";goal.evidence="A goal turn was interrupted or failed. Inspect its native state before resuming.";}}
      const settled=Object.values(goal.runs).filter(run=>run.settled);goal.completedTurns=settled.filter(run=>run.success).length;goal.tokensUsed=settled.every(run=>run.tokens!==undefined)?settled.reduce((sum,run)=>sum+run.tokens!,0):undefined;
      if(this.goalBudget(goal)){goal.status="budget_limited";goal.evidence="The goal budget was reached.";}
      if(goal.tokenBudget!==undefined&&goal.tokensUsed===undefined){goal.status="blocked";goal.evidence="This runtime did not report usage; the token budget cannot be enforced.";}
      if(await this.ctx.db.get("SELECT 1 FROM conversation_inputs WHERE conversation_id=? AND delivery='uncertain'",[chat.id])){goal.status="blocked";goal.evidence="An input has uncertain native acceptance. Reconcile it before resuming.";}
      if(goal.status!=="active"){await persist();return;}
      if(runs.some(run=>["queued","dispatching","running","cancelling"].includes(run.status))){await persist();return;}
      if(goal.pendingDeliveryID){const receipt=await this.ctx.db.get<any>("SELECT status FROM workspace_agent_deliveries WHERE id=?",[goal.pendingDeliveryID]);if(!receipt||["uncertain","rejected","interrupted","failed","cancelled"].includes(receipt.status)){goal.status="blocked";goal.evidence="Goal continuation delivery is uncertain or failed.";await persist();return;}if(receipt.status!=="completed")return;if(goal.progressRevision<=goal.pendingProgressRevision){goal.status="blocked";goal.evidence="The turn ended without a new goal checkpoint. Inspect progress before resuming.";await persist();return;}}
      const deliveryId=randomUUID();goal.pendingDeliveryID=deliveryId;goal.pendingProgressRevision=goal.progressRevision;goal.updatedAt=timestamp();const saved=await persist();if(!saved.changes)return;
      try{await this.delivery(user,chat.id,chat.id,"Continue working on the persistent goal explicitly requested by the user: "+goal.objective+"\nReport a new evidence-based checkpoint with woven_goals_checkpoint. Mark complete only when achieved; block when user input is required. Current goal ID: "+goal.id+". Completed turns: "+goal.completedTurns+". Tokens used: "+(goal.tokensUsed??"unavailable")+". Never start a separate provider-native goal.","goal",deliveryId);}
      catch{goal.status="blocked";goal.evidence="Goal delivery could not be confirmed. It was not replayed.";await this.ctx.db.run("UPDATE workspace_goals SET data=? WHERE conversation_id=?",[json(goal),chat.id]);}
    });
  }
}
export async function registerWorkspaceAutomation(app:FastifyInstance,ctx:AppContext,conversations:ConversationService,jobs:boolean){
  const service=new WorkspaceAutomation(ctx,conversations);await service.initialize();
  app.get("/enterprise/api/projects/:projectId/coordination-requests",async request=>service.coordination(await ctx.requireUser(request),(request.params as {projectId:string}).projectId));
  app.post("/enterprise/api/projects/:projectId/coordination-requests/:id",async request=>{const {projectId,id}=request.params as {projectId:string;id:string},input=request.body as {approve?:unknown};if(typeof input?.approve!=="boolean")throw fail("Choose approve or reject.");return service.decideCoordination(await ctx.requireUser(request),projectId,id,input.approve);});
  app.post("/enterprise/api/conversations/:conversationId/browser",async request=>{
    const user=await ctx.requireUser(request),id=(request.params as {conversationId:string}).conversationId,chat=await service.chat(user,id);
    if(!readConversationTools(chat.tool_settings).browser)throw fail("Browser tools are disabled.","tool_disabled",403);
    if(!ctx.runtime?.browser)throw fail("Browser runtime is unavailable.","browser_unavailable",409);
    const input=objectBody(request.body);if(!input||typeof input!=="object"||Array.isArray(input))throw fail("Provide a browser action.");
    await ctx.requireProject(user,chat.project_id,"write");
    return ctx.runtime.browser(chat.project_id,id,input);
  });
  app.get("/enterprise/api/conversations/:conversationId/goal",async request=>service.goal(await ctx.requireUser(request),(request.params as {conversationId:string}).conversationId));
  app.post("/enterprise/api/conversations/:conversationId/goal",async request=>{const user=await ctx.requireUser(request),id=(request.params as {conversationId:string}).conversationId;await service.chat(user,id);return withConversationTools(ctx,id,()=>service.goal(user,id,objectBody(request.body)));});
  app.get("/enterprise/api/conversations/:conversationId/timers",async request=>service.timers(await ctx.requireUser(request),(request.params as {conversationId:string}).conversationId,{action:"list"}));
  app.post("/enterprise/api/conversations/:conversationId/timers",async request=>{const user=await ctx.requireUser(request),id=(request.params as {conversationId:string}).conversationId;await service.chat(user,id);return withConversationTools(ctx,id,()=>service.timers(user,id,objectBody(request.body)));});
  ctx.onConversationStopped=async id=>{
    await withConversationTools(ctx,id,async()=>{
      const row=await ctx.db.get<{data:string}>("SELECT data FROM workspace_goals WHERE conversation_id=?",[id]);
      if(row){const goal=JSON.parse(row.data);if(goal.status==="active"){goal.status="paused";goal.evidence="Work was stopped by a workspace member.";goal.updatedAt=timestamp();await ctx.db.run("UPDATE workspace_goals SET data=? WHERE conversation_id=?",[JSON.stringify(goal),id]);}}
      await ctx.db.run("UPDATE workspace_session_timers SET status='paused',revision=revision+1 WHERE conversation_id=? AND status='active'",[id]);
    });
  };
  if(jobs)service.start();app.addHook("onClose",()=>service.close());return service;
}
