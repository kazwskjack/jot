import React,{useEffect,useRef,useState} from 'react';
import {readSkillCatalog,readSelectedSkillResource,readSelectedSkillDefinition,catalogForScope,type SkillCatalogResponse,type SkillCatalogState,type SkillResourceResponse,type SkillDefinitionResponse} from './skill-catalog-client';
type ResourceState={loading?:boolean;value?:SkillResourceResponse;error?:string};
type DefinitionState={loading?:boolean;value?:SkillDefinitionResponse;error?:string};
export function skillResourceErrorMessage(error:unknown){
 const code=error instanceof Error?error.message:'';
 if(code==='SKILL_CATALOG_NOT_FOUND')return '找不到该技能或相对路径，请检查输入后重试。';
 if(code==='SKILL_CATALOG_INPUT_INVALID'||code==='skill_catalog_invalid')return '技能资源路径或响应无效，请检查相对路径格式。';
 if(code==='SKILL_CATALOG_CHANGED'||code==='SKILL_CATALOG_SCOPE_CHANGED')return '技能目录或会话权限已变化，请刷新目录后重试。';
 if(code==='SKILL_RESOURCE_TOO_LARGE')return '所选资源超过可读取大小限制。';
 if(code==='SKILL_CATALOG_UNAVAILABLE'||error instanceof TypeError)return '技能资源服务或网络暂时不可用，请稍后重试。';
 if(error instanceof Error&&error.name==='AbortError')return '资源读取已取消，请重试。';
 return '技能资源读取失败，请重试；如果仍失败，请刷新技能目录。';
}
export function SkillCatalogView({value,paths,resources,definitions={},onPathChange,onReadResource,onReadDefinition,onUseSkill}:{
 value:SkillCatalogResponse;paths:Record<string,string>;resources:Record<string,ResourceState>;
 definitions?:Record<string,DefinitionState>;onReadDefinition?:(name:string)=>void;
 onPathChange:(name:string,path:string)=>void;onReadResource:(name:string)=>void;onUseSkill:(name:string)=>void;
}){
 return <section aria-label="当前会话技能目录"><h3>当前会话技能</h3>
  <p>工作区 {value.viewScope.workspace_id} · 项目 {value.viewScope.project_id} · 角色 {value.viewScope.agent_id}</p>
  <p>目录只显示元数据。资源读取只返回你选择的相对路径；内容按纯文本显示，不会执行。</p>
  {!value.complete?<p role="status">技能发现尚未完成，请重试。</p>:value.items.length===0?<p>当前会话没有可见技能。</p>:
   <ul>{value.items.map(item=>{const selected=resources[item.name],definition=definitions[item.name];return <li key={item.name}><strong>{item.name}</strong><p>{item.description}</p>
    {item.whenToUse&&<p>{item.whenToUse}</p>}
    <dl><dt>来源</dt><dd>{item.source} · {item.provider}</dd>
     <dt>调用范围</dt><dd>用户：{item.invocation.userInvocable?'可调用':'不可调用'} · 模型：{item.invocation.modelInvocable?'可调用':'不可调用'}</dd></dl>
    <label>资源相对路径 <input value={paths[item.name]??''} onChange={event=>onPathChange(item.name,event.target.value)} maxLength={512}/></label>
    <button type="button" disabled={!item.invocation.userInvocable||!paths[item.name]?.trim()||selected?.loading} onClick={()=>onReadResource(item.name)}>{selected?.loading?'正在读取…':'读取所选资源'}</button>
    <button type="button" disabled={!item.invocation.userInvocable} onClick={()=>onUseSkill(item.name)}>使用技能</button>
    {onReadDefinition&&<button type="button" disabled={!item.invocation.userInvocable||definition?.loading} onClick={()=>onReadDefinition(item.name)}>{definition?.loading?'正在读取详情…':'读取技能详情'}</button>}
    {definition?.error&&<p role="alert">{definition.error}</p>}
    {definition?.value&&<section aria-label={`${item.name} 技能详情`}>
     <p>定义来源 {definition.value.source} · {definition.value.provider}</p>
     <dl><dt>原生元数据版本</dt><dd>{definition.value.manifest.version??'未提供'}</dd>
      <dt>原生元数据许可证</dt><dd>{definition.value.manifest.license??'未提供'}</dd></dl>
     <p>正文 SHA-256 <code>{definition.value.bodySha256}</code></p>
     <p>定义 SHA-256 <code>{definition.value.definitionSha256}</code></p>
     <pre>{definition.value.content}</pre>
    </section>}
    {selected?.error&&<p role="alert">{selected.error}</p>}
    {selected?.value&&<section aria-label={`${item.name} 资源内容`}><p>只读文本 · SHA-256 <code>{selected.value.textSha256}</code></p><pre>{selected.value.text}</pre></section>}
   </li>})}</ul>}
  <section aria-label="当前会话原生命令"><h4>原生命令</h4>
   {!value.commands?.available?<p role="status">当前会话的原生命令目录暂不可用。</p>
    :value.commands.items.length===0?<p>当前会话没有注册命令。</p>
    :<ul>{value.commands.items.map(command=><li key={command.name}>
     <strong>/{command.name}</strong><p>{command.description}</p>
     {command.definitionId&&<p>定义 ID <code>{command.definitionId}</code></p>}
     {command.input&&<p>参数提示 {command.input.hint} · 附件{command.input.attachments?'可提交':'不可提交'}</p>}
    </li>)}</ul>}
  </section>
 </section>;
}
/** Root-owned RoleConversation mounting remains an explicit integration step. */
export default function SkillCatalogPanel({runId,ownerScope,onUseSkill}:{runId:string;ownerScope:string;onUseSkill:(name:string)=>void}){
 const [state,setState]=useState<SkillCatalogState|null>(null),[attempt,setAttempt]=useState(0),[paths,setPaths]=useState<Record<string,string>>({}),[resources,setResources]=useState<Record<string,ResourceState>>({});
 const [definitions,setDefinitions]=useState<Record<string,DefinitionState>>({});
 const current=catalogForScope(state,runId,ownerScope),pending=useRef(new Map<string,AbortController>());
 useEffect(()=>{const abort=new AbortController();let active=true;setState(null);setPaths({});setResources({});setDefinitions({});
  for(const item of pending.current.values())item.abort();pending.current.clear();
  void readSkillCatalog(runId,ownerScope,abort.signal).then(value=>{if(active)setState({runId,ownerScope,value});},()=>{if(active&&!abort.signal.aborted)setState({runId,ownerScope,error:true});});
  return()=>{active=false;abort.abort();for(const item of pending.current.values())item.abort();pending.current.clear();};
 },[runId,ownerScope,attempt]);
 const readResource=(name:string)=>{const path=paths[name]?.trim();if(!path)return;pending.current.get(name)?.abort();
  const abort=new AbortController();pending.current.set(name,abort);setResources(old=>({...old,[name]:{loading:true}}));
  void readSelectedSkillResource(runId,ownerScope,name,path,abort.signal).then(value=>{
   if(!abort.signal.aborted&&pending.current.get(name)===abort)setResources(old=>({...old,[name]:{value}}));
  },error=>{if(!abort.signal.aborted&&pending.current.get(name)===abort)setResources(old=>({...old,[name]:{error:skillResourceErrorMessage(error)}}));});
 };
 const readDefinition=(name:string)=>{
  const key='definition/'+name;pending.current.get(key)?.abort();
  const abort=new AbortController();pending.current.set(key,abort);setDefinitions(old=>({...old,[name]:{loading:true}}));
  void readSelectedSkillDefinition(runId,ownerScope,name,abort.signal).then(value=>{
   if(!abort.signal.aborted&&pending.current.get(key)===abort)setDefinitions(old=>({...old,[name]:{value}}));
  },error=>{if(!abort.signal.aborted&&pending.current.get(key)===abort)setDefinitions(old=>({...old,[name]:{error:skillResourceErrorMessage(error)}}));});
 };
 const changePath=(name:string,path:string)=>{pending.current.get(name)?.abort();pending.current.delete(name);setPaths(old=>({...old,[name]:path}));
  setResources(old=>{const next={...old};delete next[name];return next;});};
 return <div>{current?.error?<p role="alert">技能目录暂时不可用，请重试。</p>:current?.value?<SkillCatalogView value={current.value} paths={paths} resources={resources} definitions={definitions}
  onPathChange={changePath} onReadResource={readResource} onReadDefinition={readDefinition} onUseSkill={onUseSkill}/>:<p role="status">正在读取技能目录…</p>}
  <button type="button" onClick={()=>setAttempt(n=>n+1)}>刷新技能目录</button></div>;
}
