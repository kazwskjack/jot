import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction,withReadTransaction} from '../db/database.ts';
import {readStandaloneTerminalAdmission,type StandaloneTerminalAdmission} from './standalone-admissions.ts';
import {validateTerminalCommand,validateTerminalReceipt,type TerminalCommand,type TerminalReceipt} from './control.js';

type Row={owner_id:string;admission_id:string;request_id:string;command_sha256:string;command_json:string;
 admission_state_sha256:string;native_attempted_at:string|null;receipt_json:string|null};
export const standaloneTerminalCommandHash=(command:TerminalCommand)=>createHash('sha256').update(canonicalJson(validateTerminalCommand(command))).digest('hex');
function current(db:DatabaseSync,admission:StandaloneTerminalAdmission){
 const row=readStandaloneTerminalAdmission(db,admission.owner_id,admission.request_id);
 if(!row||row.state!=='ready'||row.state_sha256!==admission.state_sha256)throw Error('standalone_terminal_state_changed');
}
function row(db:DatabaseSync,admission:StandaloneTerminalAdmission,command:TerminalCommand){
 const saved=db.prepare('SELECT * FROM ga_standalone_terminal_commands WHERE owner_id=? AND admission_id=? AND request_id=?')
  .get(admission.owner_id,admission.request_id,command.request_id) as Row|undefined;
 if(saved&&(saved.command_sha256!==standaloneTerminalCommandHash(command)||saved.command_json!==canonicalJson(command)
  ||saved.admission_state_sha256!==admission.state_sha256))throw Error('standalone_terminal_command_conflict');
 return saved;
}
export function reserveStandaloneTerminalCommand(db:DatabaseSync,admission:StandaloneTerminalAdmission,input:TerminalCommand){
 const command=validateTerminalCommand(input);
 return withImmediateTransaction(db,()=>{
  current(db,admission);const previous=row(db,admission,command);
  if(previous)return{fresh:false};
  db.prepare(`INSERT INTO ga_standalone_terminal_commands(owner_id,admission_id,request_id,command_sha256,command_json,
   admission_state_sha256,native_attempted_at,receipt_json,created_at) VALUES(?,?,?,?,?,?,NULL,NULL,?)`)
   .run(admission.owner_id,admission.request_id,command.request_id,standaloneTerminalCommandHash(command),canonicalJson(command),admission.state_sha256,new Date().toISOString());
  return{fresh:true};
 });
}
export function readStandaloneTerminalCommandReceipt(db:DatabaseSync,admission:StandaloneTerminalAdmission,input:TerminalCommand):TerminalReceipt{
 const command=validateTerminalCommand(input);
 return withReadTransaction(db,()=>{
  current(db,admission);const saved=row(db,admission,command);
  if(saved?.receipt_json)return validateTerminalReceipt(JSON.parse(saved.receipt_json),command,admission.session_id);
  return validateTerminalReceipt({protocol:1,session_id:admission.session_id,host_instance:command.host_instance,request_id:command.request_id,
   state:saved?'unknown':'not_admitted',inventory:null,rejection:null,execution_authorized:false},command,admission.session_id);
 });
}
export function settleStandaloneTerminalCommand(db:DatabaseSync,admission:StandaloneTerminalAdmission,input:TerminalCommand,receipt:TerminalReceipt){
 const command=validateTerminalCommand(input),value=validateTerminalReceipt(receipt,command,admission.session_id);
 if(!['completed','rejected','wait_ended_unknown'].includes(value.state))throw Error('terminal_receipt_invalid');
 return withImmediateTransaction(db,()=>{
  current(db,admission);const saved=row(db,admission,command);
  if(!saved)throw Error('standalone_terminal_command_missing');
  if(saved.receipt_json)return validateTerminalReceipt(JSON.parse(saved.receipt_json),command,admission.session_id);
  if(value.state!=='wait_ended_unknown'&&saved.native_attempted_at===null)throw Error('terminal_receipt_invalid');
  db.prepare('UPDATE ga_standalone_terminal_commands SET receipt_json=? WHERE owner_id=? AND admission_id=? AND request_id=? AND receipt_json IS NULL')
   .run(JSON.stringify(value),admission.owner_id,admission.request_id,command.request_id);
  return value;
 });
}
export type StandaloneTerminalCommandAttempt={owner_id:string;admission_id:string;request_id:string;admission_state_sha256:string;command_sha256:string};
/** Native dispatch must take this durable fence even when its authenticated HTTP packet is replayed. */
export function claimStandaloneTerminalCommandAttempt(db:DatabaseSync,input:StandaloneTerminalCommandAttempt){
 if(typeof input.owner_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.owner_id)
  ||![input.admission_id,input.request_id].every(value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
  ||![input.admission_state_sha256,input.command_sha256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw Error('standalone_terminal_input_invalid');
 return withImmediateTransaction(db,()=>{
  const admission=readStandaloneTerminalAdmission(db,input.owner_id,input.admission_id);
  if(!admission||admission.state!=='ready'||admission.state_sha256!==input.admission_state_sha256)throw Error('standalone_terminal_state_changed');
  const saved=db.prepare('SELECT * FROM ga_standalone_terminal_commands WHERE owner_id=? AND admission_id=? AND request_id=?')
   .get(input.owner_id,input.admission_id,input.request_id) as Row|undefined;
  if(!saved||saved.command_sha256!==input.command_sha256||saved.admission_state_sha256!==input.admission_state_sha256)throw Error('standalone_terminal_command_conflict');
  const allowed=saved.native_attempted_at===null&&saved.receipt_json===null;
  if(allowed)db.prepare('UPDATE ga_standalone_terminal_commands SET native_attempted_at=? WHERE owner_id=? AND admission_id=? AND request_id=?')
   .run(new Date().toISOString(),input.owner_id,input.admission_id,input.request_id);
  return{...input,protocol:1 as const,attempt_allowed:allowed,execution_authorized:false as const};
 });
}
