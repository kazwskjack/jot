import React,{useEffect,useMemo,useRef,useState} from 'react';
import type {Task} from './types';
import {request,taskDraftScope} from '../jot/client';
import {useResource} from './useResource';
import {PrdFlow,PrdCommandStore,installPrdLeaveGuard,prdMessage} from './task-prd.mjs';
import {TaskSaveReceipt} from './task-save-receipt.mjs';
import PrdTextPreview from './PrdTextPreview';
import TaskPrdTemplates from './TaskPrdTemplates';
import TaskPrdProjectFiles from './TaskPrdProjectFiles';
import TaskPrdWorkPlans from './TaskPrdWorkPlans';
import type {TaskPrdSources as PrdSources,TaskPrdSource,TaskPrdInstallation as PrdInstallation,TaskPrdProject as PrdProject,TaskPrdImport as PrdImport} from '../../packages/gateway/contracts/types';

const textStyle:React.CSSProperties={whiteSpace:'pre-wrap',overflowWrap:'anywhere',wordBreak:'break-word',maxWidth:'100%'};
const projectFileStates={missing:'未找到',too_large:'超过读取大小限制',invalid:'文件格式不支持',ready:'格式可读取'};
const installationScopes={owner_profile:'当前用户 DSH profile',host_path:'当前用户运行环境 PATH',profile_and_path:'当前用户 profile 与运行环境 PATH'};

