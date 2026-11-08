import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {assertHostSettingsControlSchema,parseHostSettingsFenceBinding, type HostSettingsFenceScopeV1} from './settings-control-schema.ts';

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const TABLES=['ga_host_settings_operations','ga_host_settings_versions','ga_host_settings_admission_gate','ga_host_settings_admissions'];

function hasAnyControlTable(db:DatabaseSync){
 return TABLES.some(name=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function activeRuns(db:DatabaseSync):number|null{
 try{
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_runs'").get())return null;
  const value=(db.prepare("SELECT count(*) AS n FROM ga_runs WHERE status IN ('starting','running','waiting_user','waiting_approval','cancelling')").get() as {n:unknown}).n;
  return Number.isSafeInteger(value)&&Number(value)>=0?Number(value):null;
 }catch{return null;}
}
function activeAdmissions(db:DatabaseSync,excludeId:string){
 const value=(db.prepare('SELECT count(*) AS n FROM ga_host_settings_admissions WHERE admission_id<>?').get(excludeId) as {n:unknown}).n;
 return Number.isSafeInteger(value)&&Number(value)>=0?Number(value):null;
}
function hasAdmission(db:DatabaseSync,id:string){return Boolean(db.prepare('SELECT 1 FROM ga_host_settings_admissions WHERE admission_id=?').get(id));}
function bindingFor(scope:unknown,admissionId:string){
 try{return parseHostSettingsFenceBinding(JSON.stringify({scope,activity_admission_id:admissionId}));}catch{return undefined;}
}
function baselineMatches(db:DatabaseSync,scope:HostSettingsFenceScopeV1){
 const row=db.prepare('SELECT settings_version,dsh_revision,schema_fingerprint,settings_sha256,reconciliation_sha256 FROM ga_host_settings_versions WHERE owner_id=? AND profile_id=? AND namespace=?')
  .get(scope.owner_id,scope.profile_id,scope.namespace) as {settings_version:unknown;dsh_revision:unknown;schema_fingerprint:unknown;settings_sha256:unknown;reconciliation_sha256:unknown}|undefined;
 return Boolean(row&&Number.isSafeInteger(row.settings_version)&&Number(row.settings_version)===scope.expected_version
  &&Number.isSafeInteger(row.dsh_revision)&&Number(row.dsh_revision)===scope.expected_dsh_revision
  &&row.schema_fingerprint===scope.expected_schema_fingerprint&&row.settings_sha256===scope.base_settings_sha256
  &&typeof row.reconciliation_sha256==='string'&&HASH.test(row.reconciliation_sha256));
}
function matchesFence(db:DatabaseSync,row:{state:string;fence_id:string|null;scope_json:string|null},fenceId:string,admissionId:string){
 const binding=parseHostSettingsFenceBinding(row.scope_json);
 return row.state==='closed'&&row.fence_id===fenceId&&typeof row.fence_id==='string'&&UUID.test(row.fence_id)
  &&binding?.activity_admission_id===admissionId&&hasAdmission(db,admissionId);
}

/** No Host controls means the feature is absent; any partial or invalid control state fails closed. */
export function hostSettingsAdmissionIsClosed(db:DatabaseSync):boolean{
 if(!hasAnyControlTable(db))return false;
 try{assertHostSettingsControlSchema(db);return (db.prepare('SELECT state FROM ga_host_settings_admission_gate WHERE gate_id=1').get() as {state:string}).state!=='open';}
 catch{return true;}
}

export function createHostSettingsAdmissionFenceStore(db:DatabaseSync){
 assertHostSettingsControlSchema(db);
 return Object.freeze({
  beginAdmission(){
   return withImmediateTransaction(db,()=>{
    if(hostSettingsAdmissionIsClosed(db))return{kind:'closed' as const};
    const admissionId=randomUUID();db.prepare('INSERT INTO ga_host_settings_admissions(admission_id,started_at) VALUES(?,?)').run(admissionId,new Date().toISOString());
    return{kind:'admitted' as const,admission_id:admissionId};
   });
  },
  endAdmission(admissionId:string){
   if(typeof admissionId!=='string'||!UUID.test(admissionId))return false;
   return withImmediateTransaction(db,()=>{
    assertHostSettingsControlSchema(db);
    const gate=db.prepare('SELECT state,fence_id,scope_json FROM ga_host_settings_admission_gate WHERE gate_id=1').get() as {state:string;fence_id:string|null;scope_json:string|null};
    if(gate.state==='closed'&&parseHostSettingsFenceBinding(gate.scope_json)?.activity_admission_id===admissionId)return false;
    return db.prepare('DELETE FROM ga_host_settings_admissions WHERE admission_id=?').run(admissionId).changes===1;
   });
  },
  close(scope:unknown,admissionId:string){
   if(typeof admissionId!=='string'||!UUID.test(admissionId))return{kind:'unavailable' as const};
   const binding=bindingFor(scope,admissionId);if(!binding)return{kind:'unavailable' as const};
   return withImmediateTransaction(db,()=>{
    try{assertHostSettingsControlSchema(db);}catch{return{kind:'unavailable' as const};}
    const row=db.prepare('SELECT state FROM ga_host_settings_admission_gate WHERE gate_id=1').get() as {state:string};
    if(row.state!=='open')return{kind:'busy' as const};
    if(!hasAdmission(db,admissionId)||!baselineMatches(db,binding.scope))return{kind:'unavailable' as const};
    const externalAdmissions=activeAdmissions(db,admissionId),runs=activeRuns(db);
    if(externalAdmissions===null||runs===null)return{kind:'unavailable' as const};
    if(externalAdmissions!==0||runs!==0)return{kind:'busy' as const,active_admissions:externalAdmissions,active_runs:runs};
    const fenceId=randomUUID(),changed=db.prepare("UPDATE ga_host_settings_admission_gate SET state='closed',fence_id=?,scope_json=?,updated_at=? WHERE gate_id=1 AND state='open'")
      .run(fenceId,JSON.stringify(binding),new Date().toISOString()).changes;
    if(changed!==1)return{kind:'busy' as const};
    return{kind:'closed' as const,fence_id:fenceId,active_admissions:0,active_runs:0};
   });
  },
  status(fenceId:string,admissionId:string){
   if(typeof fenceId!=='string'||!UUID.test(fenceId)||typeof admissionId!=='string'||!UUID.test(admissionId))return{kind:'unavailable' as const};
   return withImmediateTransaction(db,()=>{
    try{assertHostSettingsControlSchema(db);}catch{return{kind:'unavailable' as const};}
    const row=db.prepare('SELECT state,fence_id,scope_json FROM ga_host_settings_admission_gate WHERE gate_id=1').get() as {state:string;fence_id:string|null;scope_json:string|null};
    if(!matchesFence(db,row,fenceId,admissionId))return{kind:'stale' as const};
    const runs=activeRuns(db),admissions=activeAdmissions(db,admissionId);
    if(runs===null||admissions===null)return{kind:'unavailable' as const};
    return{kind:'closed' as const,fence_id:fenceId,active_admissions:admissions,active_runs:runs};
   });
  },
  release(fenceId:string,admissionId:string){
   if(typeof fenceId!=='string'||!UUID.test(fenceId)||typeof admissionId!=='string'||!UUID.test(admissionId))return false;
   return withImmediateTransaction(db,()=>{
    try{assertHostSettingsControlSchema(db);}catch{return false;}
    const row=db.prepare('SELECT state,fence_id,scope_json FROM ga_host_settings_admission_gate WHERE gate_id=1').get() as {state:string;fence_id:string|null;scope_json:string|null};
    if(!matchesFence(db,row,fenceId,admissionId))return false;
    if(activeAdmissions(db,admissionId)!==0||activeRuns(db)!==0)return false;
    return db.prepare("UPDATE ga_host_settings_admission_gate SET state='open',fence_id=NULL,scope_json=NULL,updated_at=? WHERE gate_id=1 AND state='closed' AND fence_id=?")
      .run(new Date().toISOString(),fenceId).changes===1;
   });
  }
 });
}
