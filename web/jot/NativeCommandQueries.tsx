import React,{useEffect,useMemo,useRef,useState} from 'react';
import {useResource} from '../workbench/useResource';
import {isNativeCommandQuery,validateNativeCommandQuery} from '../../packages/skills/command-query.js';
import type {CommandManifest} from '../../packages/skills/catalog-contract.js';
import type {NativeCommandQueryOperation} from '../../packages/gateway/contracts/types';
import {NativeCommandQueryStore,listNativeCommandQueries,readNativeCommandQuery,submitNativeCommandQuery,closeNativeCommandQuery,reconcileNativeCommandQuery,type PendingNativeQuery} from './native-command-query-client';

const labels={prepared:'待派发',dispatched:'已派发，等待结果',settled:'结果已保存',rejected:'未派发，已结束',unknown:'结果待核对'};
function message(error:unknown){
 const code=error instanceof Error?error.message:'';
 if(code==='NATIVE_QUERY_SCOPE_CHANGED')return '用户或运行范围已变化，请重新打开目录。';
 if(code==='NATIVE_QUERY_RECOVERY_PENDING')return '请先核对当前保留的原请求。';
 if(code==='NATIVE_QUERY_RECOVERY_UNAVAILABLE'||code==='NATIVE_QUERY_RECOVERY_INVALID')return '浏览器恢复记录暂不可用。可从最近操作读取原状态。';
 if(code==='NATIVE_COMMAND_QUERY_NOT_FOUND')return '暂未找到原操作。可核对并结束尚未派发的原请求。';
 if(code==='NATIVE_COMMAND_QUERY_CONFLICT')return '原请求内容或权限范围已变化，请读取原操作状态。';
 if(code==='NATIVE_COMMAND_QUERY_AUDIT_UNPAIRED')return '尚未保存可核对的原生审计配对，原请求继续保留。';
 if(code==='NATIVE_COMMAND_QUERY_AUDIT_CONFLICT')return '原生审计与原请求的已存证据冲突，原状态继续保留。';
 if(code==='NATIVE_COMMAND_QUERY_AUDIT_UNAVAILABLE')return '原生日志暂不可读取，稍后可按原请求继续核对。';
 return '原操作暂未确认，请保留请求 ID 并重新读取状态。';
}
export default function NativeCommandQueries({runId,ownerScope,commands,catalogSha256}:{runId:string;ownerScope:string;commands:CommandManifest[];catalogSha256:string}){
 const store=useMemo(()=>new NativeCommandQueryStore(ownerScope,runId),[ownerScope,runId]);
 const [pending,setPending]=useState<PendingNativeQuery|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [selected,setSelected]=useState<NativeCommandQueryOperation|null>(null),active=useRef<AbortController|null>(null);
 const resource=useResource(signal=>listNativeCommandQueries(runId,ownerScope,signal),ownerScope+':'+runId);
 const reload=()=>{
  setError('');
  try{setPending(store.read());setReady(true);}catch(cause){setReady(false);setError(message(cause));}
  resource.reload();
 };
 useEffect(()=>{
  try{setPending(store.read());setReady(true);}catch(cause){setError(message(cause));setReady(false);}
  return()=>active.current?.abort();
 },[store]);
 const run=async(action:(signal:AbortSignal)=>Promise<NativeCommandQueryOperation>)=>{
  if(active.current)return;
  const controller=new AbortController();active.current=controller;setBusy(true);setError('');setSelected(null);
  try{
   const operation=await action(controller.signal);controller.signal.throwIfAborted();
   const original=store.read();
   if(original?.request_id===operation.request_id&&original.name!==operation.name)throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
   setSelected(operation);
   if(operation.state==='settled'||operation.state==='rejected')store.complete(operation.request_id);
   else if(!store.read())store.save({request_id:operation.request_id,name:operation.name});
   setPending(store.read());
  }catch(cause){if(!controller.signal.aborted)setError(message(cause));}
  finally{if(active.current===controller){active.current=null;if(!controller.signal.aborted){setBusy(false);resource.reload();}}}
 };
 const submit=(command:CommandManifest)=>void run(async signal=>{
  const query=validateNativeCommandQuery({request_id:crypto.randomUUID(),name:command.name,definition_id:command.definitionId,expected_catalog_sha256:catalogSha256});
  const original={request_id:query.request_id,name:query.name};
  store.save(original);setPending(original);
  return submitNativeCommandQuery(runId,ownerScope,query,signal);
 });
 const recover=(requestId:string)=>void run(signal=>readNativeCommandQuery(runId,ownerScope,requestId,signal));
 const unresolved=resource.data?.some(operation=>!['settled','rejected'].includes(operation.state));
 const available=commands.filter(command=>isNativeCommandQuery({name:command.name,definition_id:command.definitionId}));
 return <section aria-label="原生命令状态查询"><h4>命令状态与原操作</h4>
  <p>查询沿原生会话保存操作日志。待确认的请求可按原 ID 继续核对。</p>
  {available.map(command=><button type="button" key={command.name} disabled={!ready||busy||!!pending||resource.loading||!!resource.error||!!unresolved}
   onClick={()=>submit(command)}>查询 /{command.name} 状态</button>)}
  <button type="button" disabled={busy} onClick={reload}>读取恢复记录</button>
  {pending&&<div role="status"><p>保留的原请求 <code>{pending.request_id}</code></p>
   <button type="button" disabled={busy} onClick={()=>recover(pending.request_id)}>读取原请求状态</button>
   <button type="button" disabled={busy} onClick={()=>void run(signal=>reconcileNativeCommandQuery(runId,ownerScope,pending.request_id,signal))}>核对原生日志</button>
   <button type="button" disabled={busy} onClick={()=>void run(signal=>closeNativeCommandQuery(runId,ownerScope,pending,signal))}>核对并结束未派发请求</button>
  </div>}
  {busy&&<p role="status">正在处理原请求…</p>}
  {error&&<p role="alert">{error}</p>}
  {resource.loading&&<p role="status">正在读取最近操作…</p>}
  {resource.error&&<p role="alert">最近操作暂不可用，请重新读取恢复记录。</p>}
  {selected&&<div aria-label="原命令查询结果"><p><code>{selected.request_id}</code> · {labels[selected.state]}</p>
   {selected.result&&<><p>原生命令 ID <code>{selected.result.commandId}</code> · {selected.result.result.kind==='success'?'查询成功':'原生命令返回错误'}</p>
    {selected.result.result.text!==undefined&&<pre>{selected.result.result.text}</pre>}</>}
   {selected.state==='dispatched'||selected.state==='unknown'?<p>请求已进入派发记录，继续读取原状态等待结果核对。</p>:null}
  </div>}
  {!!resource.data?.length&&<ul aria-label="最近命令查询">{resource.data.map(operation=><li key={operation.request_id}>
   <code>{operation.request_id}</code> · /{operation.name} · {labels[operation.state]} · <time dateTime={operation.updated_at}>{operation.updated_at}</time>
   <button type="button" disabled={busy} onClick={()=>recover(operation.request_id)}>读取此原操作</button>
   {['dispatched','unknown'].includes(operation.state)&&<button type="button" disabled={busy} onClick={()=>void run(signal=>reconcileNativeCommandQuery(runId,ownerScope,operation.request_id,signal))}>核对此原生结果</button>}
  </li>)}</ul>}
 </section>;
}
