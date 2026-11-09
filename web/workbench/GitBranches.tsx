import React,{useState} from 'react';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus} from './PanelStatus';

export default function GitBranches({project,snapshotId,locked,onRefresh}:{project:string;snapshotId:string;locked:boolean;onRefresh:()=>void}){
 const [opened,setOpened]=useState(false);
 const inventory=useResource(async signal=>{
  const value=await workbenchApi.gitBranches(project,snapshotId,signal);
  if(value.project_id!==project||value.snapshot_id!==snapshotId||value.read_only!==true||value.execution_authorized!==false)throw Error('GIT_BRANCH_SCOPE_CHANGED');
  return value;
 },JSON.stringify(['git-branches',project,snapshotId]),opened);
 const state=!inventory.loading&&!inventory.error&&inventory.data?.project_id===project&&inventory.data.snapshot_id===snapshotId?inventory.data:null;
 const error=inventory.error==='GIT_SNAPSHOT_CHANGED'?'仓库已变化，请刷新仓库后重新展开分支。':inventory.error==='GIT_REFERENCE_BACKEND_UNSUPPORTED'?'仓库引用存储格式暂不支持，请核对仓库配置。':inventory.error==='GIT_ENTRY_LIMIT'?'分支数量超过读取范围，请核对仓库。':inventory.error?'暂时无法读取分支，请刷新仓库后重试。':'';
 return <section className="wb-git-branches" aria-label="Git 分支列表">
  <button type="button" disabled={locked} aria-expanded={opened} onClick={()=>setOpened(value=>!value)}>分支列表</button>
  {opened&&<>
   <ResourceStatus loading={inventory.loading} error={error} onRetry={onRefresh}/>
   {state&&<>{!state.branches.length?<p role="status">尚无已提交的分支引用。{state.head.detached?'当前处于分离 HEAD。':<>当前分支 <code>{state.head.branch??'未命名'}</code>。</>}</p>:<ul aria-label="本地与远端分支">{state.branches.map(branch=><li key={branch.ref}>
    <span className="wb-badge">{branch.kind==='local'?'本地':'远端'}</span>{branch.current&&<strong>当前</strong>}
    <code>{branch.ref}</code><code>{branch.oid}</code>
    {branch.symbolic_target&&<span>指向 <code>{branch.symbolic_target}</code></span>}
    {branch.object_type!=='commit'&&<span>对象类型 {branch.object_type}</span>}
   </li>)}</ul>}</>}
  </>}
 </section>;
}
