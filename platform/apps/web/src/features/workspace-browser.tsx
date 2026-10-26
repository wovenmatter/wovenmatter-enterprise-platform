import "./workspace-interactions.css";
import {useEffect,useRef,useState,type KeyboardEvent,type PointerEvent} from "react";
import {Link,useSearchParams} from "react-router-dom";
import {send,useResource,type Project,type Conversation} from "../api";
import {useWorkspace} from "../workspace";
import {Card,Empty,ErrorNotice,Field,PageHeader} from "../components/ui";
type BrowserResult={content?:{type:string;mimeType?:string;data?:string;text?:string}[];structuredContent?:{tabs?:{id:string;url:string;title:string}[];id?:string;frameId?:string;width?:number;height?:number;url?:string;snapshot?:string;text?:string}};
export function WorkspaceBrowserPage({project}:{project:Project}){
 const {orgBase}=useWorkspace(),[query,setQuery]=useSearchParams(),chats=useResource<{items:Conversation[]}>("/enterprise/api/projects/"+project.id+"/conversations"),selected=query.get("conversation")??chats.data?.items[0]?.id??"";
 const [tabs,setTabs]=useState<{id:string;url:string;title:string}[]>([]),[tabId,setTabId]=useState(""),[url,setUrl]=useState(""),[image,setImage]=useState<{data:string;frameId:string;width:number;height:number}|null>(null),[error,setError]=useState(""),[snapshot,setSnapshot]=useState(""),[busy,setBusy]=useState(false),[typed,setTyped]=useState("");
 const active=useRef(selected),inFlight=useRef(false),frame=useRef<HTMLDivElement>(null),address=useRef<HTMLInputElement>(null),currentTab=useRef(tabId),urlEdited=useRef(false),actions=useRef<Promise<unknown>>(Promise.resolve()),actionBusy=useRef(false),captureTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),moveTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),lastMove=useRef<Record<string,unknown>|undefined>(undefined);
 active.current=selected;currentTab.current=tabId;
 async function request(input:Record<string,unknown>,owner=selected){return send<BrowserResult>("/enterprise/api/conversations/"+owner+"/browser",{...input,requestID:crypto.randomUUID()});}
 async function refresh(target=currentTab.current,force=false){
  if(!selected||inFlight.current||actionBusy.current&&!force)return;const owner=selected;inFlight.current=true;
  try{
   const result=await request({action:"tabs"},owner);if(active.current!==owner)return;const current=result.structuredContent?.tabs??[];setTabs(current);const id=current.some(tab=>tab.id===target)?target:current[0]?.id??"";setTabId(id);
   if(id){const shot=await request({action:"screenshot",tabId:id},owner);if(active.current!==owner)return;const picture=shot.content?.find(item=>item.type==="image"&&item.mimeType==="image/jpeg");if(picture?.data)setImage({data:picture.data,frameId:String(shot.structuredContent?.frameId),width:shot.structuredContent?.width??1280,height:shot.structuredContent?.height??800});if(!urlEdited.current)setUrl(current.find(tab=>tab.id===id)?.url??"");}else setImage(null);setError("");
  }catch(error){if(active.current===owner)setError((error as Error).message);}finally{inFlight.current=false;}
 }
 useEffect(()=>{
  urlEdited.current=false;setUrl("");setTabs([]);setTabId("");setImage(null);setSnapshot("");setError("");setTyped("");void refresh("");const timer=setInterval(()=>void refresh(),3000);
  return()=>{active.current="";clearInterval(timer);clearTimeout(captureTimer.current);clearTimeout(moveTimer.current);lastMove.current=undefined;};
 },[selected]);
 function act(input:Record<string,unknown>){
  const owner=selected;
  const perform=async()=>{
   if(!owner||active.current!==owner)return;
   while(inFlight.current){await new Promise(resolve=>setTimeout(resolve,25));if(active.current!==owner)return;}
   actionBusy.current=true;setBusy(true);
   try{
    const result=await request(input,owner);if(active.current!==owner)return;
    if(input.action==="snapshot")setSnapshot(result.structuredContent?.snapshot??"");
    if(input.action==="copy"){await navigator.clipboard.writeText(result.structuredContent?.text??"");}
    if(["navigate","open","back","forward","reload"].includes(String(input.action)))urlEdited.current=false;
    if(["press","paste","scroll","hover","mouse-down","mouse-up"].includes(String(input.action))){
     clearTimeout(captureTimer.current);captureTimer.current=setTimeout(()=>{if(active.current===owner)void refresh();},100);
    }else await refresh(String(result.structuredContent?.id??input.tabId??currentTab.current),true);
    setError("");return result;
   }catch(error){if(active.current===owner)setError((error as Error).message);}
   finally{actionBusy.current=false;if(active.current===owner)setBusy(false);}
  };
  const result=actions.current.then(perform,perform);actions.current=result;return result;
 }
 function key(event:KeyboardEvent<HTMLDivElement>){
  if(event.nativeEvent.isComposing||["Process","Dead","Unidentified","Shift","Control","Alt","Meta"].includes(event.key))return;
  const command=event.ctrlKey||event.metaKey;
  if(event.key==="Escape"||command&&event.key.toLowerCase()==="l"){event.preventDefault();address.current?.focus();return;}
  if(command&&event.key.toLowerCase()==="r"){event.preventDefault();void act({action:"reload",tabId});return;}
  if(command&&event.key.toLowerCase()==="v")return; // The explicit paste event supplies text; no clipboard read grant.
  event.preventDefault();
  if(command&&event.key.toLowerCase()==="c"){void act({action:"copy",tabId});return;}
  const value=event.key===" "?"Space":event.key;
  const chord=[...(command?["Control"]:[]),...(event.altKey?["Alt"]:[]),...(event.shiftKey?["Shift"]:[]),value].join("+");
  if(!command&&!event.altKey&&event.key.length===1&&event.key.charCodeAt(0)>127)void act({action:"paste",tabId,text:event.key});
  else void act({action:"press",tabId,key:chord});
 }
 function position(event:PointerEvent<HTMLImageElement>){
  const bounds=event.currentTarget.getBoundingClientRect();
  return {tabId,frameId:image!.frameId,x:Math.max(0,Math.min(image!.width-1,(event.clientX-bounds.left)*image!.width/bounds.width)),y:Math.max(0,Math.min(image!.height-1,(event.clientY-bounds.top)*image!.height/bounds.height)),button:event.button===2?"right":event.button===1?"middle":"left"};
 }
 function move(event:PointerEvent<HTMLImageElement>){
  lastMove.current={action:"hover",...position(event)};
  const flush=()=>{if(!lastMove.current){moveTimer.current=undefined;return;}if(actionBusy.current){moveTimer.current=setTimeout(flush,50);return;}const input=lastMove.current;lastMove.current=undefined;moveTimer.current=undefined;void act(input);};
  if(!moveTimer.current)moveTimer.current=setTimeout(flush,50);
 }
 useEffect(()=>{
  const node=frame.current;if(!node)return;const wheel=(event:WheelEvent)=>{event.preventDefault();void act({action:"scroll",tabId,x:event.deltaX,y:event.deltaY});};node.addEventListener("wheel",wheel,{passive:false});return()=>node.removeEventListener("wheel",wheel);
 },[image?.frameId,tabId,selected]);
 return <section className="desktop-content-page workspace-browser-page">
  <PageHeader title="Browser" description="Operate the same isolated browser as this chat's agent. Opening this viewer does not start or replay an agent run."/>
  <ErrorNotice message={error||chats.error} onRetry={()=>void refresh()}/>
  <div className="browser-toolbar"><Field label="Chat"><select value={selected} onChange={event=>setQuery({conversation:event.target.value})}>{chats.data?.items.map(chat=><option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></Field><Field label="Tab"><select value={tabId} onChange={event=>{urlEdited.current=false;setTabId(event.target.value);void refresh(event.target.value);}}><option value="">Choose a tab</option>{tabs.map(tab=><option key={tab.id} value={tab.id}>{tab.title||tab.url||"Blank tab"}</option>)}</select></Field><button className="secondary" disabled={!selected||busy} onClick={()=>void act({action:"open",url:"about:blank"})}>New tab</button></div>
  <form className="browser-address" onSubmit={event=>{event.preventDefault();const target=url.trim();void act({action:tabId?"navigate":"open",tabId,url:target.includes("://")||target==="about:blank"?target:"https://"+target});}}>
   {["back","forward","reload"].map(action=><button key={action} type="button" className="secondary" disabled={!tabId||busy} onClick={()=>void act({action,tabId})}>{action[0]!.toUpperCase()+action.slice(1)}</button>)}
   <input ref={address} aria-label="Browser URL" value={url} onChange={event=>{urlEdited.current=true;setUrl(event.target.value);}} placeholder="https://example.com" disabled={!selected}/>
   <button className="secondary" disabled={!selected||busy||!url}>Go</button><button type="button" className="secondary" disabled={!tabId||busy} onClick={()=>void act({action:"snapshot",tabId})}>Read page</button><button type="button" className="text-button" disabled={!tabId||busy} onClick={()=>void act({action:"close",tabId})}>Close tab</button>
  </form>
  {image?<><div ref={frame} className="browser-viewport" tabIndex={0} role="application" aria-label="Interactive workspace browser" aria-describedby="workspace-browser-help" onKeyDown={key} onPaste={event=>{event.preventDefault();const text=event.clipboardData.getData("text/plain");if(text.length>100000)setError("Paste up to 100,000 characters at a time.");else void act({action:"paste",tabId,text});}}>
   <img src={"data:image/jpeg;base64,"+image.data} alt="Current workspace browser page" draggable={false} onContextMenu={event=>event.preventDefault()} onPointerDown={event=>{event.preventDefault();frame.current?.focus();event.currentTarget.setPointerCapture(event.pointerId);void act({action:"mouse-down",...position(event)});}} onPointerMove={move} onPointerUp={event=>{event.preventDefault();clearTimeout(moveTimer.current);moveTimer.current=undefined;lastMove.current=undefined;void act({action:"mouse-up",...position(event)});event.currentTarget.releasePointerCapture(event.pointerId);}}/>
  </div><p id="workspace-browser-help" className="muted">Click, type, paste or scroll in the viewer. Tab moves within the remote page; Escape returns to the address field.</p>
  <form className="browser-address" onSubmit={async event=>{event.preventDefault();if(await act({action:"paste",tabId,text:typed}))setTyped("");}}><input aria-label="Text for focused page field" autoComplete="off" maxLength={100000} value={typed} onChange={event=>setTyped(event.target.value)} placeholder="Text for the focused page field"/><button className="secondary" disabled={!typed||busy}>Type text</button></form></>:<Empty title={selected?"No open browser tab":"No chat selected"}>{selected?"A chat must have a retained native environment before its browser can open. New tab starts only its browser.":"Create a workspace chat first."}</Empty>}
  {snapshot?<Card title="Current page snapshot"><pre className="browser-snapshot">{snapshot}</pre></Card>:null}{selected?<Link to={orgBase+"/workspaces/"+project.id+"?conversation="+selected}>Return to chat</Link>:null}
 </section>;
}
