import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { api, send } from "../api";
import { Icon } from "../components/controls";
type Recognition = {lang:string;continuous:boolean;interimResults:boolean;onresult:((event:any)=>void)|null;onerror:((event:any)=>void)|null;onend:(()=>void)|null;start():void;stop():void;abort():void};
export function DictationButton({onTranscript,disabled=false}:{onTranscript:(text:string)=>void;disabled?:boolean}) {
  const recognition=useRef<Recognition|null>(null),active=useRef(true),callback=useRef(onTranscript),final=useRef(""),language=useRef("");
  callback.current=onTranscript;
  const [state,setState]=useState(""),[recording,setRecording]=useState(false),[starting,setStarting]=useState(false);
  const Constructor=(window as unknown as {SpeechRecognition?:new()=>Recognition;webkitSpeechRecognition?:new()=>Recognition}).SpeechRecognition??(window as unknown as {webkitSpeechRecognition?:new()=>Recognition}).webkitSpeechRecognition;
  useEffect(()=>{active.current=true;return()=>{active.current=false;const current=recognition.current;recognition.current=null;if(current){current.onend=null;current.onresult=null;current.abort();}};},[]);
  useEffect(()=>{if(disabled)recognition.current?.stop();},[disabled]);
  async function start() {
    if(recording){recognition.current?.stop();return;}
    if(!Constructor||starting||disabled)return;
    setStarting(true);setState("");
    try{
      const preferences=await api<{dictationLanguage:string}>("/enterprise/api/me/preferences");
      if(!active.current)return;
      const current=new Constructor();recognition.current=current;final.current="";language.current=preferences.dictationLanguage;
      current.lang=preferences.dictationLanguage||navigator.language;current.continuous=true;current.interimResults=true;
      current.onresult=event=>{let interim="";for(let index=event.resultIndex;index<event.results.length;index++){const result=event.results[index];if(result.isFinal)final.current+=(final.current?" ":"")+String(result[0]?.transcript??"");else interim+=String(result[0]?.transcript??"");}if(active.current)setState(interim?"Listening: "+interim:"Listening…");};
      current.onerror=event=>{if(active.current)setState(event.error==="not-allowed"?"Microphone permission was denied. Change your browser permission to dictate.":"Dictation stopped: "+String(event.error??"speech service unavailable"));};
      current.onend=()=>{recognition.current=null;if(!active.current)return;setRecording(false);const text=final.current.trim();final.current="";if(text){callback.current(text);setState("Dictation inserted as a draft. Saving history…");void send("/enterprise/api/me/dictations",{text,language:language.current}).then(()=>{if(active.current)setState("Dictation saved. Review your draft before sending.");}).catch(()=>{if(active.current)setState("Draft inserted, but dictation history could not be saved.");});}};
      current.start();setRecording(true);setState("Listening…");
    }catch(error){if(active.current)setState(error instanceof Error?error.message:"Dictation is unavailable.");}
    finally{if(active.current)setStarting(false);}
  }
  return <span className="dictation-control"><button type="button" className="composer-microphone" aria-label={recording?"Stop dictation":"Start dictation"} aria-pressed={recording} title={!Constructor?"Speech recognition is unavailable in this browser.":recording?"Stop dictation":"Dictate a draft using your browser's speech service"} disabled={!Constructor||disabled||starting} onClick={()=>void start()}><Icon icon={recording?Square:Mic} size={16} weight="control"/></button>{state?<span className="dictation-status" role="status">{state}</span>:null}</span>;
}
