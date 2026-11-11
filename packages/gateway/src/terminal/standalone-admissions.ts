import type {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction,withReadTransaction} from '../db/database.ts';
import {ProjectRepository} from '../projects/repository.ts';
import {assertWorkspaceWritable} from '../workbench/workspace-coordination.ts';

type State='prepared'|'dispatched'|'ready'|'unknown'|'cancelled';
type Row={owner_id:string;request_id:string;workspace_id:string;authority_sha256:string;session_id:string;
 state:State;version:number;native_identity_sha256:string|null;created_at:string;updated_at:string;project_id?:string};
export type StandaloneTerminalAdmission=Row&{protocol:1;state_sha256:string;execution_authorized:false};
const id=(value:string)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const uuid=(value:string)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash=(value:string)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const columns='owner_id,request_id,workspace_id,authority_sha256,session_id,state,version,native_identity_sha256,created_at,updated_at';
const view=(row:Row):StandaloneTerminalAdmission=>({...row,protocol:1,state_sha256:createHash('sha256').update(canonicalJson(row)).digest('hex'),execution_authorized:false});
function projectScope(db:DatabaseSync,row:Row):Row{
 const binding=db.prepare('SELECT project_id FROM ga_standalone_terminal_projects WHERE owner_id=? AND request_id=?').get(row.owner_id,row.request_id) as {project_id:string}|undefined;
 return binding?{...row,project_id:binding.project_id}:row;
}
/** Metadata recovery stays available; new native operations must recheck original project ownership. */
export function assertStandaloneTerminalProject(db:DatabaseSync,admission:{owner_id:string;project_id?:string}){
 if(admission.project_id===undefined)return;
 if(!id(admission.project_id))throw Error('standalone_terminal_input_invalid');
 new ProjectRepository(db).assertOwned(admission.project_id,admission.owner_id);
 assertWorkspaceWritable(db,admission.owner_id,admission.project_id);
}
function source(db:DatabaseSync,owner:string,request:string){
 if(!id(owner)||!uuid(request))throw Error('standalone_terminal_input_invalid');
 const row=db.prepare('SELECT '+columns+' FROM ga_standalone_terminal_admissions WHERE owner_id=? AND request_id=?').get(owner,request) as Row|undefined;
 return row?projectScope(db,row):undefined;
}

/** Source metadata is supplied by trusted owner/workspace admission, never a browser cwd/preset. */
export function prepareStandaloneTerminalAdmission(db:DatabaseSync,input:{owner_id:string;request_id:string;workspace_id:string;authority_sha256:string;project_id?:string}){
 if(!id(input.owner_id)||!uuid(input.request_id)||(typeof input.workspace_id!=='string'||!input.workspace_id.trim()||input.workspace_id.length>4096||input.workspace_id.includes('\0'))||!hash(input.authority_sha256)||input.project_id!==undefined&&!id(input.project_id))throw Error('standalone_terminal_input_invalid');
 return withImmediateTransaction(db,()=>{
  const previous=source(db,input.owner_id,input.request_id);
  if(previous){
   if(previous.workspace_id!==input.workspace_id||previous.authority_sha256!==input.authority_sha256||previous.project_id!==input.project_id)throw Error('standalone_terminal_request_conflict');
   return view(previous);
  }
  assertStandaloneTerminalProject(db,input);
  const now=new Date().toISOString(),session='jot-standalone-'+randomUUID();
  db.prepare(`INSERT INTO ga_standalone_terminal_admissions (${columns}) VALUES(?,?,?,?,?,'prepared',1,NULL,?,?)`)
   .run(input.owner_id,input.request_id,input.workspace_id,input.authority_sha256,session,now,now);
  if(input.project_id!==undefined)db.prepare('INSERT INTO ga_standalone_terminal_projects(owner_id,request_id,project_id) VALUES(?,?,?)').run(input.owner_id,input.request_id,input.project_id);
  return view(source(db,input.owner_id,input.request_id)!);
 });
}
export function readStandaloneTerminalAdmission(db:DatabaseSync,owner:string,request:string){
 return withReadTransaction(db,()=>{const row=source(db,owner,request);return row?view(row):null;});
}
export type StandaloneTerminalAdmissionCatalog={protocol:1;items:StandaloneTerminalAdmission[];before_request_id:string|null;next_before_request_id:string|null;execution_authorized:false};
/** Original owned/configured scope, newest first with a stable timestamp/request keyset. */
export function listStandaloneTerminalAdmissions(db:DatabaseSync,owner:string,workspaces:readonly string[],before:string|null):StandaloneTerminalAdmissionCatalog{
 if(!id(owner)||before!==null&&!uuid(before)||!Array.isArray(workspaces)||workspaces.some(value=>typeof value!=='string'||!value.trim()||value.length>4096||value.includes('\0')))throw Error('standalone_terminal_input_invalid');
 return withReadTransaction(db,()=>{
  const allowed=JSON.stringify([...new Set(workspaces)]);
  const boundary=before===null?null:db.prepare(`SELECT created_at FROM ga_standalone_terminal_admissions
   WHERE owner_id=? AND request_id=? AND workspace_id IN (SELECT value FROM json_each(?))`).get(owner,before,allowed) as {created_at:string}|undefined;
  if(before!==null&&!boundary)throw Error('standalone_terminal_catalog_cursor_invalid');
  const rows=db.prepare('SELECT '+columns+` FROM ga_standalone_terminal_admissions
   WHERE owner_id=? AND workspace_id IN (SELECT value FROM json_each(?))
    AND (? IS NULL OR created_at<? OR (created_at=? AND request_id<?))
   ORDER BY created_at DESC,request_id DESC LIMIT 51`).all(owner,allowed,boundary?.created_at??null,boundary?.created_at??null,boundary?.created_at??null,before) as Row[];
  const items=rows.slice(0,50).map(row=>view(projectScope(db,row)));
  return{protocol:1,items,before_request_id:before,next_before_request_id:rows.length>50?items.at(-1)!.request_id:null,execution_authorized:false};
 });
}

