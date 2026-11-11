import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import React,{useEffect,useRef,useState} from 'react';
import {request,taskDraftScope,transcribeVoice} from './client';
import {VoiceDraftController} from './voice-draft-controller.mjs';
import {recordVoice} from './voice-recorder.mjs';
import type {Capabilities} from './types';

type Props={id:string;voice?:Capabilities['voice'];disabled:boolean;onText:(text:string)=>void;onBusyChange:(busy:boolean)=>void};
export default function VoiceInput({id,voice,disabled,onText,onBusyChange}:Props){
 const language=useApplicationLanguage(),t=useApplicationText();
 const statusText:Record<string,string>={requesting:t('正在请求麦克风权限…','Requesting microphone permission…'),recording:t('正在录音，停止后将文字加入草稿。','Recording. Stopping adds the transcript to your draft.'),transcribing:t('正在转写语音…','Transcribing audio…')};
 const [state,setState]=useState({status:'idle',error:''});
 const [meter,setMeter]=useState({level:0,elapsedMs:0});
 const controller=useRef<VoiceDraftController|null>(null),callbacks=useRef({onText,onBusyChange});
 callbacks.current={onText,onBusyChange};
 useEffect(()=>{
  let mounted=true;
  const current=new VoiceDraftController(id,{
   record:(options:Parameters<typeof recordVoice>[0])=>recordVoice({...options,onLevel:(frame:{level:number;elapsedMs:number})=>{if(mounted)setMeter(frame);}}),transcribe:transcribeVoice,readScope:taskDraftScope,
   verifyScope:async(scope:string,signal:AbortSignal)=>{
    const latest=await request<Capabilities>('/capabilities','GET',undefined,undefined,signal);
    if(!latest.voice?.enabled||latest.voice.status!=='ready')throw new Error('VOICE_UNAVAILABLE：语音服务暂不可用，请稍后重试');
    return taskDraftScope()===scope;
   },
   onText:(text:string)=>callbacks.current.onText(text),
   onChange:()=>{if(mounted){setState({status:current.status,error:current.error});if(current.status==='idle'||current.status==='requesting')setMeter({level:0,elapsedMs:0});callbacks.current.onBusyChange(current.status!=='idle');}},
  });
  controller.current=current;
  return()=>{mounted=false;current.dispose();if(controller.current===current)controller.current=null;callbacks.current.onBusyChange(false);};
 },[id]);
 const ready=voice?.enabled&&voice.status==='ready',busy=state.status!=='idle';
 const unavailable=!voice?t('正在读取语音能力…','Loading voice capabilities…'):voice.status==='preparing'?t('语音服务正在准备…','Voice service is preparing…'):voice.status==='unavailable'?t('语音服务暂不可用','Voice service is unavailable'):!ready?t('语音输入未启用','Voice input is not enabled'):'';
 return <div lang={language} className="jot-voice-input" role="group" aria-label={t("语音输入","Voice Input")} aria-busy={busy}>
  {state.status==='recording'&&<div className="jot-voice-meter" aria-label={t("录音音量和时长","Recording Level and Duration")}>
   <span className="jot-voice-wave" aria-hidden="true">{[.4,.7,1,.6,.9,.5,.8].map((weight,index)=><i key={index} style={{height:`${4+Math.min(1,meter.level*4)*weight*20}px`}}/>)}</span>
   <time aria-label={t("录音时长","Recording Duration")}>{Math.floor(meter.elapsedMs/60000)}:{String(Math.floor(meter.elapsedMs/1000)%60).padStart(2,'0')}</time>
  </div>}
  {!busy&&<button type="button" disabled={disabled||!ready} onClick={()=>void controller.current?.start({maxDurationMs:voice?.max_duration_ms,maxBytes:voice?.max_bytes})}>{t("开始录音","Start Recording")}</button>}
  {state.status==='recording'&&<button type="button" onClick={()=>void controller.current?.stop()}>{t("停止并转写","Stop and Transcribe")}</button>}
  {busy&&<button type="button" onClick={()=>controller.current?.cancel()}>{t("取消语音","Cancel Voice")}</button>}
  <span role="status" aria-live="polite">{busy?statusText[state.status]:unavailable||t('语音转写只加入草稿，由你确认发送。','Voice transcription only adds text to your draft. You choose when to send it.')}</span>
  {state.error&&<p role="alert">{conversationUiError(state.error,language)}</p>}
 </div>;
}
