/** Pure advice over trusted observations. This module neither observes live
 * authorities nor admits work. A caller must collect and atomically revalidate
 * real scope, native state, permission, budget and reservation before dispatch.
 * No browser-provided snapshot or positive result grants execution permission. */
export type DiscoveryGateAdvice=Readonly<{protocol:1;eligible:boolean;reason:string|null;execution_authorized:false}>;
type Row=Record<string,unknown>;
const scopeKeys=['owner_id','project_id','workspace_id','agent_id'];
const policyKeys=['protocol','enabled','scope','revision','role_version','role_epoch','cooldown_ms','recent_input_ms'];
const observedKeys=['protocol','scope','policy_revision','role_version','role_epoch','observed_at','project_present','workspace_ready',
 'role_active','host_ready','native_idle','run_busy','last_user_input_at','last_completed_at','budget','background_slots',
 'dormant_at_revision','signal_revision','cycle_slots','reservation'];
const answer=(reason:string|null):DiscoveryGateAdvice=>Object.freeze({protocol:1,eligible:reason===null,reason,execution_authorized:false});
function exact(value:unknown,keys:string[]):value is Row{
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
}
function integer(value:unknown,minimum=0):value is number{return Number.isSafeInteger(value)&&Number(value)>=minimum;}
function scope(value:unknown):value is Row{
 return exact(value,scopeKeys)&&scopeKeys.every(key=>typeof value[key]==='string'&&String(value[key]).trim().length>0&&String(value[key]).length<=256&&!/[\u0000-\u001f\u007f]/.test(String(value[key])));
}
function nullableCount(value:unknown):boolean{return value===null||integer(value);}
function timestamp(value:unknown,now:number):boolean{return value===null||integer(value)&&Number(value)<=now;}

/** Protocol 1: eligibility for a future discovery occurrence, not work execution.
 * Empty/stale presence is never converted into a positive native-idle fact.
 * Budget and optional cycle limits come from existing owner policies; no hidden
 * daily/model/token cap or second budget ledger is introduced here. */
export function evaluateDiscoveryGates(policy:unknown,observation:unknown,clock:unknown):DiscoveryGateAdvice{
 if(!exact(policy,policyKeys)||!exact(observation,observedKeys)||!exact(clock,['now','max_age_ms'])
  ||policy.protocol!==1||observation.protocol!==1||typeof policy.enabled!=='boolean'
  ||!scope(policy.scope)||!scope(observation.scope)||!integer(clock.now)||!integer(clock.max_age_ms,1)
  ||!['revision','role_version','role_epoch'].every(key=>integer(policy[key],1))
  ||!['cooldown_ms','recent_input_ms'].every(key=>integer(policy[key]))
  ||!['policy_revision','role_version','role_epoch'].every(key=>integer(observation[key],1))
  ||!['observed_at','signal_revision','background_slots'].every(key=>integer(observation[key]))
  ||!['project_present','workspace_ready','role_active','host_ready','run_busy'].every(key=>typeof observation[key]==='boolean')
  ||typeof observation.native_idle!=='string'||!['idle','busy','unknown'].includes(observation.native_idle)
  ||typeof observation.budget!=='string'||!['allowed','blocked','unknown'].includes(observation.budget)
  ||typeof observation.reservation!=='string'||!['available','held','unknown'].includes(observation.reservation)
  ||!timestamp(observation.last_user_input_at,clock.now)||!timestamp(observation.last_completed_at,clock.now)
  ||!nullableCount(observation.dormant_at_revision)||!nullableCount(observation.cycle_slots)
  ||observation.dormant_at_revision!==null&&Number(observation.dormant_at_revision)>Number(observation.signal_revision))return answer('SNAPSHOT_INVALID');
 if(!policy.enabled)return answer('POLICY_DISABLED');
 const expectedScope=policy.scope,observedScope=observation.scope;
 if(scopeKeys.some(key=>expectedScope[key]!==observedScope[key]))return answer('SCOPE_CHANGED');
 if(policy.revision!==observation.policy_revision||policy.role_version!==observation.role_version||policy.role_epoch!==observation.role_epoch)return answer('AUTHORITY_CHANGED');
 const now=clock.now;
 if(Number(observation.observed_at)>now||now-Number(observation.observed_at)>Number(clock.max_age_ms))return answer('OBSERVATION_STALE');
 if(!observation.project_present)return answer('PROJECT_MISSING');
 if(!observation.workspace_ready)return answer('WORKSPACE_UNAVAILABLE');
 if(!observation.role_active)return answer('ROLE_UNAVAILABLE');
 if(observation.dormant_at_revision!==null&&observation.dormant_at_revision===observation.signal_revision)return answer('DORMANT_NO_SIGNAL');
 if(!observation.host_ready)return answer('HOST_UNAVAILABLE');
 if(observation.run_busy||observation.native_idle==='busy')return answer('AGENT_BUSY');
 if(observation.native_idle!=='idle')return answer('NATIVE_IDLE_UNCONFIRMED');
 if(observation.last_user_input_at!==null&&now-Number(observation.last_user_input_at)<Number(policy.recent_input_ms))return answer('RECENT_USER_INPUT');
 if(observation.last_completed_at!==null&&now-Number(observation.last_completed_at)<Number(policy.cooldown_ms))return answer('COOLDOWN');
 if(observation.budget==='unknown')return answer('BUDGET_UNCONFIRMED');
 if(observation.budget!=='allowed')return answer('BUDGET_BLOCKED');
 if(observation.background_slots===0)return answer('BACKGROUND_CAPACITY');
 if(observation.cycle_slots===0)return answer('CYCLE_FULL');
 if(observation.reservation==='held')return answer('RESERVATION_HELD');
 if(observation.reservation!=='available')return answer('RESERVATION_UNCONFIRMED');
 return answer(null);
}
