import React,{useState} from 'react';
import type {GitIndexHistory,GitIndexStatus,GitIndexAcceptance} from './types';
import {workbenchApi} from './client';import {useResource} from './useResource';import {ResourceStatus} from './AgentsPanel';
import GitIndexOperation from './GitIndexOperation';

const outcome=(state:string)=>({pending:'等待执行',unknown:'结果待确认',applied:'已应用',not_dispatched:'未执行',abandoned_unknown:'已结束，效果未确认'} as Record<string,string>)[state]??'状态待核对';
function scoped(status:GitIndexStatus,acceptance:GitIndexAcceptance,project:string){
 const e=status.execution;
 if(acceptance.project_id!==project||e.project_id!==project||e.execution_id!==acceptance.execution_id||e.intent_id!==acceptance.intent_id||e.request_id!==acceptance.request_id||e.action!==acceptance.action||status.producer.execution_id!==e.execution_id||status.execution_authorized!==false||e.execution_authorized!==false||status.producer.execution_authorized!==false)throw Error('GIT_HISTORY_SCOPE_CHANGED');
 return status;
}
function pageScope(page:GitIndexHistory,project:string){if(page.project_id!==project||page.execution_authorized!==false||!Array.isArray(page.items))throw Error('GIT_HISTORY_SCOPE_CHANGED');for(const row of page.items){if(row.acceptance.accepted!==true||row.acceptance.execution_authorized!==false)throw Error('GIT_HISTORY_SCOPE_CHANGED');scoped(row.status,row.acceptance,project)}return page}
export default function GitHistory({project,locked=false,allowDispatch=false,onBusy}:{project:string;locked?:boolean;allowDispatch?:boolean;onBusy?:(value:boolean)=>void}){
 const[opened,setOpened]=useState(false),[before,setBefore]=useState<string|undefined>(),[selected,setSelected]=useState<GitIndexAcceptance|null>(null),[detailVersion,setDetailVersion]=useState(0);
 const history=useResource(async signal=>pageScope(await workbenchApi.gitHistory(project,{before,limit:20},signal),project),JSON.stringify(['git-history',project,before]),opened);
 const detail=useResource(async signal=>scoped(await workbenchApi.gitStatus(project,selected!.execution_id,signal),selected!,project),JSON.stringify(['git-status',project,selected?.execution_id]),opened&&!!selected&&!allowDispatch);
 const page=!history.loading&&!history.error&&history.data?.project_id===project?history.data:null,status=!detail.loading&&!detail.error&&detail.data?.execution.project_id===project&&detail.data.execution.execution_id===selected?.execution_id?detail.data:null;
 const interactive=allowDispatch||!!status&&(status.workspace_state==='reserved'||status.execution.state==='pending'||status.execution.state==='unknown');
 return <section aria-label="Git 操作记录"><button type="button" disabled={locked} aria-expanded={opened} onClick={()=>setOpened(v=>!v)}>操作记录</button>{opened&&<>
  <p className="wb-hint">读取原始操作及当前状态，不会重新执行。</p><ResourceStatus loading={history.loading} error={history.error?'操作记录暂时无法确认，请重新读取。':''} onRetry={history.reload}/>
  <button type="button" disabled={locked||history.loading} onClick={()=>{history.reload();detail.reload();setDetailVersion(v=>v+1)}}>刷新操作记录</button>
  {before&&<button type="button" disabled={locked||history.loading} onClick={()=>setBefore(undefined)}>最新记录</button>}
  {page&&<>{!page.items.length?<p>没有操作记录。</p>:<ul>{page.items.map(row=><li key={row.acceptance.execution_id}><button type="button" disabled={locked} aria-pressed={selected?.execution_id===row.acceptance.execution_id} onClick={()=>{setSelected(row.acceptance);detail.reload();setDetailVersion(v=>v+1)}}>{row.acceptance.action==='stage'?'暂存选定文件':'取消选定文件的暂存'} · {outcome(row.status.execution.state)}</button><time>{row.created_at}</time></li>)}</ul>}{page.next_cursor&&<button type="button" disabled={locked} onClick={()=>setBefore(page.next_cursor!)}>更早记录</button>}</>}
  {selected&&<section aria-label="Git 操作状态">{interactive?<GitIndexOperation key={selected.execution_id} project={project} acceptance={selected} allowDispatch={allowDispatch} onBusy={onBusy} onChanged={history.reload} refreshToken={detailVersion}/>:<><ResourceStatus loading={detail.loading} error={detail.error?'当前操作状态尚未确认，请重新读取。':''} onRetry={detail.reload}/>{status&&<>
   <p style={{overflowWrap:'anywhere'}}><code>{status.execution.execution_id}</code></p>
   <p role="status">{status.execution.state==='not_dispatched'?'操作未执行。':status.execution.state==='applied'?'变更已应用。':status.execution.state==='abandoned_unknown'?'操作已结束，实际效果仍未确认。':'操作结果尚未确认。'}</p>
   <p>{status.workspace_state==='reserved'?'工作区仍被占用，原执行尚未完成收尾。':status.workspace_state==='released_settled'||status.workspace_state==='released_unstarted'||status.execution.state==='not_dispatched'?'工作区已释放。':'尚未占用工作区。'}</p>
   <ul>{status.execution.paths.map(path=><li key={path} style={{overflowWrap:'anywhere'}}><code>{path}</code></li>)}</ul>
  </>}</>}</section>}
 </>}</section>;
}
