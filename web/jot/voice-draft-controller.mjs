export function appendVoiceText(draft,text){
 if(typeof text!=='string'||!text.trim())throw Error('VOICE_TEXT_EMPTY');
 const result=draft?`${draft}\n${text.trim()}`:text.trim();
 if(result.length>8000)throw Error('VOICE_DRAFT_TOO_LONG：识别文字超出消息上限，请缩短草稿后重新录音');
 return result;
}

// This controller owns only an ephemeral recording and its draft result, never message delivery.
export class VoiceDraftController{
 constructor(conversationId,{record,transcribe,readScope,verifyScope,onText,onChange=()=>{}}){
  Object.assign(this,{conversationId,record,transcribe,readScope,verifyScope,onText,onChange});
  this.status='idle';this.error='';this.operation=null;this.disposed=false;
 }
 changed(){if(!this.disposed)this.onChange();}
 active(operation){return !this.disposed&&this.operation===operation&&!operation.abort.signal.aborted;}
 assertScope(operation){if(!this.active(operation))throw new DOMException('Aborted','AbortError');if(this.readScope()!==operation.scope)throw Error('VOICE_SCOPE_CHANGED：用户范围已变化，请重新打开对话');}
 async start(limits){
  if(this.disposed||this.operation)return;
  const scope=this.readScope();if(!/^[a-f0-9]{64}$/.test(scope??'')){this.error='VOICE_SCOPE_UNAVAILABLE';this.changed();return;}
  const operation={scope,abort:new AbortController(),recorder:null};this.operation=operation;this.status='requesting';this.error='';this.changed();
  try{
   const recorder=await this.record({...limits,signal:operation.abort.signal,onLimit:()=>{void this.stop();}});
   if(!this.active(operation)){recorder.cancel();return;}
   operation.recorder=recorder;this.assertScope(operation);this.status='recording';this.changed();
  }catch(error){if(this.active(operation)){operation.recorder?.cancel();operation.abort.abort();this.operation=null;this.status='idle';this.error=error instanceof Error?error.message:'VOICE_RECORDING_FAILED';this.changed();}}
 }
 async stop(){
  const operation=this.operation;if(!operation||this.status!=='recording')return;
  this.status='transcribing';this.changed();
  try{
   this.assertScope(operation);const audio=operation.recorder.finish();
   const valid=await this.verifyScope(operation.scope,operation.abort.signal);this.assertScope(operation);if(!valid)throw Error('VOICE_SCOPE_CHANGED：用户范围已变化，请重新打开对话');
   const text=await this.transcribe(this.conversationId,audio,operation.abort.signal);
   if(!this.active(operation))return;
   const stillValid=await this.verifyScope(operation.scope,operation.abort.signal);this.assertScope(operation);if(!stillValid)throw Error('VOICE_SCOPE_CHANGED：用户范围已变化，请重新打开对话');
   this.onText(text);
  }catch(error){if(this.active(operation))this.error=error instanceof Error?error.message:'VOICE_TRANSCRIPTION_FAILED';}
  finally{operation.recorder?.cancel();if(this.operation===operation){this.operation=null;this.status='idle';this.changed();}}
 }
 cancel(){const operation=this.operation;this.operation=null;operation?.abort.abort();operation?.recorder?.cancel();this.status='idle';this.error='';this.changed();}
 dispose(){this.cancel();this.disposed=true;this.onChange=()=>{};}
}
