import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {platformFixture} from "./fixtures/platform.js";
async function fixture(t:any){
 const f=await platformFixture(t,{startConversations:false});
 f.inference.models=async()=>[{id:"fixture-title-model",name:"Synthetic title model",provider:"openai",thinkingLevels:["off","high"]}];f.inference.validateSelection=async()=>{};
 await f.request("full","PATCH","/enterprise/api/me/preferences",{automaticTitles:true,modelTitles:true,titleModel:"fixture-title-model",titleThinking:"off"});
 const chat=await f.conversations.create(f.users.full!,f.projectA,{model:"fixture-title-model"});
 return {...f,chat};
}
async function until(check:()=>Promise<boolean>){for(let n=0;n<200;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error("Naming fixture did not settle");}
test("model naming is asynchronous, bounded, authorized and accounted without changing the chat's model",async t=>{
 const f=await fixture(t);let complete!:(value:any)=>void;let body:any;
 f.inference.proxy.request=async(_org,path,input)=>{assert.equal(path,"/v1/responses");body=input?.body;return new Promise(resolve=>{complete=resolve;});};
 const receipt=await f.conversations.admit(f.users.full!,f.chat.id,{requestId:randomUUID(),content:"Build a synthetic project"});
 assert.ok(receipt.message);await until(async()=>Boolean(complete));
 assert.equal((await f.conversations.get(f.users.full!,f.chat.id)).title,"Build a synthetic project");assert.equal(body.max_output_tokens,4096);assert.equal(body.reasoning.effort,"none");
 complete({output:[{content:[{type:"output_text",text:"Synthetic project plan"}]}],usage:{input_tokens:20,output_tokens:4,total_tokens:24}});
 await until(async()=>(await f.conversations.get(f.users.full!,f.chat.id)).title==="Synthetic project plan");
 const job=await f.db.get<any>("SELECT * FROM conversation_title_jobs WHERE conversation_id=?",[f.chat.id]);assert.equal(job.status,"completed");assert.equal(JSON.parse(job.usage).totalTokens,24);
 assert.equal((await f.conversations.get(f.users.full!,f.chat.id)).model,"fixture-title-model");
});
test("manual naming fences the in-flight result even when the user chooses the fallback text",async t=>{
 const f=await fixture(t);let complete!:(value:any)=>void;f.inference.proxy.request=async()=>new Promise(resolve=>{complete=resolve;});
 await f.conversations.admit(f.users.full!,f.chat.id,{requestId:randomUUID(),content:"Manual fallback"});await until(async()=>Boolean(complete));
 await f.conversations.organize(f.users.full!,f.chat.id,{title:"Manual fallback"});
 complete({output_text:"Do not overwrite"});await until(async()=>(await f.db.get<any>("SELECT usage FROM conversation_title_jobs WHERE conversation_id=?",[f.chat.id]))?.usage!==null);
 assert.equal((await f.conversations.get(f.users.full!,f.chat.id)).title,"Manual fallback");
});
test("uncertain naming is never retried and custom chats never schedule a naming request",async t=>{
 const f=await fixture(t);let calls=0;f.inference.proxy.request=async()=>{calls++;throw new Error("Synthetic uncertain outcome");};
 const input={requestId:randomUUID(),content:"Fallback after uncertainty"};await f.conversations.admit(f.users.full!,f.chat.id,input);
 await until(async()=>(await f.db.get<any>("SELECT status FROM conversation_title_jobs WHERE conversation_id=?",[f.chat.id]))?.status==="unavailable");
 await f.conversations.admit(f.users.full!,f.chat.id,input);await until(async()=>!(await f.db.get("SELECT 1 FROM conversation_runs WHERE conversation_id=? AND status IN ('queued','dispatching','running','cancelling')",[f.chat.id])));await f.conversations.admit(f.users.full!,f.chat.id,{requestId:randomUUID(),content:"Second message"});assert.equal(calls,1);
 const custom=await f.conversations.create(f.users.full!,f.projectA,{title:"Human title",model:"fixture-title-model"});await f.conversations.admit(f.users.full!,custom.id,{requestId:randomUUID(),content:"Keep title"});assert.equal(calls,1);
});
test("revoked membership prevents an in-flight generated title from publishing",async t=>{
 const f=await fixture(t);let complete!:(value:any)=>void;f.inference.proxy.request=async()=>new Promise(resolve=>{complete=resolve;});
 await f.conversations.admit(f.users.full!,f.chat.id,{requestId:randomUUID(),content:"Keep fallback"});await until(async()=>Boolean(complete));
 await f.db.run("DELETE FROM project_members WHERE project_id=? AND user_id=?",[f.projectA,f.users.full!.id]);complete({output_text:"Forbidden title"});
 await until(async()=>(await f.db.get<any>("SELECT status FROM conversation_title_jobs WHERE conversation_id=?",[f.chat.id]))?.status==="unavailable");
 assert.equal((await f.conversations.get(f.users.read!,f.chat.id)).title,"Keep fallback");
});

test("incomplete naming keeps the fallback and records an unavailable receipt",async t=>{
 const f=await fixture(t);f.inference.proxy.request=async()=>({status:"incomplete",output_text:"Partial title",incomplete_details:{reason:"max_output_tokens"}});
 await f.conversations.admit(f.users.full!,f.chat.id,{requestId:randomUUID(),content:"Original fallback"});
 await until(async()=>(await f.db.get<any>("SELECT status FROM conversation_title_jobs WHERE conversation_id=?",[f.chat.id]))?.status==="unavailable");
 assert.equal((await f.conversations.get(f.users.full!,f.chat.id)).title,"Original fallback");
});