export default function TaskPrdPanel({task,executionReady,onBound}:{task:Task;executionReady:boolean;onBound:()=>void}){
 const root=useRef<HTMLElement>(null),flowRef=useRef<PrdFlow|null>(null);
 const [recovery]=useState(()=>{
  try{
   const scope=taskDraftScope(),store=scope?new PrdCommandStore(sessionStorage,scope,task.task_id):null;
   const importStore=scope?new PrdCommandStore(sessionStorage,scope,task.task_id,'taskmaster-import'):null;
   const templateStore=scope?new PrdCommandStore(sessionStorage,scope,task.task_id,'template-apply'):null;
   const documentStore=scope?new PrdCommandStore(sessionStorage,scope,task.task_id,'taskmaster-prd-import'):null;
   const workPlanStore=scope?new PrdCommandStore(sessionStorage,scope,task.task_id,'work-plan-accept'):null;
   const cycleStore=scope?new PrdCommandStore(sessionStorage,scope,task.task_id,'work-plan-cycle'):null;
   store?.read();importStore?.read();templateStore?.read();documentStore?.read();workPlanStore?.read();cycleStore?.read();
   return {store,importStore,templateStore,documentStore,workPlanStore,cycleStore,error:''};
  }catch(e){return {store:null,importStore:null,templateStore:null,documentStore:null,workPlanStore:null,cycleStore:null,error:e instanceof Error?e.message:'本机 PRD 回执不可读取'};}
 });
 const [importSave]=useState(()=>new TaskSaveReceipt(undefined,recovery.importStore));
 const [templateSave]=useState(()=>new TaskSaveReceipt(undefined,recovery.templateStore));
 const [documentSave]=useState(()=>new TaskSaveReceipt(undefined,recovery.documentStore));
 const [workPlanSave]=useState(()=>new TaskSaveReceipt(undefined,recovery.workPlanStore));
 const [cycleSave]=useState(()=>new TaskSaveReceipt(undefined,recovery.cycleStore));
 const [importConfirmed,setImportConfirmed]=useState(false),[importReceipt,setImportReceipt]=useState<PrdImport|null>(null);
 const [savedSource,setSavedSource]=useState<{task_version:number;source:Extract<TaskPrdSource,{kind:'logical_file'}>}|null>(null);
 if(!flowRef.current)flowRef.current=new PrdFlow(task,executionReady,undefined,recovery.store);
 const flow=flowRef.current;flow.setContext(task,executionReady);
 const [,revision]=useState(0),[index,setIndex]=useState(''),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
 const draw=()=>revision(value=>value+1);
 const identity=`${task.task_id}:${task.version}:${task.status}:${executionReady}`;
 const resource=useResource(signal=>request<PrdSources>(`/persistent-tasks/${encodeURIComponent(task.task_id)}/prd/sources`,'GET',undefined,undefined,signal),identity);
 const installationResource=useResource(signal=>request<PrdInstallation>(`/persistent-tasks/${encodeURIComponent(task.task_id)}/prd/taskmaster-installation`,'GET',undefined,undefined,signal),identity);
 const projectResource=useResource(signal=>request<PrdProject>(`/persistent-tasks/${encodeURIComponent(task.task_id)}/prd/taskmaster-project`,'GET',undefined,undefined,signal),identity);
 const savedFile=savedSource?.task_version===task.version?savedSource.source:null;
 const sourcesData=useMemo(()=>resource.data&&savedFile&&!resource.data.sources.some(source=>source.kind==='logical_file'&&source.path===savedFile.path&&source.version===savedFile.version&&source.sha256===savedFile.sha256)
  ?{...resource.data,sources:[...resource.data.sources,savedFile]}:resource.data,[resource.data,savedFile]);
 useEffect(()=>{if(sourcesData&&!flow.pending&&!flow.busy&&!importSave.pending&&!importSave.busy&&!templateSave.pending&&!templateSave.busy&&!documentSave.pending&&!documentSave.busy&&!workPlanSave.pending&&!workPlanSave.busy&&!cycleSave.pending&&!cycleSave.busy){flow.setSources(sourcesData);setIndex('');setConfirmed(false);draw();}},[sourcesData]);
 useEffect(()=>setImportConfirmed(false),[identity,projectResource.data?.import_preview_sha256]);
 useEffect(()=>installPrdLeaveGuard(window,()=>flow.pending||importSave.pending||templateSave.pending||documentSave.pending||workPlanSave.pending||cycleSave.pending,node=>node instanceof Node&&Boolean(root.current?.contains(node))),[flow,importSave,templateSave,documentSave,workPlanSave,cycleSave]);
 const unavailable=resource.loading||!!resource.error||!!recovery.error||!flow.ready;
 const locked=flow.busy||flow.pending||importSave.busy||importSave.pending||templateSave.busy||templateSave.pending||documentSave.busy||documentSave.pending||workPlanSave.busy||workPlanSave.pending||cycleSave.busy||cycleSave.pending;
 async function operate(action:()=>Promise<unknown>,binding=false){
  if(flow.busy||importSave.busy||importSave.pending||templateSave.busy||templateSave.pending||documentSave.busy||documentSave.pending||workPlanSave.busy||workPlanSave.pending||cycleSave.busy||cycleSave.pending)return;setError('');
  try{const work=action();draw();await work;if(binding){setConfirmed(false);setIndex('');resource.reload();onBound();}}
  catch(e){setError(`${prdMessage(e instanceof Error?e.message:'PRD 操作未完成')}${flow.refreshRequired?' 预览已失效，正在刷新，请重新选择来源。':''}`);if(flow.refreshRequired){setIndex('');setConfirmed(false);resource.reload();}}
  finally{draw();}
 }
 function refresh(){if(locked)return;flow.invalidate();setIndex('');setConfirmed(false);setError('');resource.reload();installationResource.reload();projectResource.reload();draw();}
 function fileSaved(receipt:{task_version:number;file:{path:string;version:number;sha256:string;size:number}}){
  const file=receipt.file;
  setSavedSource({task_version:receipt.task_version,source:{kind:'logical_file',path:file.path,name:file.path,version:file.version,sha256:file.sha256,size:file.size}});
  flow.invalidate();setIndex('');setConfirmed(false);resource.reload();projectResource.reload();draw();
 }
 const preview=flow.preview,binding=flow.receipt??resource.data?.binding,taskmaster=resource.data?.taskmaster;
 const installation=installationResource.data?.task_id===task.task_id&&installationResource.data.task_version===task.version?installationResource.data.installation:null;
 const project=projectResource.data?.task_id===task.task_id&&projectResource.data.task_version===task.version?projectResource.data:null;
 const importReady=!unavailable&&!projectResource.loading&&!projectResource.error&&project?.target?.path==='.taskmaster/tasks/tasks.json'
  &&/^[a-f0-9]{64}$/.test(project.import_preview_sha256??'')&&project.files.some(file=>file.path==='.taskmaster/tasks/tasks.json'&&file.state==='ready');
 async function importProject(){
  if(flow.busy||flow.pending||importSave.busy||templateSave.busy||templateSave.pending||documentSave.busy||documentSave.pending||workPlanSave.busy||workPlanSave.pending||cycleSave.busy||cycleSave.pending)return;
  if(!importSave.pending&&(!importReady||!importConfirmed||!project))return;
  setError('');
  const checkedRequest=async(path:string,method:string,body:{preview_sha256:string},key:string)=>{
   const value=await request<PrdImport>(path,method,body,key),file=value?.file,source=file?.source;
   if(value?.task_id!==task.task_id||value.execution_authorized!==false||value.preview_sha256!==body.preview_sha256
    ||file?.protocol!==1||file.path!=='.taskmaster/tasks/tasks.json'||!Number.isSafeInteger(file.version)||file.version<1||!/^[a-f0-9]{64}$/.test(file.sha256)
    ||source?.kind!=='taskmaster_project_import'||source.task_id!==task.task_id||source.preview_sha256!==body.preview_sha256)throw Error('PRD_TASKMASTER_IMPORT_UNCONFIRMED');
   return value;
  };
  try{
   const work=importSave.submit(checkedRequest,`/persistent-tasks/${encodeURIComponent(task.task_id)}/prd/taskmaster-import`,'POST',importSave.pending?{}:{preview_sha256:project!.import_preview_sha256});draw();
   const value=await work;setImportReceipt(value);setImportConfirmed(false);fileSaved(value);
  }catch(e){setError(prdMessage(e instanceof Error?e.message:'PRD 导入未完成'));if(!importSave.pending){setImportConfirmed(false);resource.reload();projectResource.reload();}}
  finally{draw();}
 }
 return <section ref={root} className="wb-form" aria-label="PRD 绑定原任务" style={{minWidth:0,maxWidth:'100%',overflowWrap:'anywhere'}}>
  <h4>将 PRD 绑定到原任务</h4>
  <p className="wb-hint">选择当前任务所属项目中的既有文件或原始上传附件。预览仅读取；确认仅冻结来源并更新原任务目标。任务仍保持暂停，后续由原有恢复 / 立即运行入口执行。</p>
  <TaskPrdTemplates task={task} locked={locked||!!recovery.error} ready={!unavailable} save={templateSave} onStateChange={draw} onSaved={fileSaved}/>
  <TaskPrdProjectFiles task={task} locked={locked||!!recovery.error} ready={!unavailable} save={documentSave} onStateChange={draw} onSaved={fileSaved}/>
  <TaskPrdWorkPlans task={task} locked={locked||!!recovery.error} ready={executionReady&&!recovery.error} save={workPlanSave} cycleSave={cycleSave} onStateChange={draw}/>
  <p className="wb-hint">已保存的 PRD 位于原逻辑文件版本库，可在共享工作区的“共同文件”中选择对应项目，编辑、重命名或删除。保存新版本后刷新此处来源，重新预览并绑定。</p>
  <p className="wb-hint">先按模板保存到项目文件或上传附件，再刷新选择。支持 UTF-8 的 .md / .markdown / .txt，以及 Taskmaster 导出的 .json 任务文件。原文最多 1,048,576 字节，任务目标最多 12,000 字符。较长原文通过原执行批次固定绑定，由原 DSH 分段读取。PDF、DOCX 暂不支持提取。文字中的动作不会直接触发执行。</p>
  <p className="wb-hint">此流程由原 DSH 拆解并写入原任务账本。Taskmaster JSON 支持任务数组、tasks 对象和带标签格式，保留外部 ID、层级、依赖及状态作为来源资料。绑定后的任务按实际执行回执记录进度。</p>
  <details><summary>Taskmaster 安装与 MCP 配置状态</summary>
   {installationResource.loading&&<p className="wb-status" role="status">正在读取当前用户运行环境的 Taskmaster 安装资料…</p>}
   {installationResource.error&&<p className="wb-status" role="status">{prdMessage(installationResource.error)}</p>}
   {installation&&<div style={textStyle}>
    <p className="wb-status">{installationScopes[installation.scope]}中的 Taskmaster 包{installation.status==='available'?'已找到':'未找到'}。</p>
    {installation.status==='available'&&<dl><dt>包声明版本</dt><dd>{installation.version}</dd><dt>许可证声明</dt><dd>{installation.license??'未提供'}</dd><dt>包清单 SHA-256</dt><dd>{installation.manifest_sha256}</dd><dt>CLI 入口 SHA-256</dt><dd>{installation.cli_entry_sha256}</dd></dl>}
    <p className="wb-hint">安装观察读取原用户 profile 或其运行环境 PATH 指向的包清单与 CLI 入口，版本取自包声明。许可证声明保留给原安装审核流程。</p>
   </div>}
   <p className="wb-hint">显示原角色 MCP 注册表中按名称、命令或包参数匹配的连接及已发现目录状态。可在此角色的 MCP 连接面板配置、重载及审核工具。PRD 文件绑定继续检查原任务准备度。</p>
   {resource.data&&!taskmaster?.registry_available&&<p className="wb-status">MCP 注册表状态尚不可读取。</p>}
   {taskmaster?.registry_available&&taskmaster.connections.length===0&&<p className="wb-status">此角色尚未配置匹配的 Taskmaster MCP 连接。</p>}
   {taskmaster?.registry_available&&taskmaster.connections.length>0&&<ul>{taskmaster.connections.map(connection=><li key={connection.connection_id}>
      {connection.server_name} · v{connection.version} · {connection.enabled?'已启用':'已禁用'} · {connection.state} · 已发现代次 {connection.active_generation} · 已批准工具 {connection.approved_tool_count}
      {connection.pending_generation!==null&&` · 待重载代次 ${connection.pending_generation}`}
     </li>)}</ul>}
   <h5>原项目 Taskmaster 文件</h5>
   <p className="wb-hint">从服务器绑定到此项目的 Git 目录读取固定 Taskmaster 文件，任务文件最多读取 1,048,576 字节，配置文件最多读取 65,536 字节。配置文件展示格式与哈希，任务文件可展开分段核对原文。确认后将此快照保存到原逻辑文件版本库，再通过下方来源选择预览并绑定原任务。</p>
   {projectResource.loading&&<p className="wb-status" role="status">正在核对原项目 Taskmaster 文件…</p>}
   {projectResource.error&&<p className="wb-status" role="status">{prdMessage(projectResource.error)}</p>}
   {project&&<div style={textStyle}>
    <dl><dt>原项目</dt><dd>{project.project_id}</dd><dt>项目文件来源 SHA-256</dt><dd>{project.source_sha256}</dd></dl>
    {project.target&&<dl><dt>保存目标 / 当前版本</dt><dd>{project.target.path} / v{project.target.version}</dd><dt>导入预览 SHA-256</dt><dd>{project.import_preview_sha256}</dd></dl>}
    <ul>{project.files.map(file=><li key={file.path}>
     {file.path} · {projectFileStates[file.state]} · {file.size} 字节
     {file.sha256&&<p>SHA-256 {file.sha256}</p>}
     {file.task_count!==null&&<p>任务及子任务 {file.task_count} 条 · 标签 {JSON.stringify(file.tags)}</p>}
     {file.content!==null&&<details><summary>任务文件原文</summary><PrdTextPreview content={file.content} label="任务文件原文" style={textStyle}/></details>}
    </li>)}</ul>
   </div>}
   <label className="wb-checkbox"><input type="checkbox" checked={importConfirmed} disabled={locked||!importReady} onChange={e=>setImportConfirmed(e.target.checked)}/>我已核对任务文件原文、来源哈希和目标版本，确认将这份快照保存为项目文件的新版本。</label>
   <button type="button" disabled={flow.busy||flow.pending||importSave.busy||templateSave.busy||templateSave.pending||documentSave.busy||documentSave.pending||workPlanSave.busy||workPlanSave.pending||cycleSave.busy||cycleSave.pending||!!recovery.error||(!importSave.pending&&(!importReady||!importConfirmed))} onClick={()=>void importProject()}>{importSave.busy?'正在保存文件…':importSave.pending?'重试原导入回执':'保存项目任务文件'}</button>
   {importSave.pending&&<p className="wb-status" role="status">导入结果待确认，已保留原请求及 key。请重试读取原回执。</p>}
   {importReceipt&&<p className="wb-status" role="status" style={textStyle}>已保存 {importReceipt.file.path} · v{importReceipt.file.version} · SHA-256 {importReceipt.file.sha256}。可从下方来源选择继续预览和绑定。</p>}
   <p className="wb-hint">CLI 安装、运行版本检查及其余任务操作继续补齐。连接状态沿用原注册表的发现结果，执行时沿用原角色权限、运行身份和预算校验。</p>
  </details>
  {!executionReady&&<p className="wb-status" role="status">执行宿主尚未就绪；来源可查看，就绪后再预览绑定。</p>}
  {task.status!=='paused'&&<p className="wb-status" role="status">绑定 PRD 前请先暂停原任务，并等待所有执行及未知结果核对完成。</p>}
  {resource.loading&&<p className="wb-status" role="status">正在读取来源与准备度…</p>}
  {resource.error&&<p className="wb-error" role="alert">{prdMessage(resource.error)}</p>}
  {recovery.error&&<p className="wb-error" role="alert">{recovery.error}</p>}
  {resource.data&&!resource.data.readiness.ready&&<p className="wb-status" role="status">暂不可绑定：{resource.data.readiness.reasons.map(prdMessage).join(' ')||'准备度尚未确认'}</p>}
  <div className="wb-actions"><button type="button" disabled={locked||resource.loading} onClick={refresh}>刷新来源与准备度</button></div>
  {resource.data?.truncated&&<p className="wb-hint">来源列表已截断，本页保存回执中的精确文件版本也会列入选择。预览时将重新核对原文件版本与哈希。</p>}
  {!resource.loading&&sourcesData?.sources.length===0&&<p className="wb-empty">当前任务作用域没有可选的文本来源。</p>}
  <label>PRD 来源<select value={index} disabled={locked||unavailable} onChange={e=>{try{flow.choose(e.target.value);setIndex(e.target.value);setConfirmed(false);setError('');draw();}catch(e){setError(e instanceof Error?e.message:'来源不可用');}}}><option value="">选择精确版本的已有来源</option>{sourcesData?.sources.map((source,i)=><option key={`${source.kind}:${source.kind==='logical_file'?source.path:source.artifact_id}:${source.version}:${source.sha256}`} value={i}>{source.name} · {source.kind==='upload'?'原始上传':'项目文件'} · v{source.version}</option>)}</select></label>
  {flow.selection&&<dl style={textStyle}><dt>来源版本</dt><dd>v{flow.selection.version}</dd><dt>SHA-256</dt><dd>{flow.selection.sha256}</dd></dl>}
  <button type="button" disabled={locked||unavailable||!flow.selection} onClick={()=>{setConfirmed(false);void operate(()=>flow.loadPreview(request));}}>{flow.busy&&!flow.pending?'正在读取预览…':'只读预览'}</button>
  {preview&&<><h5>精确预览</h5><dl style={textStyle}><dt>原任务 / 版本</dt><dd>{preview.task_id} / v{preview.task_version}</dd><dt>原执行角色 / 版本 / 权限纪元</dt><dd>{preview.role.agent_id} / v{preview.role.version} / {preview.role.capability_epoch}</dd><dt>来源 / 版本 / SHA-256</dt><dd>{preview.source.name} / v{preview.source.version} / {preview.source.sha256}</dd><dt>预览 SHA-256</dt><dd>{preview.preview_sha256}</dd></dl>
   <h5>PRD 原文</h5><PrdTextPreview content={preview.content} label="PRD 原文" style={textStyle}/>
   <h5>完整任务目标</h5><pre aria-label="完整任务目标" style={textStyle}>{preview.objective}</pre>
   {preview.source_delivery==='reference'&&<><h5>固定原文分段读取说明</h5><p className="wb-hint">原执行输入和原 Goal 会携带本批固定来源的读取说明与绑定参数。原 DSH 读取完整原文后沿用原任务账本拆解。</p><pre aria-label="固定原文分段读取说明" style={textStyle}>{preview.source_instructions}</pre></>}
   <label className="wb-checkbox"><input type="checkbox" checked={confirmed} disabled={locked||unavailable} onChange={e=>setConfirmed(e.target.checked)}/>我已阅读原文、任务目标和读取说明，确认仅绑定此原暂停任务，不创建任务、不恢复或启动执行。</label>
  </>}
  {flow.pending&&<p className="wb-status" role="status">绑定结果尚未确认。保留原来源、请求内容和请求 key；确认回执前不能修改选择或离开，请重试原请求。</p>}
  {(preview||flow.pending)&&<button className="wb-primary" type="button" disabled={flow.busy||importSave.busy||importSave.pending||templateSave.busy||templateSave.pending||documentSave.busy||documentSave.pending||workPlanSave.busy||workPlanSave.pending||cycleSave.busy||cycleSave.pending||(!flow.pending&&(unavailable||!confirmed))} onClick={()=>void operate(()=>flow.bind(request,confirmed),true)}>{flow.busy&&flow.pending?'正在确认绑定…':flow.pending?'重试原绑定请求':'确认绑定原暂停任务'}</button>}
  {error&&<p className="wb-error" role="alert">{error}</p>}
  {binding&&<div role="status"><p>{flow.receipt?'已冻结绑定到原任务；任务保持暂停。':'原任务已有冻结的 PRD 绑定。'}</p><dl style={textStyle}><dt>绑定 / 修订</dt><dd>{binding.binding_id} / {binding.revision}</dd><dt>任务版本</dt><dd>{binding.task_version}</dd><dt>冻结原文 SHA-256</dt><dd>{binding.content_sha256}</dd><dt>冻结目标 SHA-256</dt><dd>{binding.objective_sha256}</dd></dl></div>}
 </section>;
}
