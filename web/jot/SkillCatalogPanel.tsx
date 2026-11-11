import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import React,{useEffect,useRef,useState} from 'react';
import NativeCommandQueries from './NativeCommandQueries';
import SkillResourceBrowser from './SkillResourceBrowser';
import {readSkillCatalog,readSelectedSkillResource,readSelectedSkillDefinition,catalogForScope,type SkillCatalogResponse,type SkillCatalogState,type SkillResourceResponse,type SkillDefinitionResponse} from './skill-catalog-client';
type ResourceState={loading?:boolean;value?:SkillResourceResponse;error?:string};
type DefinitionState={loading?:boolean;value?:SkillDefinitionResponse;error?:string};
export function skillResourceErrorMessage(error:unknown){
 const code=error instanceof Error?error.message:'';
 if(code==='SKILL_SOURCE_MANIFEST_UNAVAILABLE')return '该技能未提供可沿当前权限读取的原始文件声明，可读取技能详情中的原生元数据。';
 if(code==='SKILL_CATALOG_NOT_FOUND')return '找不到该技能或相对路径，请检查输入后重试。';
 if(code==='SKILL_CATALOG_INPUT_INVALID'||code==='skill_catalog_invalid')return '技能资源路径或响应无效，请检查相对路径格式。';
 if(code==='SKILL_CATALOG_CHANGED'||code==='SKILL_CATALOG_SCOPE_CHANGED')return '技能目录或会话权限已变化，请刷新目录后重试。';
 if(code==='SKILL_RESOURCE_TOO_LARGE')return '所选资源超过可读取大小限制。';
 if(code==='SKILL_CATALOG_UNAVAILABLE'||error instanceof TypeError)return '技能资源服务或网络暂时不可用，请稍后重试。';
 if(error instanceof Error&&error.name==='AbortError')return '资源读取已取消，请重试。';
 return '技能资源读取失败，请重试；如果仍失败，请刷新技能目录。';
}
export function SkillCatalogView({value,paths,resources,definitions={},onPathChange,onReadResource,onReadDefinition,onBrowseSkill,onUseSkill}:{
 value:SkillCatalogResponse;paths:Record<string,string>;resources:Record<string,ResourceState>;
 definitions?:Record<string,DefinitionState>;onReadDefinition?:(name:string,includeSourceManifest?:boolean)=>void;
 onPathChange:(name:string,path:string)=>void;onReadResource:(name:string)=>void;onUseSkill:(name:string)=>void;
 onBrowseSkill?:(name:string)=>void;
}){
 const language=useApplicationLanguage(),t=useApplicationText();
 return <section lang={language} data-desktop-target="skills" tabIndex={-1} aria-label={t('当前会话技能目录','Current Conversation Skill Catalog')}><h3>{t('当前会话技能','Current Conversation Skills')}</h3>
  <p>{t('工作区','Workspace')} {value.viewScope.workspace_id} · {t('项目','Project')} {value.viewScope.project_id??t('未绑定','Unbound')} · {'kind' in value.viewScope
   ?t(`原生会话 ${value.viewScope.session_ref}`,`Native Session ${value.viewScope.session_ref}`):t(`角色 ${value.viewScope.agent_id}`,`Role ${value.viewScope.agent_id}`)}</p>
  <p>{t('目录只显示元数据。资源读取只返回你选择的相对路径；内容按纯文本显示，不会执行。','The catalog shows metadata only. Resource reads return only your selected relative path as plain text, without execution.')}</p>
  {!value.complete?<p role="status">{t('技能发现尚未完成，请重试。','Skill discovery has not completed. Retry.')}</p>:value.items.length===0?<p>{t('当前会话没有可见技能。','No skills are visible to this conversation.')}</p>:
   <ul>{value.items.map(item=>{const selected=resources[item.name],definition=definitions[item.name];return <li key={item.name}><strong>{item.name}</strong><p>{item.description}</p>
    {item.whenToUse&&<p>{item.whenToUse}</p>}
    <dl><dt>{t('来源','Source')}</dt><dd>{item.source} · {item.provider}</dd>
     <dt>{t('调用范围','Invocation Scope')}</dt><dd>{t('用户：','User: ')}{item.invocation.userInvocable?t('可调用','Allowed'):t('不可调用','Not Allowed')} · {t('模型：','Model: ')}{item.invocation.modelInvocable?t('可调用','Allowed'):t('不可调用','Not Allowed')}</dd></dl>
    <label>{t('资源相对路径','Resource Relative Path')} <input value={paths[item.name]??''} onChange={event=>onPathChange(item.name,event.target.value)} maxLength={512}/></label>
    <button type="button" disabled={!item.invocation.userInvocable||!paths[item.name]?.trim()||selected?.loading} onClick={()=>onReadResource(item.name)}>{selected?.loading?t('正在读取…','Reading…'):t('读取所选资源','Read Selected Resource')}</button>
    <button type="button" disabled={!item.invocation.userInvocable} onClick={()=>onUseSkill(item.name)}>{t('使用技能','Use Skill')}</button>
    {onBrowseSkill&&<button type="button" disabled={!item.invocation.userInvocable} onClick={()=>onBrowseSkill(item.name)}>{t('查看配套资源','View Supporting Resources')}</button>}
    {onReadDefinition&&<button type="button" disabled={!item.invocation.userInvocable||definition?.loading} onClick={()=>onReadDefinition(item.name)}>{definition?.loading?t('正在读取详情…','Reading details…'):t('读取技能详情','Read Skill Details')}</button>}
    {onReadDefinition&&<button type="button" disabled={!item.invocation.userInvocable||definition?.loading} onClick={()=>onReadDefinition(item.name,true)}>{t('读取原始声明','Read Original Manifest')}</button>}
    {definition?.error&&<p role="alert">{conversationUiError(definition.error,language)}</p>}
    {definition?.value&&<section aria-label={t(`${item.name} 技能详情`,`${item.name} Skill Details`)}>
     <p>{t('定义来源','Definition Source')} {definition.value.source} · {definition.value.provider}</p>
     <dl><dt>{t('原生元数据版本','Native Metadata Version')}</dt><dd>{definition.value.manifest.version??t('未提供','Not Provided')}</dd>
      <dt>{t('原生元数据许可证','Native Metadata License')}</dt><dd>{definition.value.manifest.license??t('未提供','Not Provided')}</dd></dl>
     {definition.value.manifest.original&&<>
      <dl><dt>{t('文件顶层版本','File Top-level Version')}</dt><dd>{definition.value.manifest.original.version??t('未提供','Not Provided')}</dd>
       <dt>{t('文件顶层许可证','File Top-level License')}</dt><dd>{definition.value.manifest.original.license??t('未提供','Not Provided')}</dd></dl>
      <p>{t('原始声明','Original Manifest')} SHA-256 <code>{definition.value.manifest.original.textSha256}</code></p>
     </>}
     <p>{t('正文','Body')} SHA-256 <code>{definition.value.bodySha256}</code></p>
     <p>{t('定义','Definition')} SHA-256 <code>{definition.value.definitionSha256}</code></p>
     <pre>{definition.value.content}</pre>
    </section>}
    {selected?.error&&<p role="alert">{conversationUiError(selected.error,language)}</p>}
    {selected?.value&&<section aria-label={t(`${item.name} 资源内容`,`${item.name} Resource Content`)}><p>{t('只读文本','Read-only Text')} · SHA-256 <code>{selected.value.textSha256}</code></p><pre>{selected.value.text}</pre></section>}
   </li>})}</ul>}
  <section aria-label={t('当前会话原生命令','Current Conversation Native Commands')}><h4>{t('原生命令','Native Commands')}</h4>
   {!value.commands?.available?<p role="status">{t('当前会话的原生命令目录暂不可用。','The native command catalog for this conversation is unavailable.')}</p>
    :value.commands.items.length===0?<p>{t('当前会话没有注册命令。','No commands are registered for this conversation.')}</p>
    :<ul>{value.commands.items.map(command=><li key={command.name}>
     <strong>/{command.name}</strong><p>{command.description}</p>
     {command.definitionId&&<p>{t('定义 ID','Definition ID')} <code>{command.definitionId}</code></p>}
     {command.input&&<p>{t('参数提示','Argument Hint')} {command.input.hint} · {t('附件','Attachments: ')}{command.input.attachments?t('可提交','Allowed'):t('不可提交','Not Allowed')}</p>}
    </li>)}</ul>}
  </section>
 </section>;
}
/** Root-owned RoleConversation mounting remains an explicit integration step. */
export default function SkillCatalogPanel({runId,ownerScope,onUseSkill}:{runId:string;ownerScope:string;onUseSkill:(name:string)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const [state,setState]=useState<SkillCatalogState|null>(null),[attempt,setAttempt]=useState(0),[paths,setPaths]=useState<Record<string,string>>({}),[resources,setResources]=useState<Record<string,ResourceState>>({});
 const [definitions,setDefinitions]=useState<Record<string,DefinitionState>>({});
 const [directorySkill,setDirectorySkill]=useState<string|null>(null);
 const current=catalogForScope(state,runId,ownerScope),pending=useRef(new Map<string,AbortController>());
 useEffect(()=>{const abort=new AbortController();let active=true;setState(null);setPaths({});setResources({});setDefinitions({});setDirectorySkill(null);
  for(const item of pending.current.values())item.abort();pending.current.clear();
  void readSkillCatalog(runId,ownerScope,abort.signal).then(value=>{if(active)setState({runId,ownerScope,value});},()=>{if(active&&!abort.signal.aborted)setState({runId,ownerScope,error:true});});
  return()=>{active=false;abort.abort();for(const item of pending.current.values())item.abort();pending.current.clear();};
 },[runId,ownerScope,attempt]);
 const readResource=(name:string,selectedPath?:string)=>{const path=(selectedPath??paths[name])?.trim();if(!path)return;pending.current.get(name)?.abort();
  if(selectedPath)setPaths(old=>({...old,[name]:path}));
  const abort=new AbortController();pending.current.set(name,abort);setResources(old=>({...old,[name]:{loading:true}}));
  void readSelectedSkillResource(runId,ownerScope,name,path,abort.signal).then(value=>{
   if(!abort.signal.aborted&&pending.current.get(name)===abort)setResources(old=>({...old,[name]:{value}}));
  },error=>{if(!abort.signal.aborted&&pending.current.get(name)===abort)setResources(old=>({...old,[name]:{error:skillResourceErrorMessage(error)}}));});
 };
 const readDefinition=(name:string,includeSourceManifest=false)=>{
  for(const [key,request] of pending.current){
   if(key.startsWith('definition/')){request.abort();pending.current.delete(key);}
  }
  const key='definition/'+name,abort=new AbortController();
  pending.current.set(key,abort);setDefinitions({[name]:{loading:true}});
  void readSelectedSkillDefinition(runId,ownerScope,name,abort.signal,includeSourceManifest).then(value=>{
   if(!abort.signal.aborted&&pending.current.get(key)===abort)setDefinitions({[name]:{value}});
  },error=>{if(!abort.signal.aborted&&pending.current.get(key)===abort)setDefinitions({[name]:{error:skillResourceErrorMessage(error)}});});
 };
 const changePath=(name:string,path:string)=>{pending.current.get(name)?.abort();pending.current.delete(name);setPaths(old=>({...old,[name]:path}));
  setResources(old=>{const next={...old};delete next[name];return next;});};
 return <div lang={language}>{current?.error?<p role="alert">{t('技能目录暂时不可用，请重试。','The skill catalog is unavailable. Retry.')}</p>:current?.value?
  <SkillCatalogView value={current.value} paths={paths} resources={resources} definitions={definitions}
   onPathChange={changePath} onReadResource={readResource} onReadDefinition={readDefinition} onBrowseSkill={setDirectorySkill} onUseSkill={onUseSkill}/>
 :<p role="status">{t('正在读取技能目录…','Reading skill catalog…')}</p>}
  {directorySkill&&current?.value&&<SkillResourceBrowser key={JSON.stringify([ownerScope,runId,directorySkill])}
   runId={runId} ownerScope={ownerScope} name={directorySkill} onRead={path=>readResource(directorySkill,path)} onClose={()=>setDirectorySkill(null)}/>}
  <NativeCommandQueries key={ownerScope+':'+runId} runId={runId} ownerScope={ownerScope}
   commands={current?.value?.commands?.items??[]} catalogSha256={current?.value?.catalogSha256??''}/>
  <NativeCommandQueries key={ownerScope+':'+runId+':plan'} runId={runId} ownerScope={ownerScope} planMode
   commands={current?.value?.commands?.items??[]} catalogSha256={current?.value?.catalogSha256??''}/>
  <button type="button" onClick={()=>setAttempt(n=>n+1)}>{t('刷新技能目录','Refresh Skill Catalog')}</button></div>;
}
