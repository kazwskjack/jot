import type {Snapshot,AgentEvent} from './types';
export const base='/workbench-api';
export class ApiError extends Error{constructor(public status:number,message:string,public data?:unknown){super(message)}}
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
 if(!r.ok){const data=await r.json().catch(()=>({}));throw new ApiError(r.status,data.error?.message??data.error?.code??`连接失败 (${r.status})`,data)}
 if(r.status===204)return undefined as T;
 const text=await r.text();return text?JSON.parse(text):undefined as T;
 }finally{timed.dispose()}
}
export async function requestBytes(path:string,signal?:AbortSignal):Promise<Uint8Array>{
 const timed=deadline(signal,120000);
 try{
  const r=await fetch(base+'/v1'+path,{method:'GET',headers:{Accept:'application/octet-stream'},credentials:'same-origin',cache:'no-store',signal:timed.signal});
  if(!r.ok){const data=await r.json().catch(()=>({}));throw new ApiError(r.status,data.error?.message??data.error?.code??`连接失败 (${r.status})`)}
  return new Uint8Array(await r.arrayBuffer());
 }finally{timed.dispose()}
}

export async function hostBootstrapRequest(action:'challenge'|'redeem',body:Record<string,string>|undefined,signal?:AbortSignal):Promise<unknown>{
 const timed=deadline(signal,30000);
 try{
  const response=await fetch(`/api/host/bootstrap/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-jot-token':csrfToken},credentials:'same-origin',cache:'no-store',redirect:'error',signal:timed.signal,body:JSON.stringify(body??{})});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw new ApiError(response.status,data.error?.code??`Host 授权失败 (${response.status})`);}
  return await response.json();
 }finally{timed.dispose();}
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

export type NativeMember = {child_session_ref:string;name:string;role:'teammate';status:string};
export type NativeMemberRoster = {members:NativeMember[];execution_authorized:false};
export type NativeMemberInterruptReceipt = {request_id:string;status:'accepted'|'unknown';quiescent:false;execution_authorized:false};
export type NativeMemberWakeReceipt = {request_id:string;status:'pending'|'unknown'|'accepted'|'superseded'};
export type NativeMemberWakeAcceptance = {accepted:true;command_id:string;run_id:string;request_id:string};
export type NativeMemberPendingAction = {run_id:string;child_session_ref:string;request_id:string;operation:'interrupt'|'wake';state:'submitting'|'pending'|'unknown'};
const NATIVE_MEMBER_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const NATIVE_MEMBER_ACTION_STORAGE_KEY='jot.native-member-actions.v1';
const NATIVE_MEMBER_ACTION_LOCK='jot.native-member-actions';
const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:Record<string,unknown>)=>Object.keys(value).sort().join(',');
function validMemberId(value:unknown):value is string{return typeof value==='string'&&NATIVE_MEMBER_ID.test(value);}
function assertMemberRequest(runId:string,childSessionRef?:string,version?:number,requestId?:string){
 if(!validMemberId(runId)||childSessionRef!==undefined&&!validMemberId(childSessionRef)||requestId!==undefined&&!validMemberId(requestId)||version!==undefined&&(!Number.isSafeInteger(version)||version<1))throw new Error('native_member_control_invalid');
}
function parseNativeMemberRoster(value:unknown):NativeMemberRoster{
 if(!isRecord(value)||keys(value)!=='execution_authorized,members'||value.execution_authorized!==false||!Array.isArray(value.members))throw new Error('native_member_roster_invalid');
 const seen=new Set<string>();
 for(const member of value.members){
  if(!isRecord(member)||keys(member)!=='child_session_ref,name,role,status'||!validMemberId(member.child_session_ref)||typeof member.name!=='string'||!member.name.trim()||member.name.length>80||member.role!=='teammate'||typeof member.status!=='string'||!member.status||member.status.length>64||seen.has(member.child_session_ref))throw new Error('native_member_roster_invalid');
  seen.add(member.child_session_ref);
 }
 return value as NativeMemberRoster;
}
export function isNativeMemberObservedStopped(roster:NativeMemberRoster,childSessionRef:string):boolean{
 return roster.members.some(member=>member.child_session_ref===childSessionRef&&member.status==='inactive');
}
export async function listNativeMembers(runId:string,signal?:AbortSignal):Promise<NativeMemberRoster>{
 assertMemberRequest(runId);
 const value=await request<unknown>(`/runs/${encodeURIComponent(runId)}/native-members`,'GET',undefined,undefined,signal);
 return parseNativeMemberRoster(value);
}
export async function interruptNativeMember(runId:string,childSessionRef:string,expectedRunVersion:number,requestId:string,signal?:AbortSignal):Promise<NativeMemberInterruptReceipt>{
 assertMemberRequest(runId,childSessionRef,expectedRunVersion,requestId);
 const value=await request<unknown>(`/runs/${encodeURIComponent(runId)}/native-members/${encodeURIComponent(childSessionRef)}/interrupt`,'POST',{request_id:requestId,expected_run_version:expectedRunVersion},requestId,signal);
 if(!isRecord(value)||keys(value)!=='execution_authorized,quiescent,request_id,status'||value.execution_authorized!==false||value.quiescent!==false||value.request_id!==requestId||!['accepted','unknown'].includes(String(value.status)))throw new Error('native_member_interrupt_receipt_invalid');
 return value as NativeMemberInterruptReceipt;
}
export async function readNativeMemberInterruptReceipt(runId:string,childSessionRef:string,requestId:string,signal?:AbortSignal):Promise<NativeMemberInterruptReceipt>{
 assertMemberRequest(runId,childSessionRef,undefined,requestId);
 const value=await request<unknown>(`/runs/${encodeURIComponent(runId)}/native-members/${encodeURIComponent(childSessionRef)}/interrupts/${encodeURIComponent(requestId)}`,'GET',undefined,undefined,signal);
 if(!isRecord(value)||keys(value)!=='execution_authorized,quiescent,request_id,status'||value.execution_authorized!==false||value.quiescent!==false
  ||value.request_id!==requestId||!['accepted','unknown'].includes(String(value.status)))throw new Error('native_member_interrupt_receipt_invalid');
 return value as NativeMemberInterruptReceipt;
}
export async function continueNativeMember(runId:string,childSessionRef:string,expectedRunVersion:number,requestId:string,text:string,signal?:AbortSignal):Promise<NativeMemberWakeAcceptance>{
 assertMemberRequest(runId,childSessionRef,expectedRunVersion,requestId);
 if(typeof text!=='string'||!text.trim()||new TextEncoder().encode(text).byteLength>32768)throw new Error('native_member_control_invalid');
 const value=await request<unknown>(`/runs/${encodeURIComponent(runId)}/native-members/${encodeURIComponent(childSessionRef)}/messages`,'POST',{request_id:requestId,expected_run_version:expectedRunVersion,text},requestId,signal);
 if(!isRecord(value)||keys(value)!=='accepted,command_id,request_id,run_id'||value.accepted!==true||typeof value.command_id!=='string'||!value.command_id||value.run_id!==runId||value.request_id!==requestId)throw new Error('native_member_control_unconfirmed');
 return value as NativeMemberWakeAcceptance;
}
export async function readNativeMemberWakeReceipt(runId:string,childSessionRef:string,requestId:string,signal?:AbortSignal):Promise<NativeMemberWakeReceipt>{
 assertMemberRequest(runId,childSessionRef,undefined,requestId);
 const value=await request<unknown>(`/runs/${encodeURIComponent(runId)}/native-members/${encodeURIComponent(childSessionRef)}/messages/${encodeURIComponent(requestId)}`,'GET',undefined,undefined,signal);
 if(!isRecord(value)||keys(value)!=='request_id,status'||value.request_id!==requestId||!['pending','unknown','accepted','superseded'].includes(String(value.status)))throw new Error('native_member_control_invalid');
 return value as NativeMemberWakeReceipt;
}
function nativeMemberActionStorage():Storage{
 try{const storage=globalThis.localStorage;if(!storage)throw new Error();return storage;}
 catch{throw new Error('native_member_action_storage_unavailable');}
}
function readNativeMemberActionJournal(storage:Storage):Record<string,Record<string,NativeMemberPendingAction>>{
 let raw:string|null;
 try{raw=storage.getItem(NATIVE_MEMBER_ACTION_STORAGE_KEY);}catch{throw new Error('native_member_action_storage_unavailable');}
 if(raw===null)return {};
 let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error('native_member_action_storage_invalid');}
 if(!isRecord(value)||keys(value)!=='actions,version'||value.version!==1&&value.version!==2||!isRecord(value.actions))throw new Error('native_member_action_storage_invalid');
 const actions:Record<string,Record<string,NativeMemberPendingAction>>={};
 const parseAction=(runId:string,childRef:string,item:unknown):NativeMemberPendingAction=>{
  if(!validMemberId(runId)||!validMemberId(childRef)||!isRecord(item)||keys(item)!=='child_session_ref,operation,request_id,run_id,state'||item.run_id!==runId||item.child_session_ref!==childRef
   ||!validMemberId(item.request_id)||!['interrupt','wake'].includes(String(item.operation))||!['submitting','pending','unknown'].includes(String(item.state)))throw new Error('native_member_action_storage_invalid');
  return item as NativeMemberPendingAction;
 };
 for(const [runId,valueForRun] of Object.entries(value.actions)){
  if(!validMemberId(runId)||!isRecord(valueForRun))throw new Error('native_member_action_storage_invalid');
  if(value.version===1){
   const action=parseAction(runId,(valueForRun as Record<string,unknown>).child_session_ref as string,valueForRun);
   actions[runId]={[action.child_session_ref]:action};continue;
  }
  const perChild:Record<string,NativeMemberPendingAction>={};
  for(const [childRef,item] of Object.entries(valueForRun))perChild[childRef]=parseAction(runId,childRef,item);
  if(Object.keys(perChild).length)actions[runId]=perChild;
 }
 return actions;
}
export function readNativeMemberPendingActions(runId:string):NativeMemberPendingAction[]{
 assertMemberRequest(runId);return Object.values(readNativeMemberActionJournal(nativeMemberActionStorage())[runId]??{});
}
type NativeMemberActionLocks={request<T>(name:string,options:{mode:'exclusive'},callback:()=>T|Promise<T>):Promise<T>};
function withNativeMemberActionLock<T>(callback:()=>T|Promise<T>):Promise<T>{
 const locks=(globalThis.navigator as (Navigator&{locks?:NativeMemberActionLocks})|undefined)?.locks;
 if(!locks)throw new Error('native_member_action_lock_unavailable');
 return locks.request<T>(NATIVE_MEMBER_ACTION_LOCK,{mode:'exclusive'},callback);
}
function storeNativeMemberPendingAction(action:NativeMemberPendingAction):void{
 if(!action||!validMemberId(action.run_id)||!validMemberId(action.child_session_ref)||!validMemberId(action.request_id)
  ||!['interrupt','wake'].includes(action.operation)||!['submitting','pending','unknown'].includes(action.state)
 )throw new Error('native_member_action_storage_invalid');
 const storage=nativeMemberActionStorage(),actions=readNativeMemberActionJournal(storage),perChild=actions[action.run_id]??{},prior=perChild[action.child_session_ref];
 if(prior&&(prior.request_id!==action.request_id||prior.operation!==action.operation))throw new Error('native_member_action_pending');
 perChild[action.child_session_ref]={...action};actions[action.run_id]=perChild;
 try{storage.setItem(NATIVE_MEMBER_ACTION_STORAGE_KEY,JSON.stringify({version:2,actions}));}catch{throw new Error('native_member_action_storage_unavailable');}
}
export function writeNativeMemberPendingAction(action:NativeMemberPendingAction):Promise<void>{
 return withNativeMemberActionLock(()=>storeNativeMemberPendingAction(action));
}
export async function dispatchNativeMemberAction<T>(action:NativeMemberPendingAction,dispatch:()=>Promise<T>):Promise<T>{
 await withNativeMemberActionLock(()=>storeNativeMemberPendingAction(action));
 return dispatch();
}
export function clearNativeMemberPendingAction(runId:string,childSessionRef:string,requestId:string):Promise<void>{
 assertMemberRequest(runId,childSessionRef,undefined,requestId);
 return withNativeMemberActionLock(()=>{
  const storage=nativeMemberActionStorage(),actions=readNativeMemberActionJournal(storage),perChild=actions[runId];
  if(!perChild||perChild[childSessionRef]?.request_id!==requestId)return;
  delete perChild[childSessionRef];if(!Object.keys(perChild).length)delete actions[runId];
  try{if(Object.keys(actions).length)storage.setItem(NATIVE_MEMBER_ACTION_STORAGE_KEY,JSON.stringify({version:2,actions}));else storage.removeItem(NATIVE_MEMBER_ACTION_STORAGE_KEY);}
  catch{throw new Error('native_member_action_storage_unavailable');}
 });
}
