import test from "node:test";
import assert from "node:assert/strict";
import {connectManagedBrowser} from "../src/managed-browser.js";
import {connect} from "node:net";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {WorkspaceBrowser,createWorkspaceBrowserServer} from "../src/workspace-browser.js";
test("passive human discovery and input never launch Chromium",async()=>{
 let authorized=0;const browser=new WorkspaceBrowser({profile:"/tmp/unused-browser-fixture",authorize:async()=>{authorized++;}});
 assert.deepEqual((await browser.action({action:"tabs"},true) as any).structuredContent,{running:false,tabs:[]});
 for(const action of ["navigate","screenshot","click","open"])await assert.rejects(browser.action({action,url:"about:blank",tabId:"missing"},true),/not opened/);
 assert.equal(authorized,0);await browser.close();
});
test("managed client is a scoped subset and never evaluates agent Node code on the owner",async()=>{
 const calls:Record<string,unknown>[]=[],context=await connectManagedBrowser(async input=>{calls.push(input);if(input.action==="tabs")return {structuredContent:{tabs:[{id:"existing",url:"https://example.test",title:"Agent page"}]}};if(input.action==="open")return {structuredContent:{id:"second"}};return {structuredContent:{value:input.property==="inputValue"?"human value":"Agent"}};});
 assert.deepEqual(calls,[{action:"tabs"}]);
 const pages=await context.pages();assert.equal(pages[0]!.id,"existing");const page=await context.newPage("https://example.test/second");assert.equal(page.id,"second");
 await page.getByRole("button",{name:"Continue"}).click();await page.locator("input").fill("Agent text");assert.equal(await page.locator("input").inputValue(),"human value");await page.evaluate("document.title");
 assert.deepEqual(calls.map(input=>input.action),["tabs","tabs","open","click","fill","read","evaluate"]);
 assert.equal((calls.at(-1)! as Record<string,unknown>).code,"document.title");assert.equal(calls.some(input=>"script" in input||"endpoint" in input),false);
});
test("an already acquired managed page rechecks authority on every operation",async()=>{
 let allowed=true;const context=await connectManagedBrowser(async input=>{if(!allowed)throw new Error("revoked");return {structuredContent:{tabs:[],id:input.action==="open"?"owned":undefined}};});
 const page=await context.newPage();allowed=false;await assert.rejects(page.locator("button").click(),/revoked/);await assert.rejects(context.newPage(),/revoked/);
});


test("native Unix socket cannot forge the trusted human channel or bypass expiry for tabs/stop",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wme-browser-socket-")),path=join(root,"browser.sock");let checks=0;
 const owner=new WorkspaceBrowser({profile:join(root,"profile"),authorize:async()=>{checks++;throw new Error("Current run revoked");}}),server=createWorkspaceBrowserServer(owner);
 await new Promise<void>(resolve=>server.listen(path,resolve));
 try{
  for(const action of ["tabs","stop","open","navigate"]){
   const value=await new Promise<string>((resolve,reject)=>{const socket=connect(path);let result="";socket.on("connect",()=>socket.write(JSON.stringify({action,attachOnly:true,url:"about:blank"})+"\n"));socket.on("data",chunk=>result+=chunk);socket.on("end",()=>resolve(result));socket.on("error",reject);});
   assert.ok(JSON.parse(value).error);
  }
  assert.equal(checks,4);
  assert.deepEqual((await owner.action({action:"tabs"},true) as any).structuredContent,{running:false,tabs:[]});
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await owner.close();await rm(root,{recursive:true,force:true});}
});
