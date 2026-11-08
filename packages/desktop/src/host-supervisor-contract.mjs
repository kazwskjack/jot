export const supervisorScopeKeys=['ownerRefId','sessionId','operationId','releaseId','manifestSha256','runtimeSha256','instanceId','generation','restoredNonce'];
export const supervisorUuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const supervisorDigest=/^[a-f0-9]{64}$/;
export const record=value=>!!value&&Object.getPrototypeOf(value)===Object.prototype;
export const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function supervisorFail(){throw new Error('desktop_host_supervisor_scope_invalid');}
export function canonical(value){return value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';}
export function immutable(value){if(value&&typeof value==='object'){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;}
export function normalizeSupervisorScope(value){
 if(!exact(value,supervisorScopeKeys)||typeof value.ownerRefId!=='string'||!/^[a-zA-Z0-9._:-]{1,128}$/.test(value.ownerRefId)||
  !['sessionId','instanceId'].every(key=>supervisorUuid.test(value[key]??''))||
  !(value.operationId===null&&value.generation===null&&value.restoredNonce===null||supervisorUuid.test(value.operationId??''))||
  !/^[a-f0-9]{40,64}-[a-f0-9]{12}-desktop-electron$/.test(value.releaseId??'')||
  !supervisorDigest.test(value.manifestSha256??'')||!supervisorDigest.test(value.runtimeSha256??'')||
  !(value.generation===null&&value.restoredNonce===null||Number.isSafeInteger(value.generation)&&value.generation>0&&supervisorUuid.test(value.restoredNonce??'')))supervisorFail();
 return immutable({...value});
}
export function normalizeDrainReceipt(value,scope){
 if(!exact(value,['releaseId','instanceId','lifecyclePhase','backendClosedAt'])||value.releaseId!==scope.releaseId||
  value.instanceId!==scope.instanceId||value.lifecyclePhase!=='stopped'||typeof value.backendClosedAt!=='string'||
  !Number.isFinite(Date.parse(value.backendClosedAt))||new Date(value.backendClosedAt).toISOString()!==value.backendClosedAt)supervisorFail();
 return immutable({...value});
}
export function normalizeSupervisorDrain(value){
 if(!exact(value,['protocol','scope','requestId','state','receipt'])||value.protocol!==1||!supervisorUuid.test(value.requestId??'')||
  !['dispatched','stopped','unknown'].includes(value.state))supervisorFail();
 const scope=normalizeSupervisorScope(value.scope);
 if(value.state==='stopped'&&value.receipt===null||value.state!=='stopped'&&value.receipt!==null)supervisorFail();
 return immutable({...value,scope,receipt:value.receipt===null?null:normalizeDrainReceipt(value.receipt,scope)});
}
export function normalizeSupervisorEnvelope(value){
 let size;try{size=Buffer.byteLength(JSON.stringify(value));}catch{supervisorFail();}
 if(size>65536||!exact(value,['protocol','requestId','sequence','action','scope','payload'])||value.protocol!==1||
  !supervisorUuid.test(value.requestId??'')||!Number.isSafeInteger(value.sequence)||value.sequence<1||
  !['drain','ready','dispose'].includes(value.action)||!record(value.payload))supervisorFail();
 return immutable({...value,scope:normalizeSupervisorScope(value.scope),payload:JSON.parse(JSON.stringify(value.payload))});
}
