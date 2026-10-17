import React,{useEffect,useRef,useState} from 'react';
import {request,taskDraftScope,transcribeVoice} from './client';
import {VoiceDraftController} from './voice-draft-controller.mjs';
import {recordVoice} from './voice-recorder.mjs';
import type {Capabilities} from './types';

type Props={id:string;voice?:Capabilities['voice'];disabled:boolean;onText:(text:string)=>void;onBusyChange:(busy:boolean)=>void};
const statusText:Record<string,string>={requesting:'正在请求麦克风权限…',recording:'正在录音，停止后将文字加入草稿。',transcribing:'正在转写语音…'};
export default function VoiceInput({id,voice,disabled,onText,onBusyChange}:Props){
 const [state,setState]=useState({status:'idle',error:''});
 const controller=useRef<VoiceDraftController|null>(null),callbacks=useRef({onText,onBusyChange});
 callbacks.current={onText,onBusyChange};
 useEffect(()=>{
  let mounted=true;
  const current=new VoiceDraftController(id,{
   record:recordVoice,transcribe:transcribeVoice,readScope:taskDraftScope,
   verifyScope:async(scope:string,signal:AbortSignal)=>{
    const latest=await request<Capabilities>('/capabilities','GET',undefined,undefined,signal);
    if(!latest.voice?.enabled||latest.voice.status!=='ready')throw new Error('VOICE_UNAVAILABLE：语音服务暂不可用，请稍后重试');
    return taskDraftScope()===scope;
   },
   onText:(text:string)=>callbacks.current.onText(text),
   onChange:()=>{if(mounted){setState({status:current.status,error:current.error});callbacks.current.onBusyChange(current.status!=='idle');}},
  });
  controller.current=current;
  return()=>{mounted=false;current.dispose();if(controller.current===current)controller.current=null;callbacks.current.onBusyChange(false);};
 },[id]);
 const ready=voice?.enabled&&voice.status==='ready',busy=state.status!=='idle';
 const unavailable=!voice?'正在读取语音能力…':voice.status==='preparing'?'语音服务正在准备…':voice.status==='unavailable'?'语音服务暂不可用':!ready?'语音输入未启用':'';
 return <div className="jot-voice-input" role="group" aria-label="语音输入" aria-busy={busy}>
  {!busy&&<button type="button" disabled={disabled||!ready} onClick={()=>void controller.current?.start({maxDurationMs:voice?.max_duration_ms,maxBytes:voice?.max_bytes})}>开始录音</button>}
  {state.status==='recording'&&<button type="button" onClick={()=>void controller.current?.stop()}>停止并转写</button>}
  {busy&&<button type="button" onClick={()=>controller.current?.cancel()}>取消语音</button>}
  <span role="status" aria-live="polite">{busy?statusText[state.status]:unavailable||'语音转写只加入草稿，由你确认发送。'}</span>
  {state.error&&<p role="alert">{state.error}</p>}
 </div>;
}
