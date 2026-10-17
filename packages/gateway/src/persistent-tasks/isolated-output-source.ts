import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {WorkAdmissionRecords} from '../always-on/work-admission-records.ts';
import type {TaskFileSource} from './task-file-source.ts';
import type {TaskOutputReadResult} from './output-content.ts';
type Row=Record<string,any>;
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const fail=()=>Error('file_execution_output_unverified');
/** Validate original immutable IO journal and admission. Live authority is checked
 * only when issuing the original proof, never when reading historical output. */
export function isolatedFileFacts(db:DatabaseSync,runId:string,callId:string,result:unknown,live=false):Row{
 try{
  if(!result||typeof result!=='object')throw fail();const value=result as Row;
  if(value.source!=='isolated'||typeof value.receipt_id!=='string'||!Number.isSafeInteger(value.version)||value.version<1||!Number.isSafeInteger(value.size)||value.size<0)throw fail();
  const row=db.prepare(`SELECT r.*,i.identity_json,i.operation_json,i.digest FROM wb_isolated_file_results r JOIN wb_isolated_file_intents i ON i.call_key=r.call_key WHERE r.receipt_id=?`).get(value.receipt_id) as Row|undefined;if(!row)throw fail();
  const identity=JSON.parse(row.identity_json),operation=JSON.parse(row.operation_json),saved=JSON.parse(row.response_json);
  if(canonicalJson(saved)!==row.response_json||canonicalJson(saved)!==canonicalJson(value)||sha(canonicalJson(identity))!==row.call_key||sha(canonicalJson({identity,operation}))!==row.digest||operation.operation!=='files.write'||operation.path!==row.path||operation.expected_version+1!==row.version||typeof operation.content!=='string')throw fail();
  for(const [key,v]of Object.entries(identity))if(value[key]!==v)throw fail();
  if(identity.run_id!==runId||identity.call_id!==callId||identity.cycle_id!==row.cycle_id||identity.snapshot_id!==row.snapshot_id||value.path!==row.path||value.version!==row.version||value.sha256!==row.sha256)throw fail();
  const bytes=Buffer.from(row.bytes);if(bytes.length!==value.size||sha(bytes)!==row.sha256||!bytes.equals(Buffer.from(operation.content)))throw fail();
  const binding=db.prepare(`SELECT b.kind,b.context_json,r.conversation_id FROM wb_run_bindings b JOIN ga_runs r ON r.id=b.run_id JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=b.owner_id WHERE b.run_id=? AND b.owner_id=? AND c.workspace_id=? AND c.project_id=?`).get(runId,identity.owner_id,identity.workspace_id,identity.project_id) as Row|undefined;
  if(!binding)throw fail();const context=JSON.parse(binding.context_json);if(context.workspace_id!==identity.workspace_id||context.project_id!==identity.project_id)throw fail();
  let lead=runId;if(binding.kind==='native_team'){
   const native=db.prepare('SELECT root_run_id,task_id,occurrence_id FROM wb_native_execution_runs WHERE run_id=? AND owner_id=?').get(runId,identity.owner_id) as Row|undefined;
   if(!native||native.occurrence_id!==identity.occurrence_id)throw fail();lead=native.root_run_id;
  }else if(binding.kind!=='task')throw fail();
  const records=new WorkAdmissionRecords(db),admission=live?records.guard(identity.owner_id,lead):records.byRun(identity.owner_id,lead);
  if(!admission||admission.occurrence_id!==identity.occurrence_id||admission.cycle_id!==identity.cycle_id||admission.snapshot_id!==identity.snapshot_id||admission.scope.workspace_id!==identity.workspace_id||admission.scope.project_id!==identity.project_id||admission.scope.agent_id!==identity.agent_id)throw fail();
  return {...identity,task_id:admission.task_id,path:row.path,version:row.version,sha256:row.sha256,size:bytes.length,bytes,conversation_id:binding.conversation_id};
 }catch{throw fail();}
}
/** Scoped synchronous immutable BLOB read; no filesystem/root or live permission. */
export function readIsolatedTaskFileVersion(db:DatabaseSync,source:TaskFileSource):TaskOutputReadResult{
 try{
  if(source.source!=='isolated')throw fail();
  const proof=db.prepare(`SELECT p.call_id,p.result_hash,e.* FROM wb_task_isolated_file_execution_receipts e JOIN wb_task_execution_receipts p ON p.receipt_id=e.receipt_id AND p.run_id=e.run_id AND p.operation='files.write' WHERE e.receipt_id=?`).get(source.receipt_id) as Row|undefined;if(!proof)throw fail();
  for(const key of ['receipt_id','isolated_receipt_id','run_id','owner_id','workspace_id','project_id','task_id','occurrence_id','cycle_id','snapshot_id','path','version','sha256','size'])if(proof[key]!==source[key as keyof TaskFileSource])throw fail();
  const result=db.prepare('SELECT r.response_json,i.operation_json FROM wb_isolated_file_results r JOIN wb_isolated_file_intents i ON i.call_key=r.call_key WHERE r.receipt_id=?').get(source.isolated_receipt_id) as Row|undefined;if(!result)throw fail();
  // Only historical resolution requires the original response: issuance runs
  // immediately before saveCall in the same short final IO transaction.
  const ledger=db.prepare('SELECT request_hash,response_json FROM wb_tool_receipts WHERE run_id=? AND call_id=?').get(source.run_id,proof.call_id) as Row|undefined;if(!ledger)throw fail();
  const {operation,...args}=JSON.parse(result.operation_json),{execution_receipt,...original}=JSON.parse(ledger.response_json);
  if(ledger.request_hash!==sha(canonicalJson({operation,args}))
   ||canonicalJson(execution_receipt)!==canonicalJson({kind:'tool_receipt',reference:source.receipt_id,hash:proof.result_hash})
   ||canonicalJson(original)!==canonicalJson(JSON.parse(result.response_json))||sha(JSON.stringify(original))!==proof.result_hash)throw fail();
  const saved=JSON.parse(result.response_json);if(canonicalJson(JSON.parse(proof.result_json))!==canonicalJson(saved)||sha(proof.result_json)!==proof.result_hash)throw fail();const facts=isolatedFileFacts(db,source.run_id,proof.call_id,saved);
  for(const key of ['owner_id','workspace_id','project_id','task_id','occurrence_id','cycle_id','snapshot_id','path','version','sha256','size'])if(facts[key]!==proof[key])throw fail();
  const content=facts.bytes.toString('utf8');if(sha(content)!==source.sha256)throw fail();
  return {source:{source:'isolated',cycle_id:source.cycle_id,snapshot_id:source.snapshot_id,isolated_receipt_id:source.isolated_receipt_id},path:source.path,version:source.version,sha256:source.sha256,size:source.size,content};
 }catch{throw fail();}
}