type Expected={owner_id:string;request_id:string;expected_version:number;expected_state_sha256:string;authority_sha256:string};
function transition(db:DatabaseSync,input:Expected,next:State,nativeIdentity:string|null){
 if(!Number.isSafeInteger(input.expected_version)||input.expected_version<1||!hash(input.expected_state_sha256)||!hash(input.authority_sha256))throw Error('standalone_terminal_input_invalid');
 return withImmediateTransaction(db,()=>{
  const row=source(db,input.owner_id,input.request_id);
  if(!row)throw Error('standalone_terminal_admission_missing');
  if(row.authority_sha256!==input.authority_sha256)throw Error('standalone_terminal_authority_changed');
  if(row.version!==input.expected_version||view(row).state_sha256!==input.expected_state_sha256)throw Error('standalone_terminal_state_changed');
  const allowed=row.state==='prepared'&&(next==='dispatched'||next==='cancelled')
   ||row.state==='dispatched'&&(next==='ready'||next==='unknown')||row.state==='unknown'&&next==='ready';
  if(!allowed||(next==='ready'?!hash(nativeIdentity!):nativeIdentity!==null))throw Error('standalone_terminal_transition_invalid');
  db.prepare(`UPDATE ga_standalone_terminal_admissions SET state=?,native_identity_sha256=?,version=version+1,updated_at=? WHERE owner_id=? AND request_id=? AND version=?`)
   .run(next,nativeIdentity,new Date().toISOString(),input.owner_id,input.request_id,input.expected_version);
  return view(source(db,input.owner_id,input.request_id)!);
 });
}
/** A durable claim precedes native I/O. Reads and unknown-result observation never reclaim it. */
export function claimStandaloneTerminalAdmission(db:DatabaseSync,input:Expected){return transition(db,input,'dispatched',null);}
export function cancelStandaloneTerminalAdmission(db:DatabaseSync,input:Expected){return transition(db,input,'cancelled',null);}
export function markStandaloneTerminalUnknown(db:DatabaseSync,input:Expected){return transition(db,input,'unknown',null);}
/** Caller must validate the original authenticated native Session identity before recording this witness. */
export function confirmStandaloneTerminalAdmission(db:DatabaseSync,input:Expected&{session_id:string;native_identity_sha256:string}){
 if(!id(input.session_id)||!hash(input.native_identity_sha256))throw Error('standalone_terminal_input_invalid');
 return withImmediateTransaction(db,()=>{
  const row=source(db,input.owner_id,input.request_id);
  if(row?.session_id!==input.session_id)throw Error('standalone_terminal_native_identity_changed');
  return transition(db,input,'ready',input.native_identity_sha256);
 });
}

/** The authenticated native producer takes this durable, single-use I/O fence before SDK admission. */
export function claimStandaloneNativeAttempt(db:DatabaseSync,input:Expected&{session_id:string}){
 if(!id(input.session_id)||!hash(input.authority_sha256)||!Number.isSafeInteger(input.expected_version)||input.expected_version<1||!hash(input.expected_state_sha256))throw Error('standalone_terminal_input_invalid');
 return withImmediateTransaction(db,()=>{
  const row=source(db,input.owner_id,input.request_id);
  if(!row)throw Error('standalone_terminal_admission_missing');
  if(row.session_id!==input.session_id||row.authority_sha256!==input.authority_sha256)throw Error('standalone_terminal_authority_changed');
  const previous=db.prepare('SELECT session_id,authority_sha256 FROM ga_standalone_terminal_native_attempts WHERE owner_id=? AND request_id=?')
   .get(input.owner_id,input.request_id) as {session_id:string;authority_sha256:string}|undefined;
  const result=(allowed:boolean)=>({protocol:1 as const,owner_id:row.owner_id,request_id:row.request_id,session_id:row.session_id,
   authority_sha256:row.authority_sha256,create_allowed:allowed,execution_authorized:false as const});
  if(previous){if(previous.session_id!==row.session_id||previous.authority_sha256!==row.authority_sha256)throw Error('standalone_terminal_authority_changed');return result(false);}
  if(row.state!=='dispatched'||row.version!==input.expected_version||view(row).state_sha256!==input.expected_state_sha256)throw Error('standalone_terminal_state_changed');
  assertStandaloneTerminalProject(db,row);
  db.prepare('INSERT INTO ga_standalone_terminal_native_attempts(owner_id,request_id,session_id,authority_sha256,attempted_at) VALUES(?,?,?,?,?)')
   .run(row.owner_id,row.request_id,row.session_id,row.authority_sha256,new Date().toISOString());
  return result(true);
 });
}
