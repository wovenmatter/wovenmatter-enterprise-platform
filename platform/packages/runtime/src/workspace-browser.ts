/** Source: wovenmatter 07e7bdaa remote/workspace-browser + browser-runtime.
 * Runs only inside an already isolated retained conversation namespace.
 * CDP is never exposed; all network traffic goes through the existing scoped egress relay.
 */
import {createServer,connect} from "node:net";
import {mkdir} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import type {BrowserContext,Page} from "playwright-core";
import type {ContainerRequest} from "./types.js";
const socketPath="/tmp/wme-browser.sock",maxBytes=4*1024*1024;
type Input=Record<string,any>;
const text=(value:unknown)=>({content:[{type:"text",text:JSON.stringify(value)}],structuredContent:value});
const point=(input:Input)=>{if(!Number.isFinite(input.x)||!Number.isFinite(input.y)||input.x<0||input.y<0)throw new Error("Provide current viewport coordinates.");return [input.x,input.y] as const;};
export class WorkspaceBrowser {
  private dialogPolicies=new Map<string,{accept:boolean;text?:string}>();private context?:BrowserContext;private starting?:Promise<BrowserContext>;private pages=new Map<string,Page>();private frames=new Map<string,{page:Page;at:number}>();private downloads=new Map<string,{id:string;name:string;bytes:Buffer;tabId:string}>();private requests=new Map<string,{controller:AbortController;status:string;result?:unknown;hash:string}>();
  constructor(private config:{profile:string;proxy?:{server:string;username?:string;password?:string};executablePath?:string}){}
  private async start(){
    if(this.context)return this.context;
    if(!this.starting)this.starting=(async()=>{
      const {chromium}=await import("playwright-core");await mkdir(this.config.profile,{recursive:true,mode:0o700});
      const context=await chromium.launchPersistentContext(this.config.profile,{headless:true,viewport:{width:1280,height:800},timeout:20000,executablePath:this.config.executablePath,
        proxy:this.config.proxy??{server:"http://127.0.0.1:9"},acceptDownloads:true,
        // The existing nested AppArmor/UID/network boundary stays authoritative.
        // Single-process avoids zygote seqpacket IPC requiring new host policy grants.
        args:["--no-sandbox","--no-zygote","--single-process","--disable-gpu","--disable-dev-shm-usage","--disable-background-networking","--disable-component-update","--force-webrtc-ip-handling-policy=disable_non_proxied_udp","--proxy-bypass-list=<-loopback>"],
      });
      await context.route("**/*",route=>{try{const url=new URL(route.request().url());return ["http:","https:","about:","data:","blob:"].includes(url.protocol)?route.continue():route.abort("blockedbyclient");}catch{return route.abort("blockedbyclient");}});
      context.on("page",page=>this.identify(page));for(const page of context.pages())this.identify(page);
      context.on("close",()=>{this.context=undefined;this.pages.clear();this.frames.clear();this.downloads.clear();});
      this.context=context;return context;
    })().finally(()=>{this.starting=undefined;});
    return this.starting;
  }
  private identify(page:Page){for(const[id,current]of this.pages)if(current===page)return id;const id=randomUUID();this.pages.set(id,page);page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(20000);page.on("close",()=>{this.pages.delete(id);this.dialogPolicies.delete(id);for(const[key,frame]of this.frames)if(frame.page===page)this.frames.delete(key);});page.on("framenavigated",()=>{for(const[key,frame]of this.frames)if(frame.page===page)this.frames.delete(key);});page.on("dialog",dialog=>{const policy=this.dialogPolicies.get(id);this.dialogPolicies.delete(id);void (policy?.accept?dialog.accept(policy.text):dialog.dismiss()).catch(()=>{});});return id;}
  async close(){await this.context?.close();this.context=undefined;}
  async action(input:Input){
    if(!input||typeof input!=="object"||Array.isArray(input)||Buffer.byteLength(JSON.stringify(input))>maxBytes)throw new Error("Invalid browser request.");
    const action=String(input.action);
    if(action==="cancel"){for(const[id,item]of this.requests)if((input.id==="all"||input.id===id)&&item.status==="running"){item.controller.abort();item.status="interrupted";}return text({cancelled:true});}
    if(action==="tabs")return text({running:Boolean(this.context),tabs:await Promise.all([...this.pages].filter(([,page])=>!page.isClosed()).map(async([id,page])=>({id,url:page.url().slice(0,4096),title:(await page.title().catch(()=>"")).slice(0,512)})))});
    const requestId=typeof input.requestID==="string"?input.requestID:randomUUID(),hash=JSON.stringify(input),old=this.requests.get(requestId);
    if(old){if(old.hash!==hash)throw new Error("Browser operation identity was already used.");if(old.status==="complete")return old.result;throw new Error("Browser operation is running or interrupted. Inspect fresh state before repeating input.");}
    const request={controller:new AbortController(),status:"running",hash,result:undefined as unknown};this.requests.set(requestId,request);while(this.requests.size>1024)this.requests.delete(this.requests.keys().next().value!);
    try{const result=await this.perform(action,input,request.controller.signal);request.status="complete";request.result=result;return result;}catch(error){request.status="interrupted";throw new Error(error instanceof Error&&!["TypeError","TimeoutError","AbortError"].includes(error.name)?error.message.slice(0,2000):"Browser operation interrupted. Inspect fresh state before repeating input.");}
  }
  private async perform(action:string,input:Input,signal:AbortSignal){
    signal.throwIfAborted();const context=await this.start();signal.throwIfAborted();
    if(action==="open"){if(this.pages.size>=64)throw new Error("Close an existing tab before opening another.");const page=await context.newPage(),id=this.identify(page);if(input.url)await this.navigate(page,input.url);return text({id,url:page.url(),title:await page.title()});}
    const page=this.pages.get(String(input.tabId));if(!page||page.isClosed())throw new Error("Choose a current browser tab.");
    const id=this.identify(page),abort=()=>{void page.context().newCDPSession(page).then(cdp=>cdp.send("Page.stopLoading").finally(()=>cdp.detach())).catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
    try{
      const scope=input.frame?page.frameLocator(String(input.frame)):page;
      const locator=()=>{if(typeof input.selector!=="string"||!input.selector||input.selector.length>4096)throw new Error("Provide a selector from the latest snapshot.");return scope.locator(input.selector);};
      if(["click","hover","mouse-down","mouse-up"].includes(action)&&!input.selector){const frame=this.frames.get(String(input.frameId));if(!frame||frame.page!==page||Date.now()-frame.at>30000)throw new Error("Capture a fresh screenshot before coordinate input.");}
      switch(action){
        case "navigate":await this.navigate(page,input.url);break;
        case "back":await page.goBack({waitUntil:"domcontentloaded"});break;
        case "forward":await page.goForward({waitUntil:"domcontentloaded"});break;
        case "reload":await page.reload({waitUntil:"domcontentloaded"});break;
        case "mouse-down":await page.mouse.move(...point(input));await page.mouse.down({button:input.button??"left"});break;
        case "mouse-up":await page.mouse.move(...point(input));await page.mouse.up({button:input.button??"left"});break;
        case "paste":{const value=String(input.text??"");if(value.length>100000)throw new Error("Paste up to100,000 characters at a time.");await page.keyboard.insertText(value);break;}
        case "copy":return text({id,text:(await page.evaluate(()=>{const field=document.activeElement;if(field instanceof HTMLInputElement||field instanceof HTMLTextAreaElement){if(field instanceof HTMLInputElement&&field.type==="password")return "";return field.value.slice(field.selectionStart??0,field.selectionEnd??0);}return window.getSelection()?.toString()??"";})).slice(0,100000)});

        case "focus":await page.bringToFront();break;
        case "close":await page.close();return text({closed:true});
        case "snapshot":return text({id,url:page.url(),title:await page.title(),snapshot:(await scope.locator("body").ariaSnapshot()).slice(0,100000)});
        case "screenshot":{let bytes=await page.screenshot({type:"jpeg",quality:55,scale:"css",fullPage:false});if(bytes.length>650000)bytes=await page.screenshot({type:"jpeg",quality:20,scale:"css",fullPage:false});if(bytes.length>650000)throw new Error("Reduce the viewport before capturing again.");const frameId=randomUUID();this.frames.set(frameId,{page,at:Date.now()});while(this.frames.size>128)this.frames.delete(this.frames.keys().next().value!);return {content:[{type:"image",mimeType:"image/jpeg",data:bytes.toString("base64")}],structuredContent:{id,frameId,width:1280,height:800,url:page.url()}};}
        case "click":if(input.selector)await locator().click({button:input.button??"left",clickCount:input.clickCount??1});else await page.mouse.click(...point(input),{button:input.button??"left",clickCount:input.clickCount??1});break;
        case "fill":await locator().fill(String(input.text??""));break;
        case "type":if(input.selector)await locator().pressSequentially(String(input.text??""));else await page.keyboard.type(String(input.text??""));break;
        case "press":if(input.selector)await locator().press(String(input.key));else await page.keyboard.press(String(input.key));break;
        case "scroll":await page.mouse.wheel(Number.isFinite(input.x)?Number(input.x):0,Number.isFinite(input.y)?Number(input.y):500);break;
        case "hover":if(input.selector)await locator().hover();else await page.mouse.move(...point(input));break;
        case "select":await locator().selectOption(String(input.value));break;
        case "check":await locator().setChecked(input.checked!==false);break;
        case "drag":await locator().dragTo(scope.locator(String(input.destination)));break;
        case "evaluate":if(typeof input.code!=="string"||input.code.length>100000)throw new Error("Provide page JavaScript up to 100,000 characters.");return text({value:await page.evaluate(input.code)});
        case "upload":{if(typeof input.data!=="string"||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)||input.data.length>2800000)throw new Error("Provide base64 file data up to 2 MiB.");const bytes=Buffer.from(input.data,"base64");if(bytes.length>2*1024*1024)throw new Error("Upload exceeds 2 MiB.");await locator().setInputFiles({name:String(input.name??"upload").slice(0,200),mimeType:String(input.mimeType??"application/octet-stream"),buffer:bytes});break;}
        case "download":{
          const waiting=page.waitForEvent("download",{timeout:20000});waiting.catch(()=>{});await locator().click();const download=await waiting,stream=await download.createReadStream();
          if(!stream)throw new Error("Download is unavailable.");const chunks:Buffer[]=[];let length=0;for await(const chunk of stream){length+=chunk.length;if(length>64*1024*1024){await download.cancel();throw new Error("Download exceeds 64 MiB.");}chunks.push(Buffer.from(chunk));}
          if([...this.downloads.values()].reduce((sum,item)=>sum+item.bytes.length,0)+length>64*1024*1024)throw new Error("The browser download budget is full.");
          const downloadId=randomUUID(),name=download.suggestedFilename().slice(0,200);this.downloads.set(downloadId,{id:downloadId,name,bytes:Buffer.concat(chunks),tabId:id});return text({id:downloadId,name,size:length,status:"complete"});
        }
        case "dialog":this.dialogPolicies.set(id,{accept:input.accept===true,...(typeof input.text==="string"?{text:input.text.slice(0,4096)}:{})});return text({id,armed:true,message:"This policy applies to the next page dialog. Dialogs are otherwise dismissed."});
        case "downloads":return text({items:[...this.downloads.values()].filter(item=>item.tabId===id).map(({bytes,...item})=>({...item,size:bytes.length}))});
        case "read-download":{const item=this.downloads.get(String(input.id)),offset=Number(input.offset??0);if(!item||item.tabId!==id||!Number.isSafeInteger(offset)||offset<0||offset>item.bytes.length)throw new Error("Choose a completed download and byte offset.");const data=item.bytes.subarray(offset,offset+384*1024);return text({id:item.id,name:item.name,offset,nextOffset:offset+data.length,totalBytes:item.bytes.length,data:data.toString("base64")});}
        default:throw new Error("Unsupported browser action.");
      }
      signal.throwIfAborted();return text({id,url:page.url(),title:await page.title()});
    }finally{signal.removeEventListener("abort",abort);}
  }
  private async navigate(page:Page,value:unknown){const url=new URL(String(value));if(!["http:","https:"].includes(url.protocol)&&url.href!=="about:blank"||url.username||url.password)throw new Error("Use a public HTTP(S) URL or about:blank without credentials.");await page.goto(url.href,{waitUntil:"domcontentloaded"});}
}
let browser:WorkspaceBrowser|undefined;
export async function startWorkspaceBrowser(request:ContainerRequest){
  if(browser)return;
  browser=new WorkspaceBrowser({profile:"/session/browser-profile",...(request.egressProxyUrl?{proxy:{server:request.egressProxyUrl,username:request.projectId,password:request.gateway.token}}:{})});
  const server=createServer(socket=>{let buffer="";socket.on("data",chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>maxBytes){socket.destroy();return;}const end=buffer.indexOf("\n");if(end<0)return;const line=buffer.slice(0,end);buffer="";void Promise.resolve().then(()=>browser!.action(JSON.parse(line))).then(result=>socket.end(JSON.stringify({result})+"\n"),()=>socket.end(JSON.stringify({error:"Browser operation failed or was interrupted. Inspect fresh state before repeating input."})+"\n"));});});
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socketPath,resolve);});
}
export async function browserRequest(input:Input){
  return new Promise<any>((resolve,reject)=>{const socket=connect(socketPath);let output="";const timer=setTimeout(()=>{socket.destroy();reject(new Error("Browser operation outcome is uncertain. Inspect fresh state before repeating input."));},30000);socket.on("connect",()=>socket.write(JSON.stringify(input)+"\n"));socket.on("data",chunk=>{output+=chunk;if(Buffer.byteLength(output)>maxBytes){socket.destroy();reject(new Error("Browser response exceeds its limit."));}});socket.on("error",()=>{clearTimeout(timer);reject(new Error("Browser session is unavailable. Start a chat before opening its browser."));});socket.on("end",()=>{clearTimeout(timer);try{const result=JSON.parse(output);if(result.error)reject(new Error(result.error));else resolve(result.result);}catch{reject(new Error("Browser result was interrupted."));}});});
}
