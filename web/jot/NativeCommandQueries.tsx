import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {useResource} from '../workbench/useResource';
import {isNativeCommandQuery,validateNativeCommandQuery} from '../../packages/skills/command-query.js';
import type {CommandManifest} from '../../packages/skills/catalog-contract.js';
import type {NativeCommandQueryOperation,NativePlanModeOperation,NativeCommandQuerySummary,NativePlanModeSummary} from '../../packages/gateway/contracts/types';
import {NativeCommandQueryStore,createNativeCommandQueryClient} from './native-command-query-client';
import {createNativePlanModeClient} from './native-plan-mode-client';
import {isNativePlanMode,validateNativePlanMode,validateNativePlanIdentity} from '../../packages/skills/plan-mode-command.js';
type OriginalCommandIdentity={request_id:string;name:'permission'|'goal'|'plan'};
type OriginalCommandOperation=NativeCommandQueryOperation|NativePlanModeOperation;
type OriginalCommandSummary=NativeCommandQuerySummary|NativePlanModeSummary;

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
export default function NativeCommandQueries({runId,ownerScope,commands,catalogSha256,planMode=false}:{runId:string;ownerScope:string;commands:CommandManifest[];catalogSha256:string;planMode?:boolean}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const labels={prepared:t('待派发','Awaiting Dispatch'),dispatched:t('已派发，等待结果','Dispatched; Awaiting Result'),settled:t('结果已保存','Result Saved'),rejected:t('未派发，已结束','Closed Before Dispatch'),unknown:t('结果待核对','Result Requires Verification')};
 const api=useMemo(()=>planMode?createNativePlanModeClient(runId,ownerScope):createNativeCommandQueryClient(runId,ownerScope),[runId,ownerScope,planMode]);
 const store=useMemo(()=>new NativeCommandQueryStore<OriginalCommandIdentity>(ownerScope,runId,planMode?{kind:'plan',validate:validateNativePlanIdentity}:undefined),[ownerScope,runId,planMode]);
 const [pending,setPending]=useState<OriginalCommandIdentity|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [selected,setSelected]=useState<OriginalCommandOperation|null>(null),active=useRef<AbortController|null>(null);
 const [history,setHistory]=useState(false),[pageStarts,setPageStarts]=useState<Array<string|undefined>>([undefined]);
 const before=pageStarts.at(-1);
 const resource=useResource<OriginalCommandSummary[]>(signal=>api.list(signal),ownerScope+':'+runId+':'+planMode);
 const historical=useResource<{before:string|undefined;items:OriginalCommandSummary[]}>(async signal=>({before,items:await api.list(signal,{before})}),ownerScope+':'+runId+':'+planMode+':history:'+(before??''),history);
 const historyItems=historical.data?.before===before?historical.data?.items:null;
 const displayed=history?{...historical,data:historyItems}:resource;
 const reload=()=>{
  setError('');
  try{setPending(store.read());setReady(true);}catch(cause){setReady(false);setError(message(cause));}
  resource.reload();
  historical.reload();
 };
 useEffect(()=>{
  try{setPending(store.read());setReady(true);}catch(cause){setError(message(cause));setReady(false);}
  return()=>active.current?.abort();
 },[store]);
 const run=async(action:(signal:AbortSignal)=>Promise<OriginalCommandOperation>)=>{
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
  finally{if(active.current===controller){active.current=null;if(!controller.signal.aborted){setBusy(false);resource.reload();historical.reload();}}}
 };
 const submit=(command:CommandManifest,enabled?:boolean)=>void run(async signal=>{
  const input={request_id:crypto.randomUUID(),name:command.name,definition_id:command.definitionId,expected_catalog_sha256:catalogSha256};
  const query=planMode?validateNativePlanMode({...input,enabled}):validateNativeCommandQuery(input);
  const original={request_id:query.request_id,name:query.name};
  store.save(original);setPending(original);
  return api.submit(query,signal);
 });
 const recover=(requestId:string)=>void run(signal=>api.read(requestId,signal));
 const unresolved=resource.data?.some(operation=>!['settled','rejected'].includes(operation.state));
 const available=commands.filter(command=>(planMode?isNativePlanMode:isNativeCommandQuery)({name:command.name,definition_id:command.definitionId}));
 const blocked=!ready||busy||!!pending||resource.loading||!!resource.error||!!unresolved;
 return <section lang={language} aria-label={planMode?t('原生计划模式','Native Plan Mode'):t('原生命令状态查询','Native Command Status Query')}><h4>{planMode?t('计划模式与原操作','Plan Mode and Original Operations'):t('命令状态与原操作','Command Status and Original Operations')}</h4>
  <p>{planMode?t('计划模式操作沿原生会话保存日志。待确认的请求可按原 ID 继续核对。','Plan mode operations retain logs in the native session. Continue verifying pending requests by their original IDs.'):t('查询沿原生会话保存日志。待确认的请求可按原 ID 继续核对。','Queries retain logs in the native session. Continue verifying pending requests by their original IDs.')}</p>
  {planMode&&<p>{t('进入或退出原生计划模式。运行中的变更可能排队至下一步，回执保留原生命令的处理结果。','Enter or exit native plan mode. Changes during a run may queue until the next step; receipts retain the original native command result.')}</p>}
  {available.map(command=>planMode?<React.Fragment key={command.name}>
   <button type="button" disabled={blocked} onClick={()=>submit(command,true)}>{t("进入计划模式","Enter Plan Mode")}</button>
   <button type="button" disabled={blocked} onClick={()=>submit(command,false)}>{t("退出计划模式","Exit Plan Mode")}</button>
  </React.Fragment>:<button type="button" key={command.name} disabled={blocked}
   onClick={()=>submit(command)}>{t(`查询 /${command.name} 状态`,`Query /${command.name} Status`)}</button>)}
  <button type="button" disabled={busy} onClick={reload}>{t("读取恢复记录","Read Recovery Record")}</button>
  {pending&&<div role="status"><p>{t('保留的原请求','Retained Original Request')} <code>{pending.request_id}</code></p>
   <button type="button" disabled={busy} onClick={()=>recover(pending.request_id)}>{t("读取原请求状态","Read Original Request Status")}</button>
   <button type="button" disabled={busy} onClick={()=>void run(signal=>api.reconcile(pending.request_id,signal))}>{t("核对原生日志","Verify Native Logs")}</button>
   <button type="button" disabled={busy} onClick={()=>void run(signal=>api.close(pending,signal))}>{t("核对并结束未派发请求","Verify and Close Undispatched Request")}</button>
  </div>}
  {busy&&<p role="status">{t("正在处理原请求…","Processing original request…")}</p>}
  {error&&<p role="alert">{conversationUiError(error,language)}</p>}
  <button type="button" disabled={busy} onClick={()=>{setHistory(value=>!value);setPageStarts([undefined]);}}>{history?t("返回最近操作","Return to Recent Operations"):t("按创建顺序浏览全部记录","Browse All Records in Creation Order")}</button>
  {displayed.loading&&<p role="status">{t("正在读取命令记录…","Reading command records…")}</p>}
  {displayed.error&&<p role="alert">{t("命令记录暂不可用，请重新读取恢复记录。","Command records are unavailable. Read the recovery record again.")}</p>}
  {selected&&<div aria-label={t('原命令查询结果','Original Command Query Result')}><p><code>{selected.request_id}</code> · {labels[selected.state]}</p>
   {'enabled' in selected&&<p>{t('原请求意图','Original Request Intent')} {selected.enabled===null?t("派发前已结束","Closed Before Dispatch"):selected.enabled?t("进入计划模式","Enter Plan Mode"):t("退出计划模式","Exit Plan Mode")}</p>}
   {selected.result&&<><p>{t('原生命令 ID','Native Command ID')} <code>{selected.result.commandId}</code> · {selected.result.result.kind==='success'?t("原生命令返回成功","Native Command Returned Success"):t("原生命令返回错误","Native Command Returned Error")}</p>
    {selected.result.result.text!==undefined&&<pre>{selected.result.result.text}</pre>}</>}
   {selected.state==='dispatched'||selected.state==='unknown'?<p>{t("请求已进入派发记录，继续读取原状态等待结果核对。","The request is recorded for dispatch. Continue reading its original status and await result verification.")}</p>:null}
  </div>}
  {!!displayed.data?.length&&<ul aria-label={history?t("历史命令查询","Historical Command Queries"):t("最近命令查询","Recent Command Queries")}>{displayed.data.map(operation=><li key={operation.request_id}>
   <code>{operation.request_id}</code> · /{operation.name} · {labels[operation.state]} · <time dateTime={operation.updated_at}>{operation.updated_at}</time>
   {'enabled' in operation&&<span> · {operation.enabled===null?t("派发前已结束","Closed Before Dispatch"):operation.enabled?t("进入计划模式","Enter Plan Mode"):t("退出计划模式","Exit Plan Mode")}</span>}
   <button type="button" disabled={busy} onClick={()=>recover(operation.request_id)}>{t("读取此原操作","Read This Original Operation")}</button>
   {['dispatched','unknown'].includes(operation.state)&&<button type="button" disabled={busy} onClick={()=>void run(signal=>api.reconcile(operation.request_id,signal))}>{t("核对此原生结果","Verify This Native Result")}</button>}
  </li>)}</ul>}
  {history&&<nav aria-label={t('命令记录分页','Command Record Pages')}>
   <button type="button" disabled={busy||historical.loading||pageStarts.length===1} onClick={()=>setPageStarts(value=>value.slice(0,-1))}>{t("上一页","Previous Page")}</button>
   <span>{t(`第 ${pageStarts.length} 页`,`Page ${pageStarts.length}`)}</span>
   <button type="button" disabled={busy||historical.loading||!!historical.error||historyItems?.length!==50}
    onClick={()=>{const last=historyItems?.at(-1);if(last)setPageStarts(value=>[...value,last.request_id]);}}>{t("下一页","Next Page")}</button>
   {!historical.loading&&!historical.error&&historyItems?.length===0&&<p role="status">{t("此页没有更早的记录。","No earlier records on this page.")}</p>}
  </nav>}
 </section>;
}
