const messages={assessment_missing:'尚未评估',assessment_version_stale:'任务内容已变更，需要重新评估',assessment_expired:'评估已过期',assessment_observations_changed:'来源或执行状态已变化',task_not_active:'任务尚未启用',authorization_unknown:'需要确认授权',authorization_required:'需要授权',authorization_denied:'未获授权',authorization_unverified:'需要核验授权来源',understanding_unverified:'需要确认目标和验收条件',prerequisites_unknown:'需要确认前置条件',evidence_requirements_unknown:'需要明确验收证据',target_not_unique:'目标尚未唯一确定',capability_health_unknown:'需要确认可用能力'};
const prefixes={dependency_not_completed:'等待前置任务完成',dependency_evidence_missing:'前置任务缺少证据',evidence_missing:'需要补充证据',prerequisite_missing:'缺少前置条件',prerequisite_unverified:'前置条件待核验',capability_unverified:'能力待核验',capability_unavailable:'能力暂不可用',capability_degraded:'能力状态异常',capability_unknown:'能力状态待确认'};
export function readinessReason(reason){const [key,...rest]=String(reason).split(':');return messages[key]??(prefixes[key]?`${prefixes[key]}${rest.length?`：${rest.join(':')}`:''}`:'需要进一步确认');}
export function readinessPresentation(view){
 const score=view?.fresh===true&&Number.isFinite(view?.display?.readiness_score)?view.display.readiness_score:null;
 return {score,label:'执行准备度，供参考',reasons:[...new Set([...(view?.stale_reasons??[]),...(view?.latest?.uncertainty_reasons??[])])].map(readinessReason),
  completion:view?.display?.business_status==='completed'?(view?.display?.completion_confirmed?'已标记完成，有执行回执':'已标记完成，执行证据待核验'):null};
}
