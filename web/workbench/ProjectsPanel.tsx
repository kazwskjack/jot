import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import React,{useLayoutEffect,useMemo,useRef,useState} from 'react';
import {workbenchApi,pathId} from './client';
import {Empty,ResourceStatus} from './PanelStatus';
import {useMutationReceipt} from './useMutationReceipt';
import {ProjectLifecycleStore} from './task-save-receipt.mjs';
import {taskDraftScope} from '../jot/client';
import {useResource} from './useResource';
import type {CreateProject,Project,UpdateProject,ProjectLifecycle,UpdateProjectLifecycle} from '../../packages/gateway/contracts/types';

type ProjectCommand={path:string;method:'POST'|'PATCH';body:Record<string,unknown>};
type RenameConflict={project_id:string;title:string;stale_version:number};
const sendProjectCommand=async(path:string,method:string,body:unknown,key:string)=>{
 if(path==='/projects'&&method==='POST')return workbenchApi.createProject(body as CreateProject,key);
 const match=method==='PATCH'?/^\/projects\/([^/]+)$/.exec(path):null;
 if(match)return workbenchApi.renameProject(decodeURIComponent(match[1]!),body as UpdateProject,key);
 throw new Error('项目请求无效');
};

const sendLifecycleCommand=async(path:string,method:string,body:unknown,key:string)=>{
 const match=method==='POST'?/^\/projects\/([^/]+)\/lifecycle$/.exec(path):null;
 if(!match)throw new Error('项目生命周期请求无效');
 return workbenchApi.updateProjectLifecycle(decodeURIComponent(match[1]!),body as UpdateProjectLifecycle,key);
};

