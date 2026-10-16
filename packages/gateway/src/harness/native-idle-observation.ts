/** Read-only evidence from the current Host, never an execution grant. */
export type NativeIdleObservation=Readonly<{
 protocol:1;session_id:string;basis:'live'|'cold'|'absent'|'unavailable';
 native_idle:'idle'|'busy'|'unknown';reason:string|null;observed_at:number;execution_authorized:false;
}>;
export function nativeIdleSessionId(value:unknown):asserts value is string{
 if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value))throw Error('native_idle_observation_invalid');
}
export function validateNativeIdleObservation(value:unknown,sessionId:string):NativeIdleObservation{
 nativeIdleSessionId(sessionId);
 const fail=()=>{throw Error('native_idle_observation_invalid');};
 if(!value||typeof value!=='object'||Array.isArray(value))return fail();
 const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='basis,execution_authorized,native_idle,observed_at,protocol,reason,session_id'||row.protocol!==1||row.session_id!==sessionId||row.execution_authorized!==false||!Number.isSafeInteger(row.observed_at)||(row.observed_at as number)<0)return fail();
 const {basis,native_idle:state,reason}=row;
 const valid=(basis==='live'||basis==='cold')&&(
  state==='idle'&&reason===null||
  state==='busy'&&(reason==='INPUT_PENDING'||reason==='GOAL_ARMED'||basis==='live'&&reason==='AGENT_RUNNING'||basis==='cold'&&reason==='PERSISTED_GOAL_ACTIVE')||
  state==='unknown'&&(reason==='STATE_CHANGED'||reason==='STATE_UNAVAILABLE'))||
  basis==='absent'&&state==='unknown'&&reason==='SESSION_MISSING'||
  basis==='unavailable'&&state==='unknown'&&reason==='STATE_UNAVAILABLE';
 if(!valid)return fail();
 return Object.freeze({...row}) as NativeIdleObservation;
}
