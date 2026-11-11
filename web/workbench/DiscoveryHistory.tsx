import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {discoveryUiMessage} from './discovery-ui-messages';
import React,{useRef,useState} from 'react';
import {taskDraftScope} from '../jot/client';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {discoveryCyclePresentation,discoveryDetailMatches,discoveryCoverage} from './discovery-history.mjs';
import type {Agent,DiscoveryCycle,DiscoveryHistoryDetail,DiscoveryWorkCycle} from './types';
function CycleState({cycle}:{cycle:DiscoveryCycle}){
 const language=useApplicationLanguage(),t=useApplicationText(),view=discoveryCyclePresentation(cycle);
 return <p lang={language}>{t('执行状态：','Execution State: ')}{discoveryUiMessage(view.run,language)}{t(' · 业务状态：',' · Business State: ')}{discoveryUiMessage(view.business,language)} · <strong>{discoveryUiMessage(view.acceptance,language)}</strong></p>;
}
export function DiscoveryCycleReport({value}:{value:DiscoveryHistoryDetail}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const outcomes:Record<string,string>={proposals:t('已记录方案','Plans Recorded'),no_plan:t('未发现支持的改进方案','No Supported Improvement Plan Found'),blocked:t('发现过程受阻','Discovery Blocked')};
 const {cycle,report,plans}=value;
 return <><CycleState cycle={cycle}/><p className="wb-hint">{t("记录报告或执行结束不等于通过验收。历史记录不会授予新的执行权限；下方是提案，尚未应用。","Recording a report or ending execution does not mean acceptance passed. History grants no new execution permission; the proposals below have not been applied.")}</p>
  <small>{t("原轮次：","Original Cycle: ")}{cycle.occurrence_id}{t(" · 来源修订 "," · Source Revision ")}{cycle.signal_revision}</small>
  {report?<><h4>{outcomes[report.outcome]??t('报告状态待核对','Report State Unconfirmed')}</h4><p style={{whiteSpace:'pre-wrap'}}>{report.summary}</p><p>{discoveryUiMessage(discoveryCoverage(report.coverage),language)}</p><small>{t("报告：","Report: ")}{report.report_id} · {report.sha256}</small>
   {report.limitations.length>0&&<><h4>{t("读取范围与限制","Read Scope and Limitations")}</h4><ul>{report.limitations.map((item,index)=><li key={index}>{item}</li>)}</ul></>}
  </>:<p>{t("本轮尚无报告。","No report is available for this cycle yet.")}</p>}
  <h4>{t("方案预览","Plan Preview")}</h4>{plans.length?<div className="wb-message-list">{plans.map(plan=><article key={plan.plan_id}><h4>{plan.summary}</h4><p style={{whiteSpace:'pre-wrap'}}>{plan.rationale}</p><small>{t("方案：","Plan: ")}{plan.plan_id} · {plan.sha256}</small>
   {plan.changes.map((change,index)=><section key={index}><h5>{change.path}</h5><p>{change.description}</p><p>{t("拟执行步骤","Proposed Execution Steps")}</p><ol>{change.steps.map((step,i)=><li key={i}>{step}</li>)}</ol><p>{t("拟验收方式","Proposed Acceptance Method")}</p><ul>{change.verification.map((step,i)=><li key={i}>{step}</li>)}</ul></section>)}
   <details><summary>{t("原工具证据引用","Original Tool Evidence References")}</summary>{plan.evidence.map((evidence,index)=><p key={index}>{evidence.kind}{t('：',': ')}{evidence.reference}{evidence.hash&&<> · {evidence.hash}</>}</p>)}</details>
  </article>)}</div>:<p>{t("这一页没有方案。","There are no plans on this page.")}</p>}
 </>;
}
export default function DiscoveryHistory({agent,identity,ownerScope,disabled=false}:{agent:Agent;identity:string;ownerScope:string;disabled?:boolean}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>discoveryUiMessage(value,language);
 const [before,setBefore]=useState<string|undefined>(),[selected,setSelected]=useState<string|null>(null),[afterPlan,setAfterPlan]=useState<string|undefined>();
 const [creating,setCreating]=useState(false),[cycleError,setCycleError]=useState(''),[createdCycle,setCreatedCycle]=useState<DiscoveryWorkCycle|null>(null),cycleCommand=useRef<{material:string;key:string}|null>(null);
 const current=taskDraftScope()===ownerScope;
 const list=useResource(signal=>workbenchApi.discoveryHistory(agent.agent_id,before,signal),identity+':history:'+before,current),detail=useResource(signal=>workbenchApi.discoveryHistoryDetail(agent.agent_id,selected!,afterPlan,signal),identity+':detail:'+selected+':'+afterPlan,current&&!!selected);
 const policy=useResource(signal=>workbenchApi.discoveryPolicy(agent.agent_id,signal),identity+':discovery-policy:'+selected,current&&!!selected);
 const page=current&&!list.loading&&!list.error&&list.data?.execution_authorized===false&&Array.isArray(list.data.items)?list.data:null,value=current&&!detail.loading&&!detail.error&&selected&&discoveryDetailMatches(detail.data,selected)?detail.data:null;
 const activePolicy=policy.data?.execution_authorized===false?policy.data.policy:null,canCreateCycle=!!value&&value.cycle.accepted&&value.report?.outcome==='proposals'&&activePolicy?.state==='active'&&activePolicy.mode==='discover_and_work'&&!createdCycle;
 const close=()=>{setSelected(null);setAfterPlan(undefined);setCycleError('');setCreatedCycle(null);cycleCommand.current=null;};
 const createCycle=async(planId:string)=>{
  if(!value||!activePolicy||!canCreateCycle||creating)return;
  const input={report_sha256:value.report!.sha256,plan_ids:[planId],expected_policy_version:activePolicy.version,expected_role_version:activePolicy.role_version,expected_role_epoch:activePolicy.role_epoch},material=JSON.stringify([agent.agent_id,value.cycle.admission_id,input]);
  if(cycleCommand.current?.material!==material)cycleCommand.current={material,key:crypto.randomUUID()};
  setCreating(true);setCycleError('');
  try{const result=await workbenchApi.createDiscoveryWorkCycle(agent.agent_id,value.cycle.admission_id,input,cycleCommand.current.key);setCreatedCycle(result);cycleCommand.current=null;}
  catch(error){setCycleError(error instanceof Error?error.message:'创建工作周期失败');}
  finally{setCreating(false);}
 };
 if(!current)return <p lang={language} role="alert">{t("用户范围已变化，请重新打开项目发现。","The user scope changed. Reopen Project Discovery.")}</p>;
 return <section lang={language} aria-label={t('发现周期记录','Discovery Cycle History')}><h4>{t("发现周期记录","Discovery Cycle History")}</h4><p className="wb-hint">{t("仅查看原任务的来源修订、方案和报告。不显示来源正文，不应用项目修改。","Shows only the original task source revisions, plans and reports. Source body content is not displayed and project changes are not applied.")}</p>
  {!selected?<><button disabled={disabled||list.loading} onClick={list.reload}>{t("刷新发现记录","Refresh Discovery History")}</button>{list.loading&&<p role="status">{t("正在读取发现记录…","Reading Discovery History…")}</p>}{list.error&&<p className="wb-error" role="alert">{message(list.error)}</p>}
   <div className="wb-message-list">{page?.items.map(cycle=><article key={cycle.admission_id}><h5>{t("来源修订 ","Source Revision ")}{cycle.signal_revision}</h5><CycleState cycle={cycle}/><small>{new Date(cycle.created_at).toLocaleString()} · {cycle.admission_id}</small>{cycle.report&&<p>{cycle.report.summary}</p>}<button disabled={disabled||list.loading} onClick={()=>{setAfterPlan(undefined);setSelected(cycle.admission_id);}}>{t("查看本轮方案与报告","View This Cycle Plans and Report")}</button></article>)}</div>
   {!list.loading&&!list.error&&page&&!page.items.length&&<p>{t("尚无真实发现轮次。保存策略不等于已执行。","No actual discovery cycle is recorded yet. Saving a policy does not mean it executed.")}</p>}
   <div className="wb-actions">{before&&<button disabled={disabled||list.loading} onClick={()=>setBefore(undefined)}>{t("最新发现记录","Latest Discovery History")}</button>}{page?.next_before_id&&<button disabled={disabled||list.loading} onClick={()=>setBefore(page.next_before_id!)}>{t("更早发现记录","Earlier Discovery History")}</button>}</div>
  </>:<><div className="wb-actions"><button disabled={disabled} onClick={close}>{t("返回发现记录","Back to Discovery History")}</button><button disabled={disabled||detail.loading} onClick={detail.reload}>{t("重新读取本轮报告","Read This Cycle Report Again")}</button></div>{detail.loading&&<p role="status">{t("正在读取本轮报告…","Reading This Cycle Report…")}</p>}{detail.error&&<p className="wb-error" role="alert">{message(detail.error)}</p>}{detail.data&&!value&&!detail.loading&&<p role="alert">{t("报告与当前轮次不匹配，请重新读取。","The report does not match the current cycle. Read it again.")}</p>}
   {value&&<><DiscoveryCycleReport value={value}/>{policy.loading&&value.cycle.accepted&&value.report?.outcome==='proposals'&&<p role="status">{t("正在核对当前发现策略…","Checking Current Discovery Policy…")}</p>}{policy.error&&value.cycle.accepted&&value.report?.outcome==='proposals'&&<p className="wb-error" role="alert">{t("无法核对当前发现策略：","Cannot Check Current Discovery Policy: ")}{message(policy.error)}</p>}{!policy.loading&&!policy.error&&value.cycle.accepted&&value.report?.outcome==='proposals'&&(activePolicy?.state!=='active'||activePolicy.mode!=='discover_and_work')&&<p className="wb-hint">{t("当前发现策略未处于启用状态或未开启“发现并工作”，不能创建工作周期。","The current discovery policy is disabled or does not enable Discover and Work. A work cycle cannot be created.")}</p>}{createdCycle&&<p role="status">{t('已创建工作周期 ','Work Cycle Created: ')}{createdCycle.cycle_id}{t('；该方案尚未执行。','; this plan has not been executed.')}</p>}{cycleError&&<p className="wb-error" role="alert">{message(cycleError)}</p>}{value.cycle.accepted&&value.report?.outcome==='proposals'&&<div className="wb-message-list">{value.plans.map(plan=><article key={plan.plan_id}><button disabled={disabled||!canCreateCycle||creating||policy.loading} onClick={()=>void createCycle(plan.plan_id)}>{t("创建此方案的工作周期","Create a Work Cycle for This Plan")}</button></article>)}</div>}<div className="wb-actions">{afterPlan&&<button disabled={disabled||detail.loading} onClick={()=>setAfterPlan(undefined)}>{t("第一页方案","First Plan Page")}</button>}{value.next_after_plan_id&&<button disabled={disabled||detail.loading} onClick={()=>setAfterPlan(value.next_after_plan_id!)}>{t("下一页方案","Next Plan Page")}</button>}</div></>}
  </>}
 </section>;
}
