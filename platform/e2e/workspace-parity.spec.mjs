import { test,expect } from "@playwright/test";
import {join} from "node:path";
// Browser plugin not available. Real local API and synthetic pre-established owner session.
// No user login, upstream provider, or live preview credentials are used.
test.use({timezoneId:"America/New_York"});
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
async function shot(page,info,name){await page.screenshot({path:join(info.outputDir,name+".png"),fullPage:true});}

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
  if(await opener.isVisible()){const a=await back.boundingBox(),b=await opener.boundingBox();expect(a.y>=b.y+b.height||b.y>=a.y+a.height||a.x>=b.x+b.width||b.x>=a.x+a.width).toBe(true);await opener.click();await page.getByRole("button",{name:"Hide navigation sidebar",exact:true}).click();await expect(back).toBeVisible();}
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
