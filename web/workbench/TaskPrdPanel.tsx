import React,{useEffect,useRef,useState} from 'react';
import type {Task} from './types';
import {request,taskDraftScope} from '../jot/client';
import {useResource} from './useResource';
import {PrdFlow,PrdCommandStore,PRD_TEMPLATE,installPrdLeaveGuard,prdMessage} from './task-prd.mjs';
import type {TaskPrdSources as PrdSources,TaskPrdInstallation as PrdInstallation} from '../../packages/gateway/contracts/types';

const textStyle:React.CSSProperties={whiteSpace:'pre-wrap',overflowWrap:'anywhere',wordBreak:'break-word',maxWidth:'100%'};

export default function TaskPrdPanel({task,executionReady,onBound}:{task:Task;executionReady:boolean;onBound:()=>void}){
 const root=useRef<HTMLElement>(null),flowRef=useRef<PrdFlow|null>(null);
 const [recovery]=useState(()=>{try{const scope=taskDraftScope(),store=scope?new PrdCommandStore(sessionStorage,scope,task.task_id):null;store?.read();return {store,error:''};}catch(e){return {store:null,error:e instanceof Error?e.message:'本机 PRD 回执不可读取'};}});
 if(!flowRef.current)flowRef.current=new PrdFlow(task,executionReady,undefined,recovery.store);
 const flow=flowRef.current;flow.setContext(task,executionReady);
 const [,revision]=useState(0),[index,setIndex]=useState(''),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
 const draw=()=>revision(value=>value+1);
 const identity=`${task.task_id}:${task.version}:${task.status}:${executionReady}`;
 const resource=useResource(signal=>request<PrdSources>(`/persistent-tasks/${encodeURIComponent(task.task_id)}/prd/sources`,'GET',undefined,undefined,signal),identity);
 const installationResource=useResource(signal=>request<PrdInstallation>(`/persistent-tasks/${encodeURIComponent(task.task_id)}/prd/taskmaster-installation`,'GET',undefined,undefined,signal),identity);
 useEffect(()=>{if(resource.data&&!flow.pending&&!flow.busy){flow.setSources(resource.data);setIndex('');setConfirmed(false);draw();}},[resource.data]);
 useEffect(()=>installPrdLeaveGuard(window,()=>flow.pending,node=>node instanceof Node&&Boolean(root.current?.contains(node))),[flow]);
 const unavailable=resource.loading||!!resource.error||!!recovery.error||!flow.ready;
 const locked=flow.busy||flow.pending;
 async function operate(action:()=>Promise<unknown>,binding=false){
  if(flow.busy)return;setError('');
  try{const work=action();draw();await work;if(binding){setConfirmed(false);setIndex('');resource.reload();onBound();}}
  catch(e){setError(`${prdMessage(e instanceof Error?e.message:'PRD 操作未完成')}${flow.refreshRequired?' 预览已失效，正在刷新，请重新选择来源。':''}`);if(flow.refreshRequired){setIndex('');setConfirmed(false);resource.reload();}}
  finally{draw();}
 }
 function refresh(){if(locked)return;flow.invalidate();setIndex('');setConfirmed(false);setError('');resource.reload();installationResource.reload();draw();}
 const preview=flow.preview,binding=flow.receipt??resource.data?.binding,taskmaster=resource.data?.taskmaster;
 const installation=installationResource.data?.task_id===task.task_id&&installationResource.data.task_version===task.version?installationResource.data.installation:null;
 return <section ref={root} className="wb-form" aria-label="PRD 绑定原任务" style={{minWidth:0,maxWidth:'100%',overflowWrap:'anywhere'}}>
  <h4>将 PRD 绑定到原任务</h4>
  <p className="wb-hint">选择当前任务所属项目中的既有文件或原始上传附件。预览仅读取；确认仅冻结来源并更新原任务目标。任务仍保持暂停，后续由原有恢复 / 立即运行入口执行。</p>
  <h5>PRD 静态模板</h5><pre style={textStyle} aria-label="PRD 静态模板">{PRD_TEMPLATE}</pre>
  <p className="wb-hint">先按模板保存到项目文件或上传附件，再刷新选择。支持 UTF-8 的 .md / .markdown / .txt，以及 Taskmaster 导出的 .json 任务文件。原文最多 65,536 字节，完整任务目标最多 12,000 字符。PDF、DOCX 暂不支持提取。文字中的动作不会直接触发执行。</p>
  <p className="wb-hint">此流程由原 DSH 拆解并写入原任务账本。Taskmaster JSON 支持任务数组、tasks 对象和带标签格式，保留外部 ID、层级、依赖及状态作为来源资料。绑定后的任务按实际执行回执记录进度。</p>
  <details><summary>Taskmaster 安装与 MCP 配置状态</summary>
   {installationResource.loading&&<p className="wb-status" role="status">正在读取当前用户 profile 内的 Taskmaster 安装资料…</p>}
   {installationResource.error&&<p className="wb-status" role="status">{prdMessage(installationResource.error)}</p>}
   {installation&&<div style={textStyle}>
    <p className="wb-status">当前用户 DSH profile 内的 Taskmaster 包{installation.status==='available'?'已找到':'未找到'}。</p>
    {installation.status==='available'&&<dl><dt>包声明版本</dt><dd>{installation.version}</dd><dt>许可证声明</dt><dd>{installation.license??'未提供'}</dd><dt>包清单 SHA-256</dt><dd>{installation.manifest_sha256}</dd><dt>CLI 入口 SHA-256</dt><dd>{installation.cli_entry_sha256}</dd></dl>}
    <p className="wb-hint">安装观察基于当前用户 profile 内的 package.json 与 CLI 入口文件，版本取自包声明。许可证声明保留给原安装审核流程。</p>
   </div>}
   <p className="wb-hint">显示原角色 MCP 注册表中按名称、命令或包参数匹配的连接及已发现目录状态。可在此角色的 MCP 连接面板配置、重载及审核工具。PRD 文件绑定继续检查原任务准备度。</p>
   {resource.data&&!taskmaster?.registry_available&&<p className="wb-status">MCP 注册表状态尚不可读取。</p>}
   {taskmaster?.registry_available&&taskmaster.connections.length===0&&<p className="wb-status">此角色尚未配置匹配的 Taskmaster MCP 连接。</p>}
   {taskmaster?.registry_available&&taskmaster.connections.length>0&&<ul>{taskmaster.connections.map(connection=><li key={connection.connection_id}>
      {connection.server_name} · v{connection.version} · {connection.enabled?'已启用':'已禁用'} · {connection.state} · 已发现代次 {connection.active_generation} · 已批准工具 {connection.approved_tool_count}
      {connection.pending_generation!==null&&` · 待重载代次 ${connection.pending_generation}`}
     </li>)}</ul>}
   <p className="wb-hint">CLI 安装、运行版本检查及外部项目配置文件检测继续补齐。连接状态沿用原注册表的发现结果，执行时沿用原角色权限、运行身份和预算校验。</p>
  </details>
  {!executionReady&&<p className="wb-status" role="status">执行宿主尚未就绪；来源可查看，就绪后再预览绑定。</p>}
  {task.status!=='paused'&&<p className="wb-status" role="status">请先暂停原任务，并等待所有执行及未知结果核对完成。</p>}
  {resource.loading&&<p className="wb-status" role="status">正在读取来源与准备度…</p>}
  {resource.error&&<p className="wb-error" role="alert">{prdMessage(resource.error)}</p>}
  {recovery.error&&<p className="wb-error" role="alert">{recovery.error}</p>}
  {resource.data&&!resource.data.readiness.ready&&<p className="wb-status" role="status">暂不可绑定：{resource.data.readiness.reasons.map(prdMessage).join(' ')||'准备度尚未确认'}</p>}
  <div className="wb-actions"><button type="button" disabled={locked||resource.loading} onClick={refresh}>刷新来源与准备度</button></div>
  {resource.data?.truncated&&<p className="wb-hint">来源列表已截断，仅显示服务器返回的部分文件；未列出的来源不可直接填写绑定。</p>}
  {!resource.loading&&resource.data?.sources.length===0&&<p className="wb-empty">当前任务作用域没有可选的文本来源。</p>}
  <label>PRD 来源<select value={index} disabled={locked||unavailable} onChange={e=>{try{flow.choose(e.target.value);setIndex(e.target.value);setConfirmed(false);setError('');draw();}catch(e){setError(e instanceof Error?e.message:'来源不可用');}}}><option value="">选择精确版本的已有来源</option>{resource.data?.sources.map((source,i)=><option key={`${source.kind}:${source.kind==='logical_file'?source.path:source.artifact_id}:${source.version}:${source.sha256}`} value={i}>{source.name} · {source.kind==='upload'?'原始上传':'项目文件'} · v{source.version}</option>)}</select></label>
  {flow.selection&&<dl style={textStyle}><dt>来源版本</dt><dd>v{flow.selection.version}</dd><dt>SHA-256</dt><dd>{flow.selection.sha256}</dd></dl>}
  <button type="button" disabled={locked||unavailable||!flow.selection} onClick={()=>{setConfirmed(false);void operate(()=>flow.loadPreview(request));}}>{flow.busy&&!flow.pending?'正在读取预览…':'只读预览'}</button>
  {preview&&<><h5>精确预览</h5><dl style={textStyle}><dt>原任务 / 版本</dt><dd>{preview.task_id} / v{preview.task_version}</dd><dt>原执行角色 / 版本 / 权限纪元</dt><dd>{preview.role.agent_id} / v{preview.role.version} / {preview.role.capability_epoch}</dd><dt>来源 / 版本 / SHA-256</dt><dd>{preview.source.name} / v{preview.source.version} / {preview.source.sha256}</dd><dt>预览 SHA-256</dt><dd>{preview.preview_sha256}</dd></dl>
   <h5>PRD 原文</h5><pre aria-label="PRD 原文" style={textStyle}>{preview.content}</pre>
   <h5>完整任务目标</h5><pre aria-label="完整任务目标" style={textStyle}>{preview.objective}</pre>
   <label className="wb-checkbox"><input type="checkbox" checked={confirmed} disabled={locked||unavailable} onChange={e=>setConfirmed(e.target.checked)}/>我已阅读原文和完整目标，确认仅绑定此原暂停任务，不创建任务、不恢复或启动执行。</label>
  </>}
  {flow.pending&&<p className="wb-status" role="status">绑定结果尚未确认。保留原来源、请求内容和请求 key；确认回执前不能修改选择或离开，请重试原请求。</p>}
  {(preview||flow.pending)&&<button className="wb-primary" type="button" disabled={flow.busy||(!flow.pending&&(unavailable||!confirmed))} onClick={()=>void operate(()=>flow.bind(request,confirmed),true)}>{flow.busy&&flow.pending?'正在确认绑定…':flow.pending?'重试原绑定请求':'确认绑定原暂停任务'}</button>}
  {error&&<p className="wb-error" role="alert">{error}</p>}
  {binding&&<div role="status"><p>{flow.receipt?'已冻结绑定到原任务；任务保持暂停。':'原任务已有冻结的 PRD 绑定。'}</p><dl style={textStyle}><dt>绑定 / 修订</dt><dd>{binding.binding_id} / {binding.revision}</dd><dt>任务版本</dt><dd>{binding.task_version}</dd><dt>冻结原文 SHA-256</dt><dd>{binding.content_sha256}</dd><dt>冻结目标 SHA-256</dt><dd>{binding.objective_sha256}</dd></dl></div>}
 </section>;
}
