import type {Snapshot,AgentEvent} from './types';
export const base='/workbench-api';
export class ApiError extends Error{constructor(public status:number,message:string){super(message)}}
let csrfToken='',draftScope='';
export const taskDraftScope=()=>draftScope;
function deadline(parent:AbortSignal|undefined,ms:number){
 const controller=new AbortController(),abort=()=>controller.abort();
 if(parent?.aborted)abort();else parent?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(abort,ms);
 return {signal:controller.signal,dispose:()=>{clearTimeout(timer);parent?.removeEventListener('abort',abort)}};
}
export async function request<T>(path:string,method='GET',body?:unknown,key?:string,signal?:AbortSignal):Promise<T>{
 const headers:Record<string,string>={};
 if(method!=='GET'){headers['Idempotency-Key']=key??crypto.randomUUID();headers['X-jot-Actor']='web';headers['X-CSRF-Token']=csrfToken;headers['Content-Type']=body instanceof File?'application/octet-stream':'application/json';}
 const timed=deadline(signal,body instanceof File?120000:30000);
 try{
 const r=await fetch(base+'/v1'+path,{method,headers,credentials:'same-origin',cache:'no-store',signal:timed.signal,body:body===undefined?undefined:body instanceof File?body:JSON.stringify(body)});
 if(path==='/capabilities'){const scope=r.headers.get('x-workbench-draft-scope')??'';draftScope=r.ok&&/^[a-f0-9]{64}$/.test(scope)?scope:'';if(r.ok)csrfToken=r.headers.get('x-csrf-token')??'';}
 if(!r.ok){const data=await r.json().catch(()=>({}));throw new ApiError(r.status,data.error?.message??data.error?.code??`连接失败 (${r.status})`)}
 if(r.status===204)return undefined as T;
 const text=await r.text();return text?JSON.parse(text):undefined as T;
 }finally{timed.dispose()}
}

function abortableDelay(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{if(signal.aborted){reject(new DOMException('Aborted','AbortError'));return;}const timer=setTimeout(done,ms);function done(){signal.removeEventListener('abort',aborted);resolve()}function aborted(){clearTimeout(timer);signal.removeEventListener('abort',aborted);reject(new DOMException('Aborted','AbortError'))}signal.addEventListener('abort',aborted,{once:true})})}
export async function transcribeVoice(conversationId:string,audio:Uint8Array,signal:AbortSignal):Promise<string>{
 const clientRequestId=crypto.randomUUID(),form=new FormData();form.append('client_request_id',clientRequestId);form.append('audio',new Blob([new Uint8Array(audio)],{type:'audio/wav'}),'recording.wav');
 const scope=draftScope,csrf=csrfToken,timed=deadline(signal,120000);
 const current=()=>{if(timed.signal.aborted)throw new DOMException('Aborted','AbortError');if(draftScope!==scope)throw new Error('VOICE_SCOPE_CHANGED');};
 let transcriptionId='',succeeded=false;
 try{
  current();
  const accepted=await fetch(`${base}/v1/conversations/${encodeURIComponent(conversationId)}/voice/transcriptions`,{method:'POST',headers:{'X-jot-Actor':'web','X-CSRF-Token':csrf},credentials:'same-origin',cache:'no-store',signal:timed.signal,body:form});
  if(!accepted.ok){const data=await accepted.json().catch(()=>({}));throw new ApiError(accepted.status,data.error?.code??`语音请求失败 (${accepted.status})`)}
  const receipt=await accepted.json();transcriptionId=typeof receipt.transcription_id==='string'?receipt.transcription_id:'';if(!transcriptionId)throw new Error('语音服务未返回任务编号');
  current();
  while(true){
   const response=await fetch(`${base}/v1/conversations/${encodeURIComponent(conversationId)}/voice/transcriptions/${encodeURIComponent(transcriptionId)}`,{headers:{'X-jot-Actor':'web'},credentials:'same-origin',cache:'no-store',signal:timed.signal});
   if(!response.ok){const data=await response.json().catch(()=>({}));throw new ApiError(response.status,data.error?.code??`查询语音状态失败 (${response.status})`)}
   const state=await response.json();current();
   if(state.status==='succeeded'){if(typeof state.text!=='string')throw new Error('VOICE_TRANSCRIPTION_INVALID');succeeded=true;return state.text;}
   if(state.status==='failed')throw new Error(`VOICE_TRANSCRIPTION_FAILED: ${String(state.error_code??'unknown')}`);
   if(state.status==='cancelled')throw new Error('语音识别已取消');
   if(!['queued','transcribing'].includes(state.status))throw new Error('VOICE_TRANSCRIPTION_INVALID');
   await abortableDelay(400,timed.signal);
  }
 }catch(error){
  if(transcriptionId&&!succeeded&&timed.signal.aborted&&draftScope===scope){
   await fetch(`${base}/v1/conversations/${encodeURIComponent(conversationId)}/voice/transcriptions/${encodeURIComponent(transcriptionId)}`,{method:'DELETE',headers:{'X-jot-Actor':'web','X-CSRF-Token':csrf},credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(30000)}).catch(()=>{});
  }
  if(timed.signal.aborted&&!signal.aborted)throw new Error('VOICE_TRANSCRIPTION_TIMEOUT');
  throw error;
 }finally{timed.dispose();}
}
// Fetch SSE supports custom headers and AbortController; native EventSource does not.
export async function follow(id:string,after:string,onEvent:(e:AgentEvent)=>void,signal:AbortSignal){
 const idle=new AbortController();let timer:ReturnType<typeof setTimeout>;
 const abort=()=>idle.abort();if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
 const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>idle.abort(),45000)};touch();
 try{
 const r=await fetch(`${base}/v1/conversations/${encodeURIComponent(id)}/events`,{headers:{'Last-Event-ID':after,Accept:'text/event-stream'},credentials:'same-origin',cache:'no-store',signal:idle.signal});
 if(!r.ok||!r.body)throw new ApiError(r.status,'事件连接失败');
 const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
 try{while(true){const part=await reader.read();if(part.done)throw new Error('连接已中断');touch();buffer+=decoder.decode(part.value,{stream:true}).replace(/\r/g,'');
  if(buffer.length>2_000_000)throw new Error('事件过大');
  let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
   if(frame.includes('event: stream.reset'))throw new ApiError(410,'需要重新同步');
   const data=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
   if(!data)continue;const e=JSON.parse(data);
   if(e.schema_version!=='1.0'||!/^\d+$/.test(e.seq)||typeof e.type!=='string'||!e.payload)throw new Error('事件格式不兼容');
   onEvent(e);
  }
 }}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
 }finally{clearTimeout(timer!);signal.removeEventListener('abort',abort)}
}
export const snapshot=(id:string,signal?:AbortSignal)=>request<Snapshot>(`/conversations/${encodeURIComponent(id)}/snapshot`,'GET',undefined,undefined,signal);
