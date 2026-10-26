import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AppError, type AppContext } from "../context.js";
import type { ConversationService } from "../conversations/service.js";
export async function registerConversationHTML(app:FastifyInstance,ctx:AppContext,conversations:ConversationService) {
  await ctx.db.migrate("conversation-html-v1","CREATE TABLE conversation_html(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),run_id TEXT NOT NULL REFERENCES conversation_runs(id),request_id TEXT NOT NULL,title TEXT NOT NULL,html TEXT NOT NULL,height INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(run_id,request_id));");
  app.get("/enterprise/api/conversations/:conversationId/html/:id",{config:{safeReport:true}},async(request,reply)=>{
    const user=await ctx.requireUser(request),{conversationId,id}=request.params as {conversationId:string;id:string};
    await conversations.get(user,conversationId);
    const page=await ctx.db.get<{html:string}>("SELECT html FROM conversation_html WHERE id=? AND conversation_id=?",[id,conversationId]);
    if(!page)throw new AppError(404,"not_found","Visual reply not found.");
    reply.header("content-security-policy","default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
      .header("cache-control","private, no-store").header("referrer-policy","no-referrer").header("permissions-policy","camera=(),microphone=(),geolocation=()").type("text/html; charset=utf-8");
    return htmlDocument(page.html);
  });
}
export async function saveConversationHTML(ctx:AppContext,conversationId:string,runId:string,input:Record<string,unknown>) {
  const {html,title,height=400}=input;
  if(typeof html!=="string" || !html.trim() || Buffer.byteLength(html)>2*1024*1024 || typeof title!=="string" || !title.trim() || title.length>200 || !Number.isInteger(height) || Number(height)<80 || Number(height)>2000)
    throw new AppError(400,"invalid_html","Provide HTML up to 2 MiB, a title up to 200 characters, and height 80–2000.");
  if (/(?:\d|\.)\s*(?:s|l|d)?vh\b/i.test(html))throw new AppError(400,"invalid_html","Use content or fixed pixel heights so the visual reply fits the conversation.");
  const requestId=typeof input.requestID==="string"&&/^[a-zA-Z0-9-]{1,128}$/.test(input.requestID)?input.requestID:randomUUID();
  const existing=await ctx.db.get<{id:string;html:string;title:string;height:number}>("SELECT id,html,title,height FROM conversation_html WHERE run_id=? AND request_id=?",[runId,requestId]);
  if(existing){if(existing.html!==html||existing.title!==title||existing.height!==height)throw new AppError(409,"request_conflict","Request identity was already used.");return {id:existing.id,title,height};}
  const id=randomUUID(),at=new Date().toISOString(),metadata=JSON.stringify({pageId:id,height});
  await ctx.db.batch([
    {sql:"INSERT INTO conversation_html(id,conversation_id,run_id,request_id,title,html,height,created_at) VALUES(?,?,?,?,?,?,?,?)",params:[id,conversationId,runId,requestId,title,html,Number(height),at]},
    {sql:"UPDATE conversation_activity_clock SET revision=revision+1 WHERE id=1",params:[]},
    {sql:"INSERT INTO conversation_activity(conversation_id,run_id,activity_key,kind,title,status,preview,metadata,revision,created_at,updated_at) VALUES(?,?,?,'html',?,'completed','',?,(SELECT revision FROM conversation_activity_clock WHERE id=1),?,?)",params:[conversationId,runId,"html:"+id,title,metadata,at,at]},
    {sql:"INSERT INTO conversation_events(conversation_id,run_id,type,data,created_at) VALUES(?,?,'activity.changed','{}',?)",params:[conversationId,runId,at]},
  ]);
  return {id,title,height};
}
export function htmlDocument(html:string) {
  const bootstrap="<meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>html,body{margin:0;padding:0;font-family:system-ui;color:var(--foreground,#0a1f16);background:var(--background,transparent)}*{box-sizing:border-box}img,svg,canvas{max-width:100%}</style><script>(()=>{let queued=false;const measure=()=>{queued=false;parent.postMessage({kind:'woven-size',height:Math.max(document.body?.scrollHeight||80,document.body?.getBoundingClientRect().height||80)},'*')};const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(measure)}};addEventListener('DOMContentLoaded',()=>{new ResizeObserver(schedule).observe(document.body);schedule()});addEventListener('message',e=>{if(e.source!==parent||e.data?.kind!=='woven-theme')return;for(const[k,v]of Object.entries(e.data.variables||{}))if(/^--[a-z0-9-]+$/.test(k)&&typeof v==='string'&&v.length<200)document.documentElement.style.setProperty(k,v);schedule()});document.addEventListener('click',e=>{const a=e.composedPath().find(x=>x?.matches?.('a[href]'));if(!a||!e.isTrusted)return;e.preventDefault();try{const url=new URL(a.href);if(/^https?:$/.test(url.protocol))parent.postMessage({kind:'woven-link',url:url.href},'*')}catch{}},true);addEventListener('load',()=>{schedule();parent.postMessage({kind:'woven-ready'},'*')})})();</script>";
  // Prefix application bootstrap/CSP response before any authored executable content.
  return "<!doctype html>"+bootstrap+html;
}
