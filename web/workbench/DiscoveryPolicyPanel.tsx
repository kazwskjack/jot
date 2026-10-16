import React,{useEffect,useRef,useState} from 'react';
import {taskDraftScope} from '../jot/client';
import {workbenchApi,pathId} from './client';
import {useResource} from './useResource';
import {useMutationReceipt} from './useMutationReceipt';
import {discoveryPolicyForm,discoveryPolicyInput,discoveryControlInput,discoveryPolicyMatches,discoveryScope} from './discovery-policy.mjs';
import type {Agent,DiscoveryPolicy} from './types';
import DiscoveryHistory from './DiscoveryHistory';
type Form={cooldown_seconds:string;recent_input_seconds:string;max_cycles:string};
type Command={path:string;method:string;body:any};
const states:Record<string,string>={off:'默认关闭',active:'策略已启用',paused:'已暂停',stopped:'已停止',revoked:'角色权限已变化'};
export function DiscoveryPolicySettings({agent,policy,form,ready,busy,pending,onChange,onSave,onControl}:{agent:Agent;policy:DiscoveryPolicy|null;form:Form;ready:boolean;busy:boolean;pending:boolean;onChange:(form:Form)=>void;onSave:(event:React.FormEvent)=>void;onControl:(action:string)=>void}){
 const state=policy?.effective_state??policy?.state??'off',roleCurrent=!policy||policy.role_version===agent.version&&policy.role_epoch===agent.capability_epoch;
 const blocked=busy||pending||!ready,unsupported=policy?.mode==='discover_and_work';
 return <><p role="status">{states[state]??'策略状态待确认'}{policy&&<> · 策略版本 {policy.version}</>}</p>
  <p className="wb-hint">只提出方案，不直接修改项目。目前尚未安装自动发现调度；保存或启用策略不代表后台已经开始执行。</p>
  {!roleCurrent&&<p className="wb-status">角色权限已变化，请核对当前职责与工具范围，重新保存策略后再明确启用。</p>}
  {unsupported&&<p className="wb-status">当前保存的是工作执行模式，此面板不改写它；仍可暂停或停止。</p>}
  <form className="wb-form" aria-label="项目发现策略" onSubmit={onSave}><fieldset className="wb-input-fields" disabled={blocked||unsupported}>
   <label>发现模式<input readOnly value="只提出方案"/></label>
   <div className="wb-form-grid"><label>两轮之间的冷却时间（整秒）<input inputMode="numeric" required pattern="[0-9]+" value={form.cooldown_seconds} onChange={event=>onChange({...form,cooldown_seconds:event.target.value})}/></label>
   <label>用户输入后的等待时间（整秒）<input inputMode="numeric" required pattern="[0-9]+" value={form.recent_input_seconds} onChange={event=>onChange({...form,recent_input_seconds:event.target.value})}/></label></div>
   <label>最多发现轮次<input inputMode="numeric" pattern="[0-9]+" value={form.max_cycles} placeholder="留空为不限次数" onChange={event=>onChange({...form,max_cycles:event.target.value})}/></label>
   <p className="wb-hint">轮次留空为不限次数。模型额度和执行权限单独校验；保存不会自动启用。已启用策略保存后更新其规则。</p>
   <button className="wb-primary" disabled={blocked||unsupported} type="submit">保存策略</button>
  </fieldset></form>
  {pending?<p className="wb-status">原请求结果待确认，请重试原请求；暂不能发起其他修改。</p>:policy&&<div className="wb-actions">
   {state==='active'?<button disabled={blocked} onClick={()=>onControl('pause')}>暂停策略</button>:<button disabled={blocked||!roleCurrent||agent.status!=='active'||unsupported} onClick={()=>onControl('enable')}>{state==='paused'?'恢复策略':state==='revoked'?'重新启用策略':'启用策略'}</button>}
   {state!=='stopped'&&<button disabled={blocked} onClick={()=>onControl('stop')}>停止策略</button>}
  </div>}
 </>;
}
export default function DiscoveryPolicyPanel({agent,onClose,onChanged}:{agent:Agent;onClose:()=>void;onChanged:()=>void}){
 const ownerScope=taskDraftScope();let identity='';try{identity=discoveryScope(ownerScope,agent);}catch{}
 if(!identity)return <section className="wb-form" aria-label="项目发现"><h3>项目发现</h3><p role="alert">用户或角色范围尚未就绪，请重新读取工作台。</p><button onClick={onClose}>关闭项目发现</button></section>;
 return <ScopedPolicy key={identity} agent={agent} identity={identity} ownerScope={ownerScope} onClose={onClose} onChanged={onChanged}/>;
}
function ScopedPolicy({agent,identity,ownerScope,onClose,onChanged}:{agent:Agent;identity:string;ownerScope:string;onClose:()=>void;onChanged:()=>void}){
 const resource=useResource(signal=>workbenchApi.discoveryPolicy(agent.agent_id,signal),identity),mutation=useMutationReceipt();
 const [form,setForm]=useState<Form>(discoveryPolicyForm(null)),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const command=useRef<Command|null>(null),mounted=useRef(true),base=`/agents/${pathId(agent.agent_id)}/discovery-policy`;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const matches=resource.data?.policy===null||discoveryPolicyMatches(resource.data?.policy,agent),policy=matches?resource.data?.policy??null:null;
 const ready=!!resource.data&&matches&&!resource.loading&&!resource.error&&taskDraftScope()===ownerScope;
 useEffect(()=>{if(ready&&!mutation.pending)setForm(discoveryPolicyForm(policy));},[ready,policy?.version]);
 const execute=async(next?:Command)=>{
  if(busy)return;setError('');
  if(taskDraftScope()!==ownerScope||discoveryScope(taskDraftScope(),agent)!==identity){setError('用户范围已变化，请关闭并重新读取。');return;}
  if(!mutation.pending&&!ready){setError('请先重新读取当前策略。');return;}
  if(!mutation.pending)command.current=next??null;
  if(!command.current){setError('原请求不可用，请重新读取。');return;}
  setBusy(true);try{
   const result=await mutation.submit(command.current.path,command.current.method,command.current.body) as DiscoveryPolicy;
   if(!mounted.current||taskDraftScope()!==ownerScope)return;
   if(!discoveryPolicyMatches(result,agent))throw Error('策略回执归属不符，请重新读取。');
   command.current=null;resource.reload();onChanged();
  }catch(reason){if(mounted.current&&taskDraftScope()===ownerScope){setError(reason instanceof Error?reason.message:'操作未完成');if((reason as {status?:number})?.status===409){resource.reload();onChanged();}}}
  finally{if(mounted.current)setBusy(false);}
 };
 const prepare=(operation:()=>Command)=>{try{void execute(operation());}catch(reason){setError(reason instanceof Error?reason.message:'配置无效');}};
 return <section className="wb-form" aria-label={`项目发现：${agent.name}`}><div className="wb-form-head"><h3>「{agent.name}」的项目发现</h3><button disabled={busy||mutation.pending} onClick={onClose}>关闭项目发现</button></div>
  <p className="wb-hint">沿用当前角色、共同工作区和原任务预算。规划与验收继续由原 DSH 任务和目标链路负责。</p>
  {resource.loading&&<p role="status">正在读取策略…</p>}{resource.error&&<p className="wb-error" role="alert">{resource.error}</p>}{resource.data&&!matches&&<p className="wb-error" role="alert">策略归属不符，不显示其他角色的配置。</p>}{error&&<p className="wb-error" role="alert">{error}</p>}
  <DiscoveryPolicySettings agent={agent} policy={policy} form={form} ready={ready} busy={busy} pending={mutation.pending} onChange={setForm} onSave={event=>{event.preventDefault();prepare(()=>({path:base,method:'PATCH',body:discoveryPolicyInput(agent,policy,form)}));}} onControl={action=>prepare(()=>({path:base+'/control',method:'POST',body:discoveryControlInput(agent,policy,action)}))}/>
  <div className="wb-actions">{mutation.pending?<button disabled={busy} onClick={()=>void execute()}>重试原请求</button>:<button disabled={busy||resource.loading} onClick={resource.reload}>重新读取策略</button>}</div>
  <DiscoveryHistory agent={agent} identity={identity} ownerScope={ownerScope} disabled={busy||mutation.pending}/>
 </section>;
}
