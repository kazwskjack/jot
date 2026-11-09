import React,{useLayoutEffect,useRef,useState} from 'react';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus} from './PanelStatus';
import GitCheckoutEvidence from './GitCheckoutEvidence';
import GitCheckoutReview from './GitCheckoutReview';

export default function GitCheckoutPreview({project,snapshotId,targetRef,onClose,onBusy}:{project:string;snapshotId:string;targetRef:string;onClose:()=>void;onBusy:(busy:boolean)=>void}){
 const heading=useRef<HTMLHeadingElement>(null),reviewOpener=useRef<HTMLButtonElement>(null),[reviewing,setReviewing]=useState(false),[childBusy,setChildBusy]=useState(false),[restoreFocus,setRestoreFocus]=useState(false);
 useLayoutEffect(()=>{heading.current?.focus()},[]);
 useLayoutEffect(()=>{if(!reviewing&&restoreFocus){(reviewOpener.current??heading.current)?.focus();setRestoreFocus(false)}},[reviewing,restoreFocus]);
 const resource=useResource(async signal=>{
  const value=await workbenchApi.gitBranches(project,snapshotId,signal,targetRef),preview=value.checkout_preview;
  const target=value.branches.find(branch=>branch.ref===targetRef);
  if(value.project_id!==project||value.snapshot_id!==snapshotId||value.read_only!==true||value.execution_authorized!==false
   ||!target||!preview||preview.target_ref!==targetRef||preview.execution_authorized!==false||preview.target_oid!==target?.checkout_oid)throw Error('GIT_CHECKOUT_PREVIEW_SCOPE_CHANGED');
  return {preview,target};
 },JSON.stringify(['git-checkout-preview',project,snapshotId,targetRef]));
 const state=!resource.loading&&!resource.error&&resource.data?.preview.target_ref===targetRef?resource.data:null;
 const error=['GIT_SNAPSHOT_CHANGED','GIT_REPOSITORY_CHANGED','GIT_CHECKOUT_TARGET_UNAVAILABLE'].includes(resource.error)?'仓库或目标已变化，请刷新仓库后重新选择分支。':['GIT_OUTPUT_LIMIT','GIT_ENTRY_LIMIT','GIT_METADATA_LIMIT'].includes(resource.error)?'预览内容或条目超过读取范围，请核对仓库。':resource.error?'暂时无法读取切换预览，请重试。':'';
 const retry=()=>{heading.current?.focus();resource.reload()};
 return <section className="wb-form wb-git-review" aria-label="Git 分支切换影响预览">
  <div className="wb-toolbar"><h3 ref={heading} tabIndex={-1}>分支切换影响</h3><button type="button" disabled={childBusy} onClick={onClose}>关闭切换预览</button></div>
  <ResourceStatus loading={resource.loading} error={error} onRetry={retry}/>
  {state&&!reviewing&&<>
   <GitCheckoutEvidence preview={state.preview} target={state.target} onRetry={retry}/>
   {!reviewing&&<button ref={reviewOpener} type="button" onClick={()=>setReviewing(true)}>生成切换审核</button>}

  </>}
  {reviewing&&<GitCheckoutReview project={project} snapshotId={snapshotId} targetRef={targetRef} onBusy={busy=>{setChildBusy(busy);onBusy(busy)}} onClose={()=>{setReviewing(false);setRestoreFocus(true)}}/>}
 </section>;
}
