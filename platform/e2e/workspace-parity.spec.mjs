import { test,expect } from "@playwright/test";
import {join} from "node:path";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {mkdir,stat} from "node:fs/promises";
// Browser plugin not available. Real local API and synthetic pre-established owner session.
// No user login, upstream provider, or live preview credentials are used.
// These scenarios own a separate fixture process/database; they never seed or
// mutate the baseline browser server, so file order and focused runs are safe.
const primaryPort=Number(process.env.WME_E2E_PORT??4155),isolatedPort=primaryPort<65400?primaryPort+101:primaryPort-101;
const isolatedOrigin="http://localhost:"+isolatedPort,isolatedOutput=join(process.env.WME_E2E_OUTPUT??"/tmp/wme-e2e-evidence","parity-isolated");
let ownedFixture;
test.use({timezoneId:"America/New_York",baseURL:isolatedOrigin,storageState:join(isolatedOutput,"auth.json")});
test.beforeAll(async()=>{
  // Refuse to borrow an unrelated listener or its authentication state.
  const probe=createServer();await new Promise((resolve,reject)=>{probe.once("error",reject);probe.listen(isolatedPort,"127.0.0.1",resolve);});await new Promise(resolve=>probe.close(resolve));
  await mkdir(isolatedOutput,{recursive:true,mode:0o700});
  const launchedAt=Date.now();ownedFixture=spawn(process.execPath,["platform/e2e/server.mjs"],{cwd:process.cwd(),env:{...process.env,WME_E2E_FIXTURE:"1",WME_E2E_PORT:String(isolatedPort),WME_E2E_OUTPUT:isolatedOutput},stdio:"ignore"});
  for(let attempt=0;attempt<150;attempt++){
    if(ownedFixture.exitCode!==null)throw new Error("The isolated parity fixture could not start.");
    try{const response=await fetch(isolatedOrigin+"/enterprise/healthz");if(response.ok&&(await stat(join(isolatedOutput,"auth.json"))).mtimeMs>=launchedAt-1000)return;}catch{/* Wait only for our newly launched synthetic fixture. */}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error("The isolated parity fixture did not become ready.");
});
test.afterAll(async()=>{if(!ownedFixture||ownedFixture.exitCode!==null)return;const stopped=new Promise(resolve=>ownedFixture.once("close",resolve));ownedFixture.kill("SIGTERM");let timer;try{await Promise.race([stopped,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Fixture did not stop.")),10000);})]);}finally{clearTimeout(timer);if(ownedFixture.exitCode===null)ownedFixture.kill("SIGKILL");}});
async function fixture(page,baseURL) {
  const session=await(await page.request.get("/enterprise/api/session")).json(),headers={origin:new URL(baseURL).origin,"x-csrf-token":session.csrfToken};
  const org=(await(await page.request.post("/enterprise/api/organizations",{headers,data:{name:"Workspace parity browser"}})).json());
  const response=await page.request.post("/enterprise/api/organizations/"+org.id+"/projects",{headers,data:{name:"Cloud workspace parity"}});expect(response.status()).toBe(202);
  const project=await response.json(),path="/enterprise/organizations/"+org.id+"/workspaces/"+project.id;
  await expect.poll(async()=>(await(await page.request.get("/enterprise/api/projects/"+project.id)).json()).status).toBe("ready");
  const errors=[];page.on("pageerror",error=>errors.push(error.message));page.on("console",message=>{if(["error","warning"].includes(message.type()))errors.push(message.text());});
  return {org,project,headers,path,errors};
}
async function identity(page,path) {
  await expect(page).toHaveURL(new RegExp(path.replace(/[.*+?^$()|[\]\\]/g,"\\$&")));
  await expect(page).toHaveTitle(/WovenMatter/);await expect(page.locator("main")).not.toHaveText("");await expect(page.locator("vite-error-overlay")).toHaveCount(0);
}
async function assertChatAssetClearance(page){
 const controls=page.locator(".workspace-chat-tools button:visible"),texts=page.locator(".transcript>.message").first().locator(".message-meta strong,.message-meta time");
 for(const control of await controls.all()){
  const button=await control.boundingBox();expect(await control.evaluate(node=>{const box=node.getBoundingClientRect();return node.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2));})).toBe(true);
  for(const text of await texts.all()){const box=await text.boundingBox();expect(box.x>=button.x+button.width||box.x+box.width<=button.x||box.y>=button.y+button.height||box.y+box.height<=button.y).toBe(true);}
 }
}
async function shot(page,info,name){await page.screenshot({path:join(info.outputDir,name+".png"),fullPage:true,animations:"disabled"});}

test("settings destinations, persisted inheritance, General and cloud execution work on desktop and mobile",async({page,baseURL},info)=>{
  const f=await fixture(page,baseURL);await page.goto(f.path+"/settings");await identity(page,f.path+"/settings");
  for(const name of ["General","Background execution","Dictation","Pi Durable","Codex","Claude Code","Grok Build","OpenCode","Workspace","Usage"])await expect(page.locator("main").getByRole("link",{name:new RegExp("^"+name)})).toBeVisible();
  await shot(page,info,"settings-desktop");
  await page.locator("main").getByRole("link",{name:/^Pi Durable/}).click();await page.getByRole("tab",{name:"Chat settings",exact:true}).click();
  await page.getByLabel("Scope",{exact:true}).selectOption("shared");await page.getByRole("combobox",{name:"Code mode",exact:true}).selectOption("only");await page.getByLabel("Concurrent subagents",{exact:true}).fill("5");
  await page.getByRole("button",{name:"Save chat settings",exact:true}).click();await expect(page.getByRole("status")).toContainText("Chat settings saved");
  await page.getByLabel("Scope",{exact:true}).selectOption("workspace");await expect(page.getByLabel("Use shared chat settings")).toBeChecked();await expect(page.getByRole("combobox",{name:"Code mode",exact:true})).toHaveValue("only");
  await page.getByLabel("Use shared chat settings").click();await expect(page.getByLabel("Use shared chat settings")).not.toBeChecked();await expect(page.getByRole("combobox",{name:"Code mode",exact:true})).toBeEnabled();await page.getByRole("combobox",{name:"Code mode",exact:true}).selectOption("off");await page.getByRole("button",{name:"Save chat settings",exact:true}).click();await expect(page.getByRole("status")).toContainText("Chat settings saved");await page.reload();await page.getByRole("tab",{name:"Chat settings",exact:true}).click();await expect(page.getByRole("combobox",{name:"Code mode",exact:true})).toHaveValue("off");
  const stored=await(await page.request.get("/enterprise/api/projects/"+f.project.id+"/agent-settings")).json();expect(stored.agents.pi.codeMode).toBe("off");expect(stored.shared.agents.pi.codeMode).toBe("only");
  await shot(page,info,"pi-settings-desktop");
  for(const id of ["codex","claude_code","grok_build","opencode"]){await page.goto(f.path+"/settings/"+id);await page.getByRole("tab",{name:"Chat settings",exact:true}).click();await expect(page.getByLabel("Use shared chat settings")).toBeVisible();await expect(page.getByLabel("Permissions",{exact:true})).toBeVisible();await expect(page.getByRole("heading",{name:"Woven MCP",exact:true})).toBeVisible();await shot(page,info,id+"-settings");}
  await page.goto(f.path+"/settings/general");await page.getByLabel("Language",{exact:true}).fill("en-US");await page.getByRole("button",{name:"Save dictation language",exact:true}).click();await expect(page.getByRole("status")).toContainText("Preferences saved");await page.reload();await expect(page.getByLabel("Language",{exact:true})).toHaveValue("en-US");
  await page.goto(f.path+"/settings/background");await expect(page.getByRole("heading",{name:"Managed activity"})).toBeVisible();await expect(page.getByText("No managed activity in this workspace.",{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});await page.goto(f.path+"/settings");await expect(page.locator("main").getByRole("heading",{name:"Settings",exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await shot(page,info,"settings-mobile");
  await page.goto(f.path+"/settings/pi");await page.getByRole("tab",{name:"Chat settings",exact:true}).click();await expect(page.getByRole("combobox",{name:"Code mode",exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);const back=page.getByRole("link",{name:"Back to settings",exact:true}),opener=page.getByRole("button",{name:"Show navigation sidebar",exact:true});
  if(await opener.isVisible()){const a=await back.boundingBox(),b=await opener.boundingBox();expect(a.y>=b.y+b.height||b.y>=a.y+a.height||a.x>=b.x+b.width||b.x>=a.x+a.width).toBe(true);await opener.click();await page.getByRole("button",{name:"Hide navigation sidebar",exact:true}).click();await expect(page.locator(".app-shell.sidebar-shell")).toHaveAttribute("data-drawer-open","false");await expect(page.getByRole("dialog",{name:"Navigation",exact:true})).toHaveCount(0);await expect(back).toBeVisible();}
  await shot(page,info,"pi-settings-mobile");expect(f.errors).toEqual([]);
});

test("dictation inserts a reviewable draft, privately persists history and survives settings navigation",async({page,baseURL},info)=>{
  const f=await fixture(page,baseURL);
  await page.addInitScript(()=>{window.SpeechRecognition=class{start(){setTimeout(()=>{this.onresult?.({resultIndex:0,results:[Object.assign([{transcript:"Synthetic browser dictation"}],{isFinal:true})]});this.onend?.();},50);}stop(){this.onend?.();}abort(){}};});
  // Workspace fixture can have no configured inference; dictation remains independent.
  await page.goto(f.path);await page.getByRole("button",{name:"Start dictation",exact:true}).click();await expect(page.getByLabel("Message your agent")).toHaveValue("Synthetic browser dictation");await expect(page.getByRole("status").filter({hasText:"Dictation saved"})).toBeVisible();
  expect((await(await page.request.get("/enterprise/api/me/dictations?search=Synthetic")).json()).items.some(item=>item.text==="Synthetic browser dictation")).toBe(true);
  await page.goto(f.path+"/settings/dictation");await page.getByRole("button").filter({hasText:"Synthetic browser dictation"}).first().click();await expect(page.locator(".dictation-text")).toHaveText("Synthetic browser dictation");await shot(page,info,"dictation-history");
  await page.goto(f.path);await expect(page.getByLabel("Message your agent")).toHaveValue("Synthetic browser dictation");expect(f.errors).toEqual([]);
});

test("interactive HTML persists outside work disclosure and replays safely after reload",async({page,baseURL},info)=>{
  const f=await fixture(page,baseURL);
  const response=await page.request.post("/enterprise/api/projects/"+f.project.id+"/conversations",{headers:f.headers,data:{title:"HTML browser fixture",harness:"pi"}});expect(response.status()).toBe(201);const chat=await response.json();
  const sent=await page.request.post("/enterprise/api/conversations/"+chat.id+"/messages",{headers:f.headers,data:{requestId:crypto.randomUUID(),content:"[html-reply]"}});expect(sent.status()).toBe(202);
  await page.goto(f.path+"?conversation="+chat.id);
  const frame=page.frameLocator('iframe[title="Interactive synthetic reply"]');await expect(frame.getByRole("heading",{name:"Persistent visual reply"})).toBeVisible();await frame.getByRole("button",{name:"Try interaction"}).click();await expect(frame.getByRole("button",{name:"Interaction verified"})).toBeVisible();
  expect(await page.locator(".conversation-html").evaluate(element=>!element.closest("details"))).toBe(true);
  const authority=await page.locator('iframe[title="Interactive synthetic reply"]').evaluate(frame=>({sandbox:frame.getAttribute("sandbox"),allow:frame.getAttribute("allow")}));expect(authority.sandbox).toBe("allow-scripts");expect(authority.allow).toContain("microphone 'none'");
  await shot(page,info,"interactive-html");await page.reload();await expect(frame.getByRole("heading",{name:"Persistent visual reply"})).toBeVisible();await expect(frame.getByRole("button",{name:"Try interaction"})).toBeVisible();
  await frame.getByRole("link",{name:"Example reference"}).click();await expect(page.getByRole("dialog",{name:"Open external link?"})).toBeVisible();await page.getByRole("button",{name:"Close dialog",exact:true}).click();expect(f.errors).toEqual([]);
});

test("goals, timers, Executor grants and the shared browser controls expose actual cloud state",async({page,baseURL},info)=>{
 const f=await fixture(page,baseURL);
 const created=await page.request.post("/enterprise/api/projects/"+f.project.id+"/conversations",{headers:f.headers,data:{title:"Automation UI fixture",harness:"pi"}});
 expect(created.status()).toBe(201);const chat=await created.json();
 await page.goto(f.path+"?conversation="+chat.id);
 await page.getByRole("button",{name:"Conversation actions",exact:true}).click();await page.getByRole("menuitem",{name:"Conversation settings",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"Conversation settings",exact:true});
 await expect(dialog.getByRole("heading",{name:"Persistent goal",exact:true})).toBeVisible();
 await dialog.getByText("Set goal",{exact:true}).click();await dialog.getByLabel("Objective",{exact:true}).fill("Explicit synthetic continuation goal");await dialog.getByLabel("Turn budget",{exact:true}).fill("2");
 await dialog.getByRole("button",{name:"Start goal",exact:true}).click();await expect(dialog.getByText("Explicit synthetic continuation goal",{exact:true})).toBeVisible();
 await dialog.getByRole("button",{name:"Pause goal",exact:true}).click();await expect.poll(async()=>(await(await page.request.get("/enterprise/api/conversations/"+chat.id+"/goal")).json()).goal.status).toBe("paused");
 await dialog.getByText("Add timer",{exact:true}).click();await dialog.getByLabel("Timer instruction",{exact:true}).fill("Synthetic future follow-up");await dialog.getByLabel("Next fire time",{exact:true}).fill(new Date(Date.now()+3600000).toISOString().slice(0,16));await dialog.getByRole("button",{name:"Create timer",exact:true}).click();
 await expect(dialog.locator(".setting-row").filter({hasText:"Synthetic future follow-up"}).first()).toBeVisible();
 await dialog.getByRole("button",{name:"Pause",exact:true}).click();await expect.poll(async()=>(await(await page.request.get("/enterprise/api/conversations/"+chat.id+"/timers")).json()).items[0].status).toBe("paused");
 await expect(dialog.getByText("An organization administrator can configure Executor in General settings.",{exact:true})).toBeVisible();
 await dialog.evaluate(node=>{node.scrollTop=0;});await expect(dialog.getByRole("button",{name:"Close dialog",exact:true})).toBeVisible();await shot(page,info,"automation-desktop");
 await page.getByRole("button",{name:"Close dialog",exact:true}).click();await expect(page.getByRole("button",{name:"Manage goal",exact:true})).toBeVisible();
 const inputs=[];page.on("request",request=>{if(request.url().endsWith("/"+chat.id+"/browser")&&request.method()==="POST")inputs.push(request.postDataJSON());});
 await page.request.post("/enterprise/api/conversations/"+chat.id+"/messages",{headers:f.headers,data:{requestId:crypto.randomUUID(),content:"[agent-browser]"}});
 await expect.poll(async()=>(await(await page.request.get("/enterprise/api/conversations/"+chat.id+"/runs")).json()).items[0]?.status).toBe("completed");
 const agentRuns=(await(await page.request.get("/enterprise/api/conversations/"+chat.id+"/runs")).json()).items.length;
 await page.goto(f.path+"/browser?conversation="+chat.id);await expect(page.getByRole("region",{name:"Workspace assets",exact:true})).toBeVisible();await expect(page.getByRole("img",{name:"Current workspace browser page",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Read page",exact:true}).click();await expect(page.getByText("Synthetic isolated page: no external browser traffic",{exact:true})).toBeVisible();
 for(const name of ["Back","Forward","Reload"])await page.getByRole("button",{name,exact:true}).click();
 const viewer=page.getByRole("application",{name:"Interactive workspace browser",exact:true});
 await page.getByRole("img",{name:"Current workspace browser page",exact:true}).click({position:{x:60,y:60}});await viewer.press("Control+a");await viewer.press("Control+r");await expect.poll(()=>inputs.filter(input=>input.action==="reload").length).toBeGreaterThanOrEqual(2);await viewer.press("Tab");await expect(viewer).toBeFocused();await viewer.press("Escape");await expect(page.getByRole("textbox",{name:"Browser URL",exact:true})).toBeFocused();
 await page.getByRole("textbox",{name:"Text for focused page field",exact:true}).fill("Synthetic human text");await page.getByRole("button",{name:"Type text",exact:true}).click();await viewer.dispatchEvent("wheel",{deltaY:300,cancelable:true});
 await expect.poll(()=>["back","forward","reload","mouse-down","mouse-up","press","paste","scroll"].every(action=>inputs.some(input=>input.action===action))).toBe(true);
 expect((await(await page.request.get("/enterprise/api/conversations/"+chat.id+"/runs")).json()).items.length).toBe(agentRuns);
 await shot(page,info,"browser-synthetic-desktop");
 await page.setViewportSize({width:390,height:844});await shot(page,info,"browser-synthetic-mobile");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.goto(f.path+"/settings/general");await expect(page.getByRole("heading",{name:"Connected apps · Executor",exact:true})).toBeVisible();await page.getByRole("button",{name:"Configure service",exact:true}).click();await expect(page.getByRole("combobox",{name:"Approved service origin",exact:true})).toBeVisible();await expect(page.getByText("A platform operator must approve a service origin before it can be configured.",{exact:true})).toBeVisible();await shot(page,info,"general-executor-mobile");
 expect(f.errors).toEqual([]);
});

test("ordered model defaults, save conflicts and optional title controls retain confirmed state",async({page,baseURL},info)=>{
 const f=await fixture(page,baseURL);
 await page.goto(f.path+"/settings/pi");await page.getByRole("tab",{name:"Chat settings",exact:true}).click();await page.getByLabel("Use shared chat settings",{exact:true}).click();await expect(page.getByLabel("Use shared chat settings",{exact:true})).not.toBeChecked();
 await page.getByRole("checkbox",{name:"Fallback Synthetic test model",exact:true}).check();await page.getByRole("checkbox",{name:"Fallback Mandatory reasoning fixture",exact:true}).check();
 await page.getByRole("button",{name:"Move fallback mandatory-thinking-fixture up",exact:true}).click();await page.getByRole("button",{name:"Move model mandatory-thinking-fixture up",exact:true}).click();await page.getByRole("button",{name:"Save chat settings",exact:true}).click();
 await expect(page.getByRole("status")).toContainText("Chat settings saved");const settings=(await(await page.request.get("/enterprise/api/projects/"+f.project.id+"/agent-settings")).json()).agents.pi;
 expect(settings.fallbackModels).toEqual(["mandatory-thinking-fixture","gpt-test-fixture"]);expect(settings.models[0]).toBe("mandatory-thinking-fixture");
 await shot(page,info,"pi-model-order-desktop");
 await page.getByRole("combobox",{name:"Code mode",exact:true}).selectOption("only");
 await page.route("**/enterprise/api/projects/"+f.project.id+"/agent-settings",async route=>{if(route.request().method()==="PATCH")return route.fulfill({status:409,json:{error:{code:"settings_changed",message:"Settings changed. Refresh before saving."}}});return route.continue();});
 await page.getByRole("button",{name:"Save chat settings",exact:true}).click();await expect(page.getByRole("alert")).toContainText("Settings changed");await expect(page.getByRole("combobox",{name:"Code mode",exact:true})).toHaveValue("only");
 await page.unroute("**/enterprise/api/projects/"+f.project.id+"/agent-settings");await page.reload();await page.getByRole("tab",{name:"Chat settings",exact:true}).click();await expect(page.getByRole("combobox",{name:"Code mode",exact:true})).toHaveValue("on");
 await page.goto(f.path+"/settings/general");await expect(page.getByRole("heading",{name:"Read-only MCP access",exact:true})).toBeVisible();await page.getByRole("checkbox",{name:/Generate titles with an organization model/}).check();await page.getByRole("combobox",{name:"Title model",exact:true}).selectOption("gpt-test-fixture");await page.getByRole("combobox",{name:"Title thinking level",exact:true}).selectOption("low");await page.getByRole("button",{name:"Save title generation",exact:true}).click();
 await expect.poll(async()=>(await(await page.request.get("/enterprise/api/me/preferences")).json()).modelTitles).toBe(true);
 await page.reload();await expect(page.getByRole("combobox",{name:"Title model",exact:true})).toHaveValue("gpt-test-fixture");await expect(page.getByRole("combobox",{name:"Title thinking level",exact:true})).toHaveValue("low");
 await page.getByRole("region",{name:"Conversation titles",exact:true}).screenshot({path:join(info.outputDir,"title-model-controls.png"),animations:"disabled"});await shot(page,info,"general-desktop");
 await page.getByText("Create read-only grant",{exact:true}).click();await page.getByRole("textbox",{name:"Grant label",exact:true}).fill("Synthetic fixture grant");await page.getByRole("spinbutton",{name:"Expires after hours",exact:true}).fill("1");await page.getByRole("button",{name:"Issue read-only grant",exact:true}).click();await expect(page.getByRole("textbox",{name:"New read-only MCP token",exact:true})).toHaveValue(/^wme_mcp_/);
 await page.getByRole("region",{name:"Read-only MCP access",exact:true}).screenshot({path:join(info.outputDir,"mcp-grant-controls.png"),animations:"disabled"});
 await page.getByRole("button",{name:"Revoke Synthetic fixture grant",exact:true}).click();await expect(page.getByRole("textbox",{name:"New read-only MCP token",exact:true})).toHaveCount(0);await expect.poll(async()=>(await(await page.request.get("/enterprise/api/projects/"+f.project.id+"/mcp-access")).json()).items[0].revoked).toBe(1);
 await page.setViewportSize({width:390,height:844});await shot(page,info,"general-mobile");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(f.errors.filter(error=>!/Failed to load resource:.*409/.test(error))).toEqual([]);
});

test("agent browser tabs share the adjacent asset pane and preserve chat, note drafts and independent layout",async({page,baseURL},info)=>{
 const f=await fixture(page,baseURL);await page.setViewportSize({width:1600,height:1000});
 const chat=await(await page.request.post("/enterprise/api/projects/"+f.project.id+"/conversations",{headers:f.headers,data:{title:"Asset tabs fixture",harness:"pi"}})).json();
 const note=await(await page.request.post("/enterprise/api/projects/"+f.project.id+"/workspace-content",{headers:f.headers,data:{kind:"note",title:"Retained note",body:"Saved note",data:{format:"markdown"}}})).json();
 const inputs=[];page.on("request",request=>{if(request.url().endsWith("/"+chat.id+"/browser")&&request.method()==="POST")inputs.push(request.postDataJSON());});
 await page.goto(f.path+"?conversation="+chat.id);
 await expect(page.getByRole("navigation",{name:"Workspace navigation"}).getByRole("link",{name:"Browser",exact:true})).toHaveCount(0);
 await page.getByLabel("Message your agent",{exact:true}).fill("Unsent retained chat draft");
 const trigger=page.getByRole("button",{name:"Open agent browser",exact:true});expect(await trigger.evaluate(node=>{const box=node.getBoundingClientRect();return node.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2));})).toBe(true);await trigger.click();
 await expect(page.getByRole("heading",{name:"No shared agent browser",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"New tab",exact:true})).toHaveCount(0);
 expect(inputs.every(input=>input.action==="tabs")).toBe(true);
 expect((await(await page.request.get("/enterprise/api/conversations/"+chat.id+"/runs")).json()).items).toHaveLength(0);
 await shot(page,info,"agent-browser-idle");
 await page.getByRole("button",{name:"Hide assets",exact:true}).click();
 await expect(page.getByLabel("Message your agent",{exact:true})).toHaveValue("Unsent retained chat draft");
 await page.request.post("/enterprise/api/conversations/"+chat.id+"/messages",{headers:f.headers,data:{requestId:crypto.randomUUID(),content:"[agent-browser]"}});
 await expect.poll(async()=>(await(await page.request.get("/enterprise/api/conversations/"+chat.id+"/runs")).json()).items[0]?.status).toBe("completed");
 await page.getByRole("button",{name:"Open agent browser",exact:true}).click();
 await expect(page.getByRole("tab",{name:"Synthetic agent page",exact:true})).toBeVisible();await expect(page.getByRole("tab",{name:"Second agent page",exact:true})).toBeVisible();
 await expect(page.getByRole("img",{name:"Current workspace browser page",exact:true})).toBeVisible();
 const runs=(await(await page.request.get("/enterprise/api/conversations/"+chat.id+"/runs")).json()).items.length;
 await page.goto(f.path+"?conversation="+chat.id+"&note="+note.id);
 const editor=page.getByRole("textbox",{name:"Document body",exact:true});await editor.fill("Unsaved note survives tabs");const tabOrder=await page.getByRole("tablist",{name:"Open assets",exact:true}).getByRole("tab").allTextContents();
 await page.getByRole("tab",{name:"Synthetic agent page",exact:true}).click();await expect(page.getByLabel("Message your agent",{exact:true})).toHaveValue("Unsent retained chat draft");
 await page.getByRole("button",{name:"Move assets left",exact:true}).click();
 const assets=page.getByRole("region",{name:"Workspace assets",exact:true}),chatArea=page.locator(".conversation-main");
 let a=await assets.boundingBox(),c=await chatArea.boundingBox();expect(a.x).toBeLessThan(c.x);
 await page.getByRole("separator",{name:"Chat and assets width",exact:true}).press("ArrowLeft");
 await shot(page,info,"agent-browser-assets-left");
 await page.getByRole("button",{name:"Focus assets",exact:true}).click();await expect(chatArea).toBeHidden();await page.getByRole("button",{name:"Restore chat and assets",exact:true}).click();
 await page.getByRole("tab",{name:"Retained note",exact:true}).click();await expect(editor).toHaveValue("Unsaved note survives tabs");expect(await page.getByRole("tablist",{name:"Open assets",exact:true}).getByRole("tab").allTextContents()).toEqual(tabOrder);await shot(page,info,"note-asset-tab-desktop");
 await page.getByRole("tab",{name:"Synthetic agent page",exact:true}).click();await page.getByRole("button",{name:"Move assets right",exact:true}).click();
 a=await assets.boundingBox();c=await chatArea.boundingBox();expect(a.x).toBeGreaterThan(c.x);
 await assertChatAssetClearance(page);await shot(page,info,"agent-browser-assets-desktop");
 await page.getByRole("button",{name:"Close Synthetic agent page",exact:true}).click();expect(inputs.some(input=>input.action==="close"||input.action==="open")).toBe(false);
 await page.getByRole("button",{name:"Hide assets",exact:true}).click();await page.getByRole("button",{name:"Open agent browser",exact:true}).click();await expect(page.getByRole("tab",{name:"Synthetic agent page",exact:true})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole("button",{name:"Back to chat",exact:true})).toBeVisible();const back=await page.getByRole("button",{name:"Back to chat",exact:true}).boundingBox();for(const toggle of await page.locator("[data-sidebar-reveal]").all()){if(await toggle.isVisible()){const box=await toggle.boundingBox();expect(back.x>=box.x+box.width||box.x>=back.x+back.width||back.y>=box.y+box.height||box.y>=back.y+back.height).toBe(true);}}await shot(page,info,"agent-browser-assets-mobile");
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.getByRole("tab",{name:"Retained note",exact:true}).click();await expect(editor).toHaveValue("Unsaved note survives tabs");
 await page.getByRole("button",{name:"Back to chat",exact:true}).click();await expect(page.getByLabel("Message your agent",{exact:true})).toHaveValue("Unsent retained chat draft");await assertChatAssetClearance(page);await shot(page,info,"agent-browser-chat-mobile");
 expect((await(await page.request.get("/enterprise/api/conversations/"+chat.id+"/runs")).json()).items.length).toBe(runs);
 await page.request.patch("/enterprise/api/conversations/"+chat.id+"/tools",{headers:f.headers,data:{group:"browser",enabled:false}});
 await page.getByRole("button",{name:"Open agent browser",exact:true}).click();await expect(page.getByRole("alert")).toContainText("disabled");
 await expect(page.getByRole("img",{name:"Current workspace browser page",exact:true})).toHaveCount(0);
 expect(f.errors.filter(error=>!/Failed to load resource:.*403/.test(error))).toEqual([]);
});

test("browser capture and queued input cannot cross a tab switch or detach",async({page,baseURL})=>{
 const f=await fixture(page,baseURL);await page.setViewportSize({width:1600,height:1000});
 const chat=await(await page.request.post("/enterprise/api/projects/"+f.project.id+"/conversations",{headers:f.headers,data:{title:"Browser lifecycle fixture",harness:"pi"}})).json(),endpoint="/enterprise/api/conversations/"+chat.id+"/browser";
 await page.request.post("/enterprise/api/conversations/"+chat.id+"/messages",{headers:f.headers,data:{requestId:crypto.randomUUID(),content:"[agent-browser]"}});
 await expect.poll(async()=>(await(await page.request.get("/enterprise/api/conversations/"+chat.id+"/runs")).json()).items[0]?.status).toBe("completed");
 await page.goto(f.path+"?conversation="+chat.id);await page.getByRole("button",{name:"Open agent browser",exact:true}).click();
 const viewer=page.getByRole("application",{name:"Interactive workspace browser",exact:true});await expect(viewer).toBeVisible();
 const primary=await viewer.getAttribute("data-browser-tab");
 let releaseCapture,heldCapture=false,blockCapture=true,releaseInput,heldInput=false,blockInput=false;const sent=[];
 await page.route("**"+endpoint,async route=>{
  const input=route.request().postDataJSON();sent.push(input);
  if(blockCapture&&input.action==="screenshot"&&input.tabId===primary){blockCapture=false;const response=await route.fetch();heldCapture=true;await new Promise(resolve=>releaseCapture=resolve);return route.fulfill({response});}
  if(blockInput&&input.action==="press"){blockInput=false;const response=await route.fetch();heldInput=true;await new Promise(resolve=>releaseInput=resolve);return route.fulfill({response});}
  return route.continue();
 });
 await page.getByRole("button",{name:"Read page",exact:true}).click();await expect.poll(()=>heldCapture).toBe(true);
 await page.getByRole("tab",{name:"Second agent page",exact:true}).click();
 await page.evaluate(()=>{window.__frames=[];window.__frameObserver=new MutationObserver(()=>{for(const node of document.querySelectorAll("[data-browser-tab]"))window.__frames.push(node.getAttribute("data-browser-tab"));});window.__frameObserver.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:["data-browser-tab"]});});
 releaseCapture();
 await expect(viewer).toBeVisible();await expect(viewer).not.toHaveAttribute("data-browser-tab",primary);
 expect((await page.evaluate(()=>window.__frames)).includes(primary)).toBe(false);await page.evaluate(()=>window.__frameObserver.disconnect());
 blockInput=true;
 await viewer.focus();await viewer.press("a");await expect.poll(()=>heldInput).toBe(true);await viewer.press("b");
 await page.getByRole("button",{name:"Hide assets",exact:true}).click();releaseInput();
 await page.getByRole("button",{name:"Open agent browser",exact:true}).click();await expect(viewer).toBeVisible();await expect(page.getByRole("textbox",{name:"Browser URL",exact:true})).toHaveValue("https://agent-fixture.invalid/second");
 expect(sent.filter(input=>input.action==="press"&&input.key==="b")).toHaveLength(0);
 expect(f.errors).toEqual([]);
});

test("workspace transition never carries asset tabs or note requests into another owner",async({page,baseURL})=>{
 const f=await fixture(page,baseURL);
 const note=await(await page.request.post("/enterprise/api/projects/"+f.project.id+"/workspace-content",{headers:f.headers,data:{kind:"note",title:"Original private workspace note",body:"Retained original draft"}})).json();
 await page.goto(f.path+"?note="+note.id);await expect(page.getByRole("tab",{name:note.title,exact:true})).toBeVisible();
 const second=await(await page.request.post("/enterprise/api/organizations/"+f.org.id+"/projects",{headers:f.headers,data:{name:"Second isolated workspace"}})).json();
 await expect.poll(async()=>(await(await page.request.get("/enterprise/api/projects/"+second.id)).json()).status).toBe("ready");
 const requests=[];page.on("request",request=>requests.push(request.url()));
 const secondPath=f.path.replace(f.project.id,second.id);
 await page.evaluate(path=>{history.pushState({},"",path);dispatchEvent(new PopStateEvent("popstate"));},secondPath);
 await expect(page).toHaveURL(new RegExp(second.id));
 await expect(page.getByRole("tab",{name:note.title,exact:true})).toHaveCount(0);
 await expect(page.getByRole("region",{name:"Workspace assets",exact:true})).toBeHidden();
 await expect(page.getByLabel("Message your agent",{exact:true})).toBeVisible();
 expect(requests.filter(url=>url.includes("/workspace-content/"+note.id))).toHaveLength(0);
 const owner=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)??"null"),"wme:assets:v1:"+(await(await page.request.get("/enterprise/api/session")).json()).user.id+":"+second.id);
 expect(owner?.tabs??[]).toEqual([]);expect(f.errors).toEqual([]);
});

test("ordered browser views keep note position and a closed view frees the eighth slot",async({page,baseURL})=>{
 const f=await fixture(page,baseURL);await page.setViewportSize({width:1600,height:1000});
 const chat=await(await page.request.post("/enterprise/api/projects/"+f.project.id+"/conversations",{headers:f.headers,data:{title:"Ordered views fixture",harness:"pi"}})).json();
 await page.request.post("/enterprise/api/conversations/"+chat.id+"/messages",{headers:f.headers,data:{requestId:crypto.randomUUID(),content:"[agent-browser-many]"}});
 await expect.poll(async()=>(await(await page.request.get("/enterprise/api/conversations/"+chat.id+"/runs")).json()).items[0]?.status).toBe("completed");
 await page.goto(f.path+"?conversation="+chat.id);await page.getByRole("button",{name:"Open agent browser",exact:true}).click();
 const strip=page.getByRole("tablist",{name:"Open assets",exact:true});await expect(strip.getByRole("tab")).toHaveCount(8);await expect(strip.getByRole("tab",{name:"Agent page 9",exact:true})).toHaveCount(0);
 await page.getByRole("button",{name:"Close Agent page 1",exact:true}).click();await expect(strip.getByRole("tab",{name:"Agent page 9",exact:true})).toBeAttached();await expect(strip.getByRole("tab")).toHaveCount(8);
 const note=await(await page.request.post("/enterprise/api/projects/"+f.project.id+"/workspace-content",{headers:f.headers,data:{kind:"note",title:"Note opened after browser",body:"Retain order"}})).json();
 await page.evaluate(path=>{history.pushState({},"",path);dispatchEvent(new PopStateEvent("popstate"));},f.path+"?conversation="+chat.id+"&note="+note.id);
 await expect(strip.getByRole("tab",{name:note.title,exact:true})).toBeAttached();const expected=[...Array.from({length:8},(_,index)=>"Agent page "+(index+2)),note.title];expect(await strip.getByRole("tab").allTextContents()).toEqual(expected);
 await strip.getByRole("tab",{name:"Agent page 2",exact:true}).click();await expect(page.getByRole("application",{name:"Interactive workspace browser",exact:true})).toBeVisible();expect(await strip.getByRole("tab").allTextContents()).toEqual(expected);expect(f.errors).toEqual([]);
});
