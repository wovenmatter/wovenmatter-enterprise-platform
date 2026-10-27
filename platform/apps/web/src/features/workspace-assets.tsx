import {createContext,lazy,Suspense,useContext,useEffect,useRef,useState,type ReactNode,type CSSProperties} from "react";
import {useSearchParams} from "react-router-dom";
import {ArrowLeft,ArrowRight,FileText,Globe,Maximize2,Minimize2,PanelRightClose,X} from "lucide-react";
import {useWorkspace} from "../workspace";
import type {Project} from "../api";
import {Icon} from "../components/controls";
import {ErrorNotice,Loading} from "../components/ui";
import {WorkspaceNotePanel} from "../shell/WorkspaceDetails";
import "./workspace-assets.css";
const BrowserPane=lazy(()=>import("./workspace-browser").then(module=>({default:module.WorkspaceBrowserPane})));
type AssetTab={kind:"note";id:string;title:string}|{kind:"browser";id:string;conversationId:string;remoteId:string;title:string};
type AssetState={tabs:AssetTab[];selected:string;presented:boolean;left:boolean;focused:boolean;chatPercent:number};
const empty:AssetState={tabs:[],selected:"",presented:false,left:false,focused:false,chatPercent:50};
const Assets=createContext<{openBrowser:()=>void;show:()=>void;hasTabs:boolean}|null>(null);
export type RemoteTab={id:string;url:string;title:string};
function stored(key:string):AssetState{
 try{const value=JSON.parse(sessionStorage.getItem(key)??"null");if(!value||!Array.isArray(value.tabs))return empty;
 const tabs=value.tabs.filter((tab:AssetTab)=>tab&&typeof tab.id==="string"&&tab.id.length<400&&typeof tab.title==="string"&&(tab.kind==="note"||tab.kind==="browser"&&typeof tab.conversationId==="string"&&typeof tab.remoteId==="string")).slice(0,40);
 return {tabs,selected:typeof value.selected==="string"?value.selected:"",presented:value.presented===true,left:value.left===true,focused:false,chatPercent:Number.isFinite(value.chatPercent)?Math.max(30,Math.min(70,value.chatPercent)):50};
 }catch{return empty;}
}
export function WorkspaceAssetTrigger({conversationId}:{conversationId?:string}){
 const assets=useContext(Assets);
 return <header className="workspace-chat-tools">
  {assets?.hasTabs?<button className="icon-button" aria-label="Show assets" title="Show assets" onClick={assets.show}><Icon icon={PanelRightClose} size={16}/></button>:null}
  <button className="icon-button" aria-label="Open agent browser" title="Open agent browser" disabled={!conversationId} onClick={assets?.openBrowser}><Icon icon={Globe} size={16}/></button>
 </header>;
}
export function WorkspaceAssetLayout({project,conversationId,children}:{project:Project;conversationId?:string;children:ReactNode}){
 const {user}=useWorkspace(),[query,setQuery]=useSearchParams(),storageKey="wme:assets:v1:"+user.id+":"+project.id;
 const [state,setState]=useState(()=>stored(storageKey)),[error,setError]=useState(""),[compact,setCompact]=useState(false);
 const root=useRef<HTMLDivElement>(null),hiddenBrowsers=useRef(new Set<string>()),dragging=useRef(false);
 const note=query.get("note"),browser=query.get("browser");
 const visible=state.tabs.filter(tab=>tab.kind==="note"||tab.conversationId===conversationId);
 const selected=visible.find(tab=>tab.id===state.selected)??visible[0];
 const presented=state.presented&&visible.length>0;
 useEffect(()=>{try{sessionStorage.setItem(storageKey,JSON.stringify(state));}catch{/* Presentation still works without browser storage. */}},[state,storageKey]);
 useEffect(()=>{
  if(!root.current)return;const observer=new ResizeObserver(entries=>setCompact(entries[0]!.contentRect.width<660));observer.observe(root.current);return()=>observer.disconnect();
 },[]);
 function updateSelection(tab:AssetTab){
  setState(value=>({...value,selected:tab.id,presented:true}));
  setQuery(value=>{const next=new URLSearchParams(value);if(tab.kind==="note"){next.set("note",tab.id.slice(5));next.delete("browser");}else{next.delete("note");next.set("browser","1");}return next;},{replace:true});
 }
 function openBrowser(){
  if(!conversationId)return;hiddenBrowsers.current.clear();
  setState(value=>{const existing=value.tabs.find(tab=>tab.id===value.selected&&tab.kind==="browser"&&tab.conversationId===conversationId)??value.tabs.find(tab=>tab.kind==="browser"&&tab.conversationId===conversationId);const tab:AssetTab=existing??{kind:"browser",id:"browser:"+conversationId+":empty",conversationId,remoteId:"",title:"Agent browser"};return {...value,tabs:existing?value.tabs:[...value.tabs,tab],selected:tab.id,presented:true};});
  setQuery(value=>{const next=new URLSearchParams(value);next.delete("note");next.set("browser","1");return next;},{replace:true});
 }
 useEffect(()=>{
  if(!note)return;
  const id="note:"+note;
  setState(value=>{if(value.tabs.some(tab=>tab.id===id))return {...value,selected:id,presented:true};if(value.tabs.filter(tab=>tab.kind==="note").length>=4){setError("You have 4 note tabs open. Close a note tab before opening another.");return value;}return {...value,tabs:[...value.tabs,{kind:"note",id,title:"Note"}],selected:id,presented:true};});
 },[note]);
 useEffect(()=>{
  if(browser!=="1"||!conversationId)return;
  setState(value=>{const selected=value.tabs.find(tab=>tab.id===value.selected&&tab.kind==="browser"&&tab.conversationId===conversationId);if(selected)return value;const existing=value.tabs.find(tab=>tab.kind==="browser"&&tab.conversationId===conversationId);const tab:AssetTab=existing??{kind:"browser",id:"browser:"+conversationId+":empty",conversationId,remoteId:"",title:"Agent browser"};return {...value,tabs:existing?value.tabs:[...value.tabs,tab],selected:tab.id,presented:true};});
 },[browser,conversationId]);
 function close(tab:AssetTab){
  if(tab.kind==="browser")hiddenBrowsers.current.add(tab.id);
  setState(value=>{const tabs=value.tabs.filter(item=>item.id!==tab.id),shown=tabs.filter(item=>item.kind==="note"||item.conversationId===conversationId),next=shown[Math.min(visible.findIndex(item=>item.id===tab.id),shown.length-1)];return {...value,tabs,selected:value.selected===tab.id?next?.id??"":value.selected,presented:shown.length>0&&value.presented};});
  if(selected?.id===tab.id)setQuery(value=>{const next=new URLSearchParams(value);next.delete(tab.kind==="note"?"note":"browser");return next;},{replace:true});
 }
 function inventory(tabs:RemoteTab[]){
  if(!conversationId)return;
  setState(value=>{
   const owner=value.tabs.filter((tab):tab is Extract<AssetTab,{kind:"browser"}>=>tab.kind==="browser"&&tab.conversationId===conversationId);
   if(!owner.length)return value;
   const others=value.tabs.filter(tab=>tab.kind!=="browser"||tab.conversationId!==conversationId);
   const next:AssetTab[]=tabs.map(tab=>({kind:"browser" as const,id:"browser:"+conversationId+":"+tab.id,conversationId,remoteId:tab.id,title:tab.title||tab.url||"Agent browser"})).filter(tab=>!hiddenBrowsers.current.has(tab.id)).slice(0,8);
   if(!tabs.length)next.push({kind:"browser",id:"browser:"+conversationId+":empty",conversationId,remoteId:"",title:"Agent browser"});
   const selected=value.selected.startsWith("browser:"+conversationId+":")&&!next.some(tab=>tab.id===value.selected)?next[0]?.id??others[0]?.id??"":value.selected;
   const replacements=new Map(next.map(tab=>[tab.id,tab])),combined:AssetTab[]=[];
   for(const old of value.tabs){
    if(old.kind!=="browser"||old.conversationId!==conversationId){combined.push(old);continue;}
    const updated=replacements.get(old.id);if(updated){combined.push(updated);replacements.delete(old.id);}
    else if((old.remoteId===""||next.length===1&&next[0]!.kind==="browser"&&next[0]!.remoteId==="")&&replacements.size){const first=replacements.values().next().value!;combined.push(first);replacements.delete(first.id);}
   }
   combined.push(...replacements.values());if(JSON.stringify(combined)===JSON.stringify(value.tabs)&&selected===value.selected)return value;
   return {...value,tabs:combined,selected,presented:combined.length>0&&value.presented};
  });
 }
 function title(id:string,title:string){setState(value=>value.tabs.some(tab=>tab.id===id&&tab.title!==title)?{...value,tabs:value.tabs.map(tab=>tab.id===id?{...tab,title}:tab)}:value);}
 function resize(clientX:number){const bounds=root.current?.getBoundingClientRect();if(!bounds)return;const percent=(clientX-bounds.left)/bounds.width*100;setState(value=>({...value,chatPercent:Math.max(30,Math.min(70,value.left?100-percent:percent))}));}
 return <Assets.Provider value={{openBrowser,show:()=>setState(value=>({...value,presented:true})),hasTabs:visible.length>0}}>
  <div ref={root} className={"conversation-layout asset-workspace"+(presented?" has-assets":"")+(state.left?" assets-left":"")+(state.focused?" assets-focused":"")+(compact?" assets-compact":"")} style={{"--chat-percent":state.chatPercent+"%"} as CSSProperties}>
   {children}
   <div className="asset-split" hidden={!presented||compact||state.focused} role="separator" aria-label="Chat and assets width" aria-orientation="vertical" tabIndex={0} aria-valuemin={30} aria-valuemax={70} aria-valuenow={Math.round(state.chatPercent)}
    onPointerDown={event=>{dragging.current=true;event.currentTarget.setPointerCapture(event.pointerId);resize(event.clientX);}} onPointerMove={event=>{if(dragging.current)resize(event.clientX);}} onPointerUp={event=>{dragging.current=false;event.currentTarget.releasePointerCapture(event.pointerId);}}
    onKeyDown={event=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){event.preventDefault();setState(value=>({...value,chatPercent:event.key==="Home"?30:event.key==="End"?70:Math.max(30,Math.min(70,value.chatPercent+(event.key==="ArrowRight"?1:-1)*(value.left?-2:2)))}));}}}/>
   <section className="workspace-asset-pane" aria-label="Workspace assets" hidden={!presented}>
    <header className="asset-toolbar">
     <button className="icon-button asset-back" aria-label="Back to chat" title="Back to chat" onClick={()=>setState(value=>({...value,presented:false}))}><Icon icon={ArrowLeft} size={14}/></button>
     <div className="asset-tablist" role="tablist" aria-label="Open assets" onKeyDown={event=>{if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;event.preventDefault();const at=visible.findIndex(tab=>tab.id===selected?.id),index=event.key==="Home"?0:event.key==="End"?visible.length-1:(at+(event.key==="ArrowRight"?1:-1)+visible.length)%visible.length;const tab=visible[index];if(tab){updateSelection(tab);event.currentTarget.querySelector<HTMLButtonElement>('[data-asset-id="'+CSS.escape(tab.id)+'"]')?.focus();}}}>
      {visible.map(tab=><div key={tab.id} className={"asset-tab"+(selected?.id===tab.id?" active":"")}>
       <button role="tab" data-asset-id={tab.id} aria-selected={selected?.id===tab.id} tabIndex={selected?.id===tab.id?0:-1} aria-controls="workspace-asset-content" title={tab.title} onClick={()=>updateSelection(tab)}><Icon icon={tab.kind==="browser"?Globe:FileText} size={13}/><span>{tab.title}</span></button>
       <button className="icon-button" aria-label={tab.kind==="note"&&selected?.id===tab.id?"Close note":"Close "+tab.title} title="Close view" onClick={()=>close(tab)}><Icon icon={X} size={12}/></button>
      </div>)}
     </div>
     <button className="icon-button asset-placement" aria-label={state.left?"Move assets right":"Move assets left"} title={state.left?"Move assets right":"Move assets left"} onClick={()=>setState(value=>({...value,left:!value.left}))}><Icon icon={state.left?ArrowRight:ArrowLeft} size={14}/></button>
     <button className="icon-button asset-focus" aria-label={state.focused?"Restore chat and assets":"Focus assets"} title={state.focused?"Restore chat and assets":"Focus assets"} onClick={()=>setState(value=>({...value,focused:!value.focused}))}><Icon icon={state.focused?Minimize2:Maximize2} size={14}/></button>
     <button className="icon-button" aria-label="Hide assets" title="Hide assets" onClick={()=>setState(value=>({...value,presented:false}))}><Icon icon={PanelRightClose} size={14}/></button>
    </header>
    <ErrorNotice message={error}/>
    <div id="workspace-asset-content" className="asset-content">
     {state.tabs.filter(tab=>tab.kind==="note").map(tab=><div className="asset-document" hidden={selected?.id!==tab.id} key={tab.id}><WorkspaceNotePanel projectId={project.id} noteId={tab.id.slice(5)} onClose={()=>close(tab)} tabbed onTitle={value=>title(tab.id,value)}/></div>)}
     {selected?.kind==="browser"&&conversationId?<Suspense fallback={<Loading/>}><BrowserPane key={conversationId} conversationId={conversationId} active={presented} tabId={selected.remoteId} onTabs={inventory}/></Suspense>:null}
    </div>
   </section>
  </div>
 </Assets.Provider>;
}
