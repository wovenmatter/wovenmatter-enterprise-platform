import "./workspace-interactions.css";
import {useEffect,useRef,useState,type KeyboardEvent,type PointerEvent} from "react";
import {send} from "../api";
import type {RemoteTab} from "./workspace-assets";
import {Card,Empty,ErrorNotice,Loading} from "../components/ui";
type BrowserResult={content?:{type:string;mimeType?:string;data?:string;text?:string}[];structuredContent?:{tabs?:{id:string;url:string;title:string}[];id?:string;frameId?:string;width?:number;height?:number;url?:string;snapshot?:string;text?:string}};
export function WorkspaceBrowserPane({conversationId,tabId:requestedTabId,onTabs,active:visible=true}:{conversationId:string;tabId:string;onTabs:(tabs:RemoteTab[])=>void;active?:boolean}){
 const selected=conversationId,inventory=useRef(onTabs);inventory.current=onTabs;
 const [loaded,setLoaded]=useState(false),[tabId,setTabId]=useState(""),[url,setUrl]=useState(""),[image,setImage]=useState<{tabId:string;data:string;frameId:string;width:number;height:number}|null>(null),[error,setError]=useState(""),[snapshot,setSnapshot]=useState(""),[busy,setBusy]=useState(false),[typed,setTyped]=useState("");
 const enabled=useRef(visible);enabled.current=visible;
 const epoch=useRef(0),scope=useRef({visible,requestedTabId});
 if(scope.current.visible!==visible||scope.current.requestedTabId!==requestedTabId){scope.current={visible,requestedTabId};epoch.current++;}
 const active=useRef(selected),inFlight=useRef(false),frame=useRef<HTMLDivElement>(null),address=useRef<HTMLInputElement>(null),currentTab=useRef(tabId),urlEdited=useRef(false),actions=useRef<Promise<unknown>>(Promise.resolve()),actionBusy=useRef(false),captureTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),moveTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),lastMove=useRef<Record<string,unknown>|undefined>(undefined);
 active.current=selected;currentTab.current=tabId;
 async function request(input:Record<string,unknown>,owner=selected){return send<BrowserResult>("/enterprise/api/conversations/"+owner+"/browser",{...input,requestID:crypto.randomUUID()});}
 async function refresh(target=scope.current.requestedTabId||currentTab.current,force=false){
  if(!enabled.current||!selected||inFlight.current||actionBusy.current&&!force)return;const owner=selected,generation=epoch.current;inFlight.current=true;
  try{
   const result=await request({action:"tabs"},owner);if(active.current!==owner||generation!==epoch.current||!enabled.current)return;setLoaded(true);const current=result.structuredContent?.tabs??[];inventory.current(current);const id=current.some(tab=>tab.id===target)?target:current[0]?.id??"";setTabId(id);
   if(id){const shot=await request({action:"screenshot",tabId:id},owner);if(active.current!==owner||generation!==epoch.current||!enabled.current)return;const picture=shot.content?.find(item=>item.type==="image"&&item.mimeType==="image/jpeg");if(picture?.data)setImage({tabId:id,data:picture.data,frameId:String(shot.structuredContent?.frameId),width:shot.structuredContent?.width??1280,height:shot.structuredContent?.height??800});if(!urlEdited.current)setUrl(current.find(tab=>tab.id===id)?.url??"");}else setImage(null);setError("");
  }catch(error){if(active.current===owner&&generation===epoch.current&&enabled.current){setError((error as Error).message);setImage(null);setLoaded(true);}}finally{inFlight.current=false;}
 }
 useEffect(()=>{
  if(!visible)return;urlEdited.current=false;setLoaded(false);setUrl("");setTabId(requestedTabId);setImage(null);setSnapshot("");setError("");setTyped("");void refresh(requestedTabId);const timer=setInterval(()=>{if(document.visibilityState==="visible")void refresh();},750);
  return()=>{epoch.current++;active.current="";clearInterval(timer);clearTimeout(captureTimer.current);clearTimeout(moveTimer.current);lastMove.current=undefined;};
 },[selected,visible]);
 useEffect(()=>{if(requestedTabId!==currentTab.current){urlEdited.current=false;setTabId(requestedTabId);setImage(null);setSnapshot("");setTyped("");void refresh(requestedTabId);}},[requestedTabId]);
 const validImage=image?.tabId===requestedTabId&&tabId===requestedTabId?image:null;
 function act(input:Record<string,unknown>){
  const owner=selected,generation=epoch.current;
  const perform=async()=>{
   if(!enabled.current||!owner||active.current!==owner||generation!==epoch.current||input.tabId!==undefined&&input.tabId!==scope.current.requestedTabId)return;
   while(inFlight.current){await new Promise(resolve=>setTimeout(resolve,25));if(active.current!==owner||generation!==epoch.current||!enabled.current)return;}
   actionBusy.current=true;setBusy(true);
   try{
    const result=await request(input,owner);if(active.current!==owner||generation!==epoch.current||!enabled.current)return;
    if(input.action==="snapshot")setSnapshot(result.structuredContent?.snapshot??"");
    if(input.action==="copy"){await navigator.clipboard.writeText(result.structuredContent?.text??"");}
    if(["navigate","open","back","forward","reload"].includes(String(input.action)))urlEdited.current=false;
    if(["press","paste","scroll","hover","mouse-down","mouse-up"].includes(String(input.action))){
     clearTimeout(captureTimer.current);captureTimer.current=setTimeout(()=>{if(active.current===owner&&generation===epoch.current&&enabled.current)void refresh();},100);
    }else await refresh(String(result.structuredContent?.id??input.tabId??currentTab.current),true);
    setError("");return result;
   }catch(error){if(active.current===owner&&generation===epoch.current&&enabled.current)setError((error as Error).message);}
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
  return {tabId:validImage!.tabId,frameId:validImage!.frameId,x:Math.max(0,Math.min(validImage!.width-1,(event.clientX-bounds.left)*validImage!.width/bounds.width)),y:Math.max(0,Math.min(validImage!.height-1,(event.clientY-bounds.top)*validImage!.height/bounds.height)),button:event.button===2?"right":event.button===1?"middle":"left"};
 }
 function move(event:PointerEvent<HTMLImageElement>){
  lastMove.current={action:"hover",...position(event)};
  const flush=()=>{if(!lastMove.current){moveTimer.current=undefined;return;}if(actionBusy.current){moveTimer.current=setTimeout(flush,50);return;}const input=lastMove.current;lastMove.current=undefined;moveTimer.current=undefined;void act(input);};
  if(!moveTimer.current)moveTimer.current=setTimeout(flush,50);
 }
 useEffect(()=>{
  const node=frame.current;if(!node)return;const wheel=(event:WheelEvent)=>{event.preventDefault();void act({action:"scroll",tabId,x:event.deltaX,y:event.deltaY});};node.addEventListener("wheel",wheel,{passive:false});return()=>node.removeEventListener("wheel",wheel);
 },[image?.frameId,tabId,selected]);
 return <section className="workspace-browser-pane" aria-label="Agent browser viewer">
  <ErrorNotice message={error} onRetry={()=>void refresh()}/>
  {tabId?<form className="browser-address" onSubmit={event=>{event.preventDefault();const target=url.trim();void act({action:"navigate",tabId,url:target.includes("://")?target:"https://"+target});}}>
   {["back","forward","reload"].map(action=><button key={action} type="button" className="secondary" disabled={!tabId||busy} onClick={()=>void act({action,tabId})}>{action[0]!.toUpperCase()+action.slice(1)}</button>)}
   <input ref={address} aria-label="Browser URL" value={url} onChange={event=>{urlEdited.current=true;setUrl(event.target.value);}} placeholder="https://example.com" disabled={!selected}/>
   <button className="secondary" disabled={!selected||busy||!url}>Go</button><button type="button" className="secondary" disabled={!tabId||busy} onClick={()=>void act({action:"snapshot",tabId})}>Read page</button>
  </form>:null}
  {validImage?<><div data-browser-tab={validImage.tabId} data-browser-frame={validImage.frameId} ref={frame} className="browser-viewport" tabIndex={0} role="application" aria-label="Interactive workspace browser" aria-describedby="workspace-browser-help" onKeyDown={key} onPaste={event=>{event.preventDefault();const text=event.clipboardData.getData("text/plain");if(text.length>100000)setError("Paste up to 100,000 characters at a time.");else void act({action:"paste",tabId,text});}}>
   <img src={"data:image/jpeg;base64,"+validImage.data} alt="Current workspace browser page" draggable={false} onContextMenu={event=>event.preventDefault()} onPointerDown={event=>{event.preventDefault();frame.current?.focus();event.currentTarget.setPointerCapture(event.pointerId);void act({action:"mouse-down",...position(event)});}} onPointerMove={move} onPointerUp={event=>{event.preventDefault();clearTimeout(moveTimer.current);moveTimer.current=undefined;lastMove.current=undefined;void act({action:"mouse-up",...position(event)});event.currentTarget.releasePointerCapture(event.pointerId);}}/>
  </div><p id="workspace-browser-help" className="muted browser-help">Click, type, paste or scroll in the viewer. Tab moves within the remote page; Escape returns to the address field.</p>
  <form className="browser-address" onSubmit={async event=>{event.preventDefault();if(await act({action:"paste",tabId,text:typed}))setTyped("");}}><input aria-label="Text for focused page field" autoComplete="off" maxLength={100000} value={typed} onChange={event=>setTyped(event.target.value)} placeholder="Text for the focused page field"/><button className="secondary" disabled={!typed||busy}>Type text</button></form></>:error?<Empty title="Agent browser unavailable">Check this chat’s browser access and refresh.</Empty>:tabId||!loaded?<Loading/>:<Empty title="No shared agent browser">The agent has not opened a browser in this chat. Ask it to use the shared workspace browser; its tabs will appear here. Opening this viewer does not start a browser or agent turn.</Empty>}
  {snapshot?<Card title="Current page snapshot"><pre className="browser-snapshot">{snapshot}</pre></Card>:null}
 </section>;
}
