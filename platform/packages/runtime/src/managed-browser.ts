/** Agent-only client for the managed Playwright browser. This is a supported
 * subset, not an arbitrary Chromium/CDP discovery API. Every operation crosses
 * the current-run Woven MCP broker. No cached endpoint or trusted-worker eval.
 */
import {callWorkspaceTool} from "./workspace-mcp.js";
type Input=Record<string,unknown>;
type Result={structuredContent?:{id?:string;tabs?:{id:string;url:string;title:string}[];value?:unknown;running?:boolean}};
export type ManagedTransport=(input:Input)=>Promise<Result>;
const transport:ManagedTransport=input=>callWorkspaceTool("woven_browser",input) as Promise<Result>;
export async function connectManagedBrowser(call:ManagedTransport=transport){
 await call({action:"tabs"});
 return new ManagedBrowserContext(call);
}
export class ManagedBrowserContext{
 constructor(private call:ManagedTransport){}
 async pages(){const result=await this.call({action:"tabs"});return (result.structuredContent?.tabs??[]).map(tab=>new ManagedPage(tab.id,this.call));}
 async newPage(url="about:blank"){const result=await this.call({action:"open",url,requestID:crypto.randomUUID()});if(!result.structuredContent?.id)throw new Error("The managed browser did not return a page.");return new ManagedPage(result.structuredContent.id,this.call);}
}
export class ManagedPage{
 constructor(readonly id:string,private call:ManagedTransport){}
 private action(action:string,input:Input={}){return this.call({...input,action,tabId:this.id,requestID:crypto.randomUUID()});}
 async goto(url:string){await this.action("navigate",{url});}
 async goBack(){await this.action("back");}
 async goForward(){await this.action("forward");}
 async reload(){await this.action("reload");}
 async close(){await this.action("close");}
 async bringToFront(){await this.action("focus");}
 async evaluate(code:string){return (await this.action("evaluate",{code})).structuredContent?.value;}
 async snapshot(){return this.action("snapshot");}
 async screenshot(){return this.action("screenshot");}
 locator(selector:string){return new ManagedLocator({selector},(action,input)=>this.action(action,input));}
 getByRole(role:string,options:{name?:string;exact?:boolean}={}){if(!/^[a-z]+$/.test(role))throw new Error("Choose a supported role.");return new ManagedLocator({role,...options},(action,input)=>this.action(action,input));}
 get keyboard(){return {press:async(key:string)=>{await this.action("press",{key});},insertText:async(text:string)=>{await this.action("paste",{text});}};}
}
export class ManagedLocator{
 constructor(private target:Input,private action:(action:string,input:Input)=>Promise<Result>){}
 private invoke(action:string,input:Input={}){return this.action(action,{...input,...this.target});}
 async click(){await this.invoke("click");}
 async fill(text:string){await this.invoke("fill",{text});}
 async press(key:string){await this.invoke("press",{key});}
 async pressSequentially(text:string){await this.invoke("type",{text});}
 async hover(){await this.invoke("hover");}
 async check(){await this.invoke("check",{checked:true});}
 async uncheck(){await this.invoke("check",{checked:false});}
 async selectOption(value:string){await this.invoke("select",{value});}
 async waitFor(options:{state?:"attached"|"detached"|"visible"|"hidden";timeout?:number}={}){await this.invoke("wait",options);}
 private async read(property:string){return (await this.invoke("read",{property})).structuredContent?.value;}
 async textContent(){return this.read("textContent") as Promise<string|null>;}
 async innerText(){return this.read("innerText") as Promise<string>;}
 async inputValue(){return this.read("inputValue") as Promise<string>;}
 async count(){return this.read("count") as Promise<number>;}
 async isVisible(){return this.read("isVisible") as Promise<boolean>;}
}
