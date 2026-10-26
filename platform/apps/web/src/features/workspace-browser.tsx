import "./workspace-interactions.css";
import {useEffect,useRef,useState} from "react";
import {Link,useSearchParams} from "react-router-dom";
import {send,useResource,type Project,type Conversation} from "../api";
import {useWorkspace} from "../workspace";
import {Card,Empty,ErrorNotice,Field,PageHeader} from "../components/ui";
type BrowserResult={content?:{type:string;mimeType?:string;data?:string;text?:string}[];structuredContent?:{tabs?:{id:string;url:string;title:string}[];id?:string;frameId?:string;width?:number;height?:number;url?:string;snapshot?:string}};
export function WorkspaceBrowserPage({project}:{project:Project}){
  const {orgBase}=useWorkspace(),[query,setQuery]=useSearchParams(),chats=useResource<{items:Conversation[]}>("/enterprise/api/projects/"+project.id+"/conversations"),selected=query.get("conversation")??chats.data?.items[0]?.id??"";
  const [tabs,setTabs]=useState<{id:string;url:string;title:string}[]>([]),[tabId,setTabId]=useState(""),[url,setUrl]=useState(""),[image,setImage]=useState<{data:string;frameId:string;width:number;height:number}|null>(null),[error,setError]=useState(""),[snapshot,setSnapshot]=useState(""),[busy,setBusy]=useState(false);
  const active=useRef(selected),inFlight=useRef(false),frame=useRef<HTMLDivElement>(null),currentTab=useRef(tabId),urlEdited=useRef(false),actions=useRef(Promise.resolve());active.current=selected;currentTab.current=tabId;
  async function request(input:Record<string,unknown>){return send<BrowserResult>("/enterprise/api/conversations/"+selected+"/browser",{...input,requestID:crypto.randomUUID()});}
  async function refresh(target=currentTab.current){
    if(!selected||inFlight.current)return;const owner=selected;inFlight.current=true;
    try{const result=await request({action:"tabs"});if(active.current!==owner)return;const current=result.structuredContent?.tabs??[];setTabs(current);const id=current.some(tab=>tab.id===target)?target:current[0]?.id??"";setTabId(id);
      if(id){const shot=await request({action:"screenshot",tabId:id});if(active.current!==owner)return;const picture=shot.content?.find(item=>item.type==="image"&&item.mimeType==="image/jpeg");if(picture?.data)setImage({data:picture.data,frameId:String(shot.structuredContent?.frameId),width:shot.structuredContent?.width??1280,height:shot.structuredContent?.height??800});if(!urlEdited.current)setUrl(current.find(tab=>tab.id===id)?.url??"");}else setImage(null);setError("");
    }catch(error){if(active.current===owner)setError((error as Error).message);}finally{inFlight.current=false;}
  }
  useEffect(()=>{urlEdited.current=false;setUrl("");setTabs([]);setTabId("");setImage(null);setSnapshot("");setError("");void refresh("");const timer=setInterval(()=>void refresh(),3000);return()=>clearInterval(timer);},[selected]);
  function act(input:Record<string,unknown>){
    const owner=selected;
    const perform=async()=>{
      if(!owner||active.current!==owner)return;
      while(inFlight.current){await new Promise(resolve=>setTimeout(resolve,25));if(active.current!==owner)return;}
      setBusy(true);
      try{const result=await request(input);if(active.current!==owner)return;if(input.action==="snapshot")setSnapshot(result.structuredContent?.snapshot??"");if(["navigate","open"].includes(String(input.action)))urlEdited.current=false;await refresh(String(result.structuredContent?.id??input.tabId??currentTab.current));setError("");}
      catch(error){if(active.current===owner)setError((error as Error).message);}
      finally{if(active.current===owner)setBusy(false);}
    };
    actions.current=actions.current.then(perform,perform);return actions.current;
  }
  return <section className="desktop-content-page workspace-browser-page"><PageHeader title="Browser" description="Operate the same isolated browser as this chat's agent. Opening this viewer does not start or replay an agent run."/><ErrorNotice message={error||chats.error} onRetry={()=>void refresh()}/><div className="browser-toolbar"><Field label="Chat"><select value={selected} onChange={event=>setQuery({conversation:event.target.value})}>{chats.data?.items.map(chat=><option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></Field><Field label="Tab"><select value={tabId} onChange={event=>{urlEdited.current=false;setTabId(event.target.value);void refresh(event.target.value);}}><option value="">Choose a tab</option>{tabs.map(tab=><option key={tab.id} value={tab.id}>{tab.title||tab.url||"Blank tab"}</option>)}</select></Field><button className="secondary" disabled={!selected||busy} onClick={()=>void act({action:"open",url:"about:blank"})}>New tab</button></div><form className="browser-address" onSubmit={event=>{event.preventDefault();void act({action:tabId?"navigate":"open",tabId,url});}}><input aria-label="Browser URL" value={url} onChange={event=>{urlEdited.current=true;setUrl(event.target.value);}} placeholder="https://example.com" disabled={!selected||busy}/><button className="secondary" disabled={!selected||busy||!url}>Go</button><button type="button" className="secondary" disabled={!tabId||busy} onClick={()=>void act({action:"snapshot",tabId})}>Read page</button><button type="button" className="text-button" disabled={!tabId||busy} onClick={()=>void act({action:"close",tabId})}>Close tab</button></form>
    {image?<div ref={frame} className="browser-viewport" tabIndex={0} role="application" aria-label="Interactive workspace browser" onKeyDown={event=>{if(event.key==="Tab")return;event.preventDefault();void act({action:"press",tabId,key:event.key.length===1?event.key:event.key});}} onWheel={event=>{void act({action:"scroll",tabId,x:event.deltaX,y:event.deltaY});}}><img src={"data:image/jpeg;base64,"+image.data} alt="Current workspace browser page" draggable={false} onClick={event=>{frame.current?.focus();const bounds=event.currentTarget.getBoundingClientRect();void act({action:"click",tabId,frameId:image.frameId,x:(event.clientX-bounds.left)*image.width/bounds.width,y:(event.clientY-bounds.top)*image.height/bounds.height});}}/></div>:<Empty title={selected?"No open browser tab":"No chat selected"}>{selected?"A chat must have a retained native environment before its browser can open. New tab starts only its browser.":"Create a workspace chat first."}</Empty>}
    {snapshot?<Card title="Current page snapshot"><pre className="browser-snapshot">{snapshot}</pre></Card>:null}{selected?<Link to={orgBase+"/workspaces/"+project.id+"?conversation="+selected}>Return to chat</Link>:null}
  </section>;
}