export default function ProjectsPanel(){
 const language=useApplicationLanguage(),t=useApplicationText();
 const lifecycleLabels={archive:t('归档','Archive'),delete:t('删除','Delete'),restore:t('恢复','Restore')} as const;
 const messages:Record<string,string>={"项目请求无效": "Invalid Project Request", "项目生命周期请求无效": "Invalid Project Lifecycle Request", "项目操作回执无法读取，请核对服务端项目状态。": "The project operation receipt cannot be read. Check the server project state.", "项目操作已确认，关联角色、会话、文件、版本与回执保留。": "The project operation is confirmed. Associated roles, conversations, files, versions and receipts are retained.", "项目操作失败": "Project Operation Failed", "保存项目失败": "Saving Project Failed", "请填写项目名称": "Enter a Project Name", "读取失败": "Read Failed", "任务正在保存": "A Save Is Already in Progress"};
 const message=(value:string)=>language==='en'&&Object.hasOwn(messages,value)?messages[value]!:value;
 const resource=useResource(workbenchApi.projects,'workbench-projects'),mutation=useMutationReceipt(undefined,undefined,sendProjectCommand);
 const scope=taskDraftScope();
 const recovery=useMemo(()=>{
  try{const store=new ProjectLifecycleStore(sessionStorage,scope);return {store,command:store.read()?.command??null,error:''};}
  catch{return {store:null,command:null,error:'项目操作回执无法读取，请核对服务端项目状态。'};}
 },[scope]);
 const lifecycle=useResource(workbenchApi.projectLifecycle,'project-lifecycle');
 const lifecycleMutation=useMutationReceipt(recovery.store,undefined,sendLifecycleCommand);
 const [review,setReview]=useState<{project:Project;action:UpdateProjectLifecycle['action']}|null>(null);
 const [lifecycleRetry,setLifecycleRetry]=useState<ProjectCommand|null>(recovery.command),[lifecycleError,setLifecycleError]=useState(''),[lifecycleNotice,setLifecycleNotice]=useState('');
 const applyLifecycle=async(command:ProjectCommand)=>{
  if(!recovery.store)return;
  setLifecycleError('');setLifecycleRetry(command);
  try{await lifecycleMutation.submit(command.path,command.method,command.body);setLifecycleRetry(null);setReview(null);setLifecycleNotice('项目操作已确认，关联角色、会话、文件、版本与回执保留。');resource.reload();lifecycle.reload();}
  catch(cause){setLifecycleError(cause instanceof Error?cause.message:'项目操作失败');}
 };
 const openLifecycle=(project:Project,action:UpdateProjectLifecycle['action'])=>{setLifecycleNotice('');setLifecycleError('');setReview({project,action});};
 const lifecycleActions=(project:ProjectLifecycle|Project)=>{
  if(project.is_default)return null;
  const state=project as Partial<ProjectLifecycle>;
  const disabled=mutation.pending||lifecycleMutation.pending||!recovery.store;
  return <div className="wb-actions">{state.deleted_at?<button type="button" disabled={disabled} aria-label={t(`恢复 ${project.title}`,`Restore ${project.title}`)} onClick={()=>openLifecycle(project,'restore')}>{t('恢复','Restore')}</button>:<>
   <button type="button" disabled={disabled} aria-label={`${state.archived_at?t("恢复","Restore"):t("归档","Archive")} ${project.title}`} onClick={()=>openLifecycle(project,state.archived_at?'restore':'archive')}>{state.archived_at?t("恢复","Restore"):t("归档","Archive")}</button>
   <button type="button" disabled={disabled} aria-label={t(`删除 ${project.title}`,`Delete ${project.title}`)} onClick={()=>openLifecycle(project,'delete')}>{t('删除','Delete')}</button>
  </>}</div>;
 };
 const [creating,setCreating]=useState(false),[newTitle,setNewTitle]=useState(''),[renaming,setRenaming]=useState<Project|null>(null),[renameTitle,setRenameTitle]=useState('');
 const [retry,setRetry]=useState<ProjectCommand|null>(null),[error,setError]=useState(''),[conflict,setConflict]=useState<RenameConflict|null>(null);
 const createAction=useRef<HTMLButtonElement|null>(null),renameActions=useRef(new Map<string,HTMLButtonElement>()),conflictAction=useRef<HTMLButtonElement|null>(null),retryAction=useRef<HTMLButtonElement|null>(null);
 useLayoutEffect(()=>{if(lifecycleNotice&&!lifecycleMutation.pending)createAction.current?.focus();},[lifecycleNotice,lifecycleMutation.pending]);
 const composing=useRef(false);
 const returnTarget=useRef<{kind:'create'}|{kind:'rename';projectId:string}|null>(null),wasFormOpen=useRef(false),pendingFocus=useRef(false),conflictReloadStarted=useRef(false),pendingRetryFocus=useRef(false);
 const focusReturnTarget=()=>{
  if(mutation.pending)return;
  const target=returnTarget.current,action=target?.kind==='create'?createAction.current:target?.kind==='rename'?renameActions.current.get(target.projectId):null;
  const fallback=action?.isConnected&&!action.disabled?action:target?.kind==='rename'?createAction.current:null;
  if(fallback?.isConnected&&!fallback.disabled){fallback.focus();pendingFocus.current=false;}
 };
 const save=async(command:ProjectCommand)=>{
  setError('');setRetry(command);
  try{
   await mutation.submit(command.path,command.method,command.body);
   setRetry(null);setConflict(null);setCreating(false);setRenaming(null);setNewTitle('');resource.reload();
  }catch(cause){
   if(command.method==='PATCH'&&renaming&&cause instanceof Error&&cause.message==='VERSION_CONFLICT'&&(cause as Error&{status?:number}).status===409){
    setRetry(null);setCreating(false);setRenaming(null);setConflict({project_id:renaming.project_id,title:renameTitle,stale_version:renaming.version});setError(`项目已在其他标签页更新。已保留名称草稿“${renameTitle}”；请刷新后明确再次保存。`);resource.reload();return;
   }
   pendingRetryFocus.current=true;
   setError(cause instanceof Error?cause.message:'保存项目失败');
  }
 };
 const create=(event:React.FormEvent)=>{
  event.preventDefault();const title=newTitle.trim();if(!title){setError('请填写项目名称');return;}
  void save({path:'/projects',method:'POST',body:{title}});
 };
 const rename=(event:React.FormEvent)=>{
  event.preventDefault();if(!renaming)return;const title=renameTitle.trim();if(!title){setError('请填写项目名称');return;}
  void save({path:`/projects/${pathId(renaming.project_id)}`,method:'PATCH',body:{expected_version:renaming.version,title}});
 };
 const preventImeSubmit=(event:React.KeyboardEvent<HTMLFormElement>)=>{if(event.key==='Enter'&&(composing.current||event.nativeEvent.isComposing||event.nativeEvent.keyCode===229))event.preventDefault();};
 const items=resource.data?.items??[],conflictProject=conflict&&items.find(project=>project.project_id===conflict.project_id&&project.version>conflict.stale_version);
 useLayoutEffect(()=>{
  const formOpen=creating||!!renaming;
  if(wasFormOpen.current&&!formOpen){pendingFocus.current=true;conflictReloadStarted.current=!!conflict&&resource.loading;}
  wasFormOpen.current=formOpen;
  if(!pendingFocus.current)return;
  if(conflict){
   if(resource.loading){conflictReloadStarted.current=true;return;}
   if(!conflictReloadStarted.current)return;
   if(conflictAction.current?.isConnected&&!conflictAction.current.disabled){conflictAction.current.focus();pendingFocus.current=false;conflictReloadStarted.current=false;}
   return;
  }
  focusReturnTarget();
 },[creating,renaming?.project_id,conflict,conflictProject?.project_id,resource.loading,resource.error,mutation.pending]);
 useLayoutEffect(()=>{
  if(!pendingRetryFocus.current||!error)return;
  if(mutation.pending&&retryAction.current?.isConnected){retryAction.current.focus();pendingRetryFocus.current=false;}
  else if(!mutation.pending)pendingRetryFocus.current=false;
 },[error,mutation.pending,retry]);
 return <div lang={language}>
  <div className="wb-toolbar"><div><h2>{t("项目","Projects")}</h2><p>{t("管理对话所属项目。","Manage the Projects That Own Conversations.")}</p></div><button ref={createAction} type="button" data-desktop-target="new-project" disabled={mutation.pending||lifecycleMutation.pending} onClick={()=>{composing.current=false;returnTarget.current={kind:'create'};pendingFocus.current=false;conflictReloadStarted.current=false;setConflict(null);setCreating(true);setRenaming(null);setError('');}}>{t("创建项目","Create Project")}</button></div>
  {recovery.error&&<p className="wb-error" role="alert">{message(recovery.error)}</p>}
  {lifecycleNotice&&<p role="status">{message(lifecycleNotice)}</p>}
  {lifecycleError&&<p className="wb-error" role="alert">{message(lifecycleError)}</p>}
  {lifecycleMutation.pending&&lifecycleRetry&&<section aria-label={t("待确认的项目操作","Unconfirmed Project Operation")}><p>{t("原项目操作的结果待确认。刷新后可重试同一请求。","The original project operation result is unconfirmed. After refreshing, you can retry the same request.")}</p><button autoFocus type="button" onClick={()=>void applyLifecycle(lifecycleRetry)}>{t("重试原项目操作","Retry Original Project Operation")}</button></section>}
  {review&&!lifecycleMutation.pending&&<form className="wb-form" aria-label={t("确认项目操作","Confirm Project Operation")} onSubmit={event=>{event.preventDefault();void applyLifecycle({path:`/projects/${pathId(review.project.project_id)}/lifecycle`,method:'POST',body:{action:review.action,expected_version:review.project.version}});}}>
   <h3>{lifecycleLabels[review.action]} {review.project.title}</h3>
   <p>{t("归档后可恢复，已有任务继续按原授权运行。删除采用可恢复标记，保留角色、会话、文件及版本。回执沿用原保留策略，可按原请求恢复。活动任务和未完成操作会阻止删除。","Archived projects can be restored. Existing tasks continue under their original authorization. Deletion uses a recoverable marker and retains roles, conversations, files and versions. Receipts follow the original retention policy and recovery uses the original request. Active tasks and unfinished operations prevent deletion.")}</p>
   <div className="wb-actions"><button autoFocus type="submit" disabled={mutation.pending||!recovery.store}>{t(`确认${lifecycleLabels[review.action]}项目`,`Confirm ${lifecycleLabels[review.action]} Project`)}</button><button type="button" onClick={()=>setReview(null)}>{t("取消项目操作","Cancel Project Operation")}</button></div>
  </form>}
  {creating&&<form className="wb-form" aria-label={t("创建项目","Create Project")} onSubmit={create} onKeyDown={preventImeSubmit}>
   <label>{t("新项目名称","New Project Name")}<input data-desktop-target="new-project-input" autoFocus required maxLength={100} value={newTitle} disabled={mutation.pending||lifecycleMutation.pending} onChange={event=>setNewTitle(event.target.value)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}/></label>
   <div className="wb-actions"><button className="wb-primary" type="submit" disabled={mutation.pending||!newTitle.trim()}>{mutation.pending?t("正在保存…","Saving…"):t("保存项目","Save Project")}</button><button type="button" disabled={mutation.pending||lifecycleMutation.pending} onClick={()=>setCreating(false)}>{t("取消","Cancel")}</button></div>
  </form>}
  <ResourceStatus {...resource} error={message(resource.error)} onRetry={resource.reload} label={t('项目','Projects')}/>
  {error&&<p className="wb-error" role="alert">{conflict&&error===`项目已在其他标签页更新。已保留名称草稿“${conflict.title}”；请刷新后明确再次保存。`?t(error,`The project was updated in another tab. The name draft “${conflict.title}” is retained. Refresh, then explicitly save again.`):message(error)}</p>}
  {error&&mutation.pending&&retry&&<button ref={retryAction} type="button" className="wb-primary" onClick={()=>void save(retry)}>{t("重试原请求","Retry Original Request")}</button>}
  {conflict&&<div className="wb-actions" role="status"><span>{t('保留的名称草稿：“','Retained Name Draft: “')}{conflict.title}”</span>{conflictProject?<button ref={conflictAction} type="button" onClick={()=>{returnTarget.current={kind:'rename',projectId:conflictProject.project_id};pendingFocus.current=false;conflictReloadStarted.current=false;setRenaming(conflictProject);setRenameTitle(conflict.title);setConflict(null);setError('');}}>{t('继续重命名 ','Continue Renaming ')}{conflictProject.title}</button>:<button ref={conflictAction} type="button" disabled={resource.loading} onClick={resource.reload}>{t("刷新项目列表","Refresh Project List")}</button>}<button type="button" onClick={()=>{setConflict(null);setError('');}}>{t("放弃草稿","Discard Draft")}</button></div>}
  {!resource.loading&&!resource.error&&items.length===0&&<Empty>{t("还没有项目，创建一个项目来整理对话。","No projects yet. Create a project to organize conversations.")}</Empty>}
  <div className="wb-agent-grid" role="list" aria-label={t("项目列表","Project List")}>{items.map(project=><article role="listitem" className="wb-agent-card" key={project.project_id}>
   <div className="wb-card-top"><div><h3>{project.title}</h3><small>{project.is_default?t("默认项目","Default Project"):t(`${project.active_conversation_count??0} 个活动对话 · ${project.archived_conversation_count??0} 个已归档`,`${project.active_conversation_count??0} Active Conversations · ${project.archived_conversation_count??0} Archived`)}</small></div>
    <button ref={element=>{if(element)renameActions.current.set(project.project_id,element);else renameActions.current.delete(project.project_id);}} type="button" aria-label={t(`重命名 ${project.title}`,`Rename ${project.title}`)} disabled={mutation.pending||lifecycleMutation.pending||conflict?.project_id===project.project_id} onClick={()=>{composing.current=false;returnTarget.current={kind:'rename',projectId:project.project_id};pendingFocus.current=false;conflictReloadStarted.current=false;setConflict(null);setCreating(false);setRenaming(project);setRenameTitle(project.title);setError('');}}>{t("重命名","Rename")}</button>
   </div>
   {lifecycleActions(project)}
   {renaming?.project_id===project.project_id&&<form className="wb-form" aria-label={t(`重命名 ${project.title}`,`Rename ${project.title}`)} onSubmit={rename} onKeyDown={preventImeSubmit}>
    <label>{t("项目名称","Project Name")}<input autoFocus required maxLength={100} value={renameTitle} disabled={mutation.pending||lifecycleMutation.pending} onChange={event=>setRenameTitle(event.target.value)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}/></label>
    <div className="wb-actions"><button className="wb-primary" type="submit" disabled={mutation.pending||!renameTitle.trim()}>{t("保存名称","Save Name")}</button><button type="button" disabled={mutation.pending||lifecycleMutation.pending} onClick={()=>setRenaming(null)}>{t("取消","Cancel")}</button></div>
   </form>}
  </article>)}</div>
  <section aria-label={t("已归档及已删除项目","Archived and Deleted Projects")}><h3>{t("已归档及已删除项目","Archived and Deleted Projects")}</h3><ResourceStatus {...lifecycle} error={message(lifecycle.error)} onRetry={lifecycle.reload} label={t('项目保留记录','Retained Project Records')}/>
   {(lifecycle.data?.items??[]).filter(project=>project.archived_at||project.deleted_at).map(project=><article className="wb-agent-card" key={project.project_id}><h4>{project.title}</h4><p>{project.deleted_at?t("已删除，可恢复","Deleted; Restorable"):t("已归档","Archived")}</p>{lifecycleActions(project)}</article>)}
  </section>
 </div>;
}
