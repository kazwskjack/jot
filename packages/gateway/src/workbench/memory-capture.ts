import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {decodeStoredContent} from '../messages/content.ts';
import {FinalizedWorkSources} from '../persistent-tasks/finalized-work-sources.ts';
import type {ModelBudgetLedger} from './model-budget.ts';
type Input=Record<string,unknown>;
type Row=Record<string,string|number|null>;
interface Actor{agent_id:string;workspace_id:string;project_id:string;capability_epoch:number}
interface Ports{agent(owner:string,id:string):Actor;assertRun(owner:string,agentId:string,runId:string):void;save(owner:string,workspace:string,input:Input):Input;
 budgetLedger?:ModelBudgetLedger;verifyUsageReceipt?(proof:Input,evidenceRef:string):Uint8Array|null;finalizeRun?(runId:string,status:'succeeded'|'failed',reasonCode:string|null):void}
interface Source{source_id:string;message_id:string;block_id:string;block_index:number;role:string;origin:'human'|'agent'|'automation';content_sha256:string;text:string;truncated:boolean;kind?:'task_report';task_run_id?:string;certificate_id?:string;source_sha256?:string}
interface Note{content:string;source_ids:string[]}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
const normalize=(value:string)=>value.trim();
const finalizedTaskReportCaptures=new WeakMap<DatabaseSync,MemoryCaptureService>();
export function captureFinalizedTaskReportForDatabase(db:DatabaseSync,owner:string,runId:string){
 return finalizedTaskReportCaptures.get(db)?.captureFinalizedTaskReport(owner,runId)??null;
}
function exact(input:Input,allowed:string[]){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))throw new Error('invalid_memory_capture');}
function text(value:unknown,max:number):string{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('invalid_memory_capture');return (value as string).trim();}
function expected(value:unknown,version:number){if(!Number.isSafeInteger(value)||Number(value)<0)throw new Error('invalid_memory_capture');if(value!==version)throw new Error('version_conflict');}
function reconcilableCapture(row:Row){
 if(row.status==='ready')return row.proposal_json===null&&row.processor_run_id===null;
 return ['proposed','no_notes'].includes(String(row.status))&&row.proposal_json!==null&&row.processor_run_id!==null;
}
function captureText(value:string,maxCharacters:number){
 let end=Math.min(value.length,maxCharacters);
 if(end<value.length&&(value.codePointAt(end-1)??0)>0xffff)end--;
 return value.slice(0,end);
}
/** Capturing a completed public message is separate from planning, extraction and approval. */
export class MemoryCaptureService{
 private readonly db:DatabaseSync;private readonly ports:Ports;
 constructor(db:DatabaseSync,ports:Ports){this.db=db;this.ports=ports;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_memory_capture_policies(agent_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('off','suggest')),include_assistant INTEGER NOT NULL,include_automation INTEGER NOT NULL,version INTEGER NOT NULL,epoch INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_memory_capture_policy_revisions(agent_id TEXT NOT NULL,version INTEGER NOT NULL,owner_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(agent_id,version));
   CREATE TABLE IF NOT EXISTS wb_memory_captures(sequence INTEGER PRIMARY KEY AUTOINCREMENT,capture_id TEXT UNIQUE NOT NULL,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,agent_id TEXT NOT NULL,
    source_run_id TEXT NOT NULL,source_conversation_id TEXT NOT NULL,run_kind TEXT NOT NULL,policy_version INTEGER NOT NULL,epoch INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('watching','ready','proposed','applied','rejected','no_notes','no_source','source_failed','stale')),version INTEGER NOT NULL,
    source_json TEXT,info_json TEXT,proposal_json TEXT,results_json TEXT,processor_run_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_id,agent_id,source_run_id));
   CREATE INDEX IF NOT EXISTS wb_memory_capture_scope ON wb_memory_captures(owner_id,agent_id,sequence DESC);
   CREATE INDEX IF NOT EXISTS wb_memory_capture_watch ON wb_memory_captures(status,sequence);
   CREATE TRIGGER IF NOT EXISTS wb_capture_policy_revision_no_update BEFORE UPDATE ON wb_memory_capture_policy_revisions BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_capture_policy_revision_no_delete BEFORE DELETE ON wb_memory_capture_policy_revisions BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_capture_policy_revision_no_replace BEFORE INSERT ON wb_memory_capture_policy_revisions WHEN EXISTS(SELECT 1 FROM wb_memory_capture_policy_revisions WHERE agent_id=NEW.agent_id AND version=NEW.version) BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_captures_no_delete BEFORE DELETE ON wb_memory_captures BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_capture_sequence_guard BEFORE UPDATE OF sequence ON wb_memory_captures WHEN NEW.sequence IS NOT OLD.sequence BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_captures_no_replace BEFORE INSERT ON wb_memory_captures WHEN EXISTS(SELECT 1 FROM wb_memory_captures WHERE sequence=NEW.sequence OR capture_id=NEW.capture_id OR (owner_id=NEW.owner_id AND agent_id=NEW.agent_id AND source_run_id=NEW.source_run_id)) BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_captures_guard BEFORE UPDATE ON wb_memory_captures
    WHEN NEW.capture_id IS NOT OLD.capture_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.project_id IS NOT OLD.project_id OR NEW.agent_id IS NOT OLD.agent_id
     OR NEW.source_run_id IS NOT OLD.source_run_id OR NEW.source_conversation_id IS NOT OLD.source_conversation_id OR NEW.run_kind IS NOT OLD.run_kind OR NEW.policy_version!=OLD.policy_version OR NEW.epoch!=OLD.epoch OR NEW.created_at IS NOT OLD.created_at OR NEW.version!=OLD.version+1
     OR (OLD.source_json IS NOT NULL AND NEW.source_json IS NOT OLD.source_json) OR (OLD.info_json IS NOT NULL AND NEW.info_json IS NOT OLD.info_json)
     OR (OLD.proposal_json IS NOT NULL AND NEW.proposal_json IS NOT OLD.proposal_json) OR (OLD.results_json IS NOT NULL AND NEW.results_json IS NOT OLD.results_json)
     OR (OLD.processor_run_id IS NOT NULL AND NEW.processor_run_id IS NOT OLD.processor_run_id)
     OR (NEW.source_json IS NOT OLD.source_json AND NOT(OLD.status='watching' AND NEW.status IN ('ready','no_source','source_failed','stale')))
     OR (NEW.info_json IS NOT OLD.info_json AND NOT(OLD.status='watching' AND NEW.status IN ('ready','no_source','source_failed','stale')))
     OR ((NEW.proposal_json IS NOT OLD.proposal_json OR NEW.processor_run_id IS NOT OLD.processor_run_id) AND NOT(OLD.status='ready' AND NEW.status IN ('proposed','no_notes')))
     OR (NEW.results_json IS NOT OLD.results_json AND NOT(OLD.status='proposed' AND NEW.status='applied'))
     OR NOT((OLD.status='watching' AND NEW.status IN ('ready','no_source','source_failed','stale','rejected')) OR (OLD.status='ready' AND NEW.status IN ('proposed','no_notes','rejected')) OR (OLD.status='proposed' AND NEW.status IN ('applied','rejected')))
    BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;`);
  finalizedTaskReportCaptures.set(db,this);
  db.exec(`CREATE TABLE IF NOT EXISTS wb_memory_capture_reconciliations(
    run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,capture_id TEXT NOT NULL,evidence_ref TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,
    receipt_json TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(run_id,attempt_id),UNIQUE(evidence_ref));
   CREATE TRIGGER IF NOT EXISTS wb_memory_capture_reconciliation_no_update BEFORE UPDATE ON wb_memory_capture_reconciliations
    BEGIN SELECT RAISE(ABORT,'memory_capture_reconciliation_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_capture_reconciliation_no_delete BEFORE DELETE ON wb_memory_capture_reconciliations
    BEGIN SELECT RAISE(ABORT,'memory_capture_reconciliation_immutable'); END;`);
 }
 private rawPolicy(owner:string,agentId:string){return this.db.prepare('SELECT * FROM wb_memory_capture_policies WHERE owner_id=? AND agent_id=?').get(owner,agentId) as Row|undefined;}
 policy(owner:string,agentId:string){const actor=this.ports.agent(owner,agentId),row=this.rawPolicy(owner,agentId);return {agent_id:agentId,mode:row?.mode??'off',include_assistant:!!row?.include_assistant,include_automation:!!row?.include_automation,version:Number(row?.version??0),current:!row||row.epoch===actor.capability_epoch,updated_at:row?.updated_at??null};}
 setPolicy(owner:string,agentId:string,input:Input){return withImmediateTransaction(this.db,()=>{
  exact(input,['expected_version','mode','include_assistant','include_automation']);const actor=this.ports.agent(owner,agentId),old=this.rawPolicy(owner,agentId);expected(input.expected_version,Number(old?.version??0));
  if(input.mode!=='off'&&input.mode!=='suggest')throw new Error('invalid_memory_capture');for(const key of ['include_assistant','include_automation'])if(input[key]!==undefined&&typeof input[key]!=='boolean')throw new Error('invalid_memory_capture');
  const assistant=input.include_assistant===undefined?Number(old?.include_assistant??0):Number(input.include_assistant),automation=input.include_automation===undefined?Number(old?.include_automation??0):Number(input.include_automation),at=now(),version=Number(old?.version??0)+1;
  this.db.prepare(`INSERT INTO wb_memory_capture_policies VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET mode=excluded.mode,include_assistant=excluded.include_assistant,include_automation=excluded.include_automation,version=excluded.version,epoch=excluded.epoch,updated_at=excluded.updated_at`)
   .run(agentId,owner,String(input.mode),assistant,automation,version,actor.capability_epoch,old?.created_at??at,at);
  const value=this.policy(owner,agentId);this.db.prepare('INSERT INTO wb_memory_capture_policy_revisions VALUES(?,?,?,?,?)').run(agentId,version,owner,JSON.stringify(value),at);return value;
 });}
 captureFinalizedTaskReport(owner:string,runId:string){
  return withImmediateTransaction(this.db,()=>{
   let source;
   try{source=new FinalizedWorkSources(this.db).summary(owner,runId);}
   catch(error){if(error instanceof Error&&['completed_work_source_not_found','completed_work_source_unsupported'].includes(error.message))return null;throw error;}
   let policy;
   try{policy=this.policy(owner,source.agent_id);}
   catch(error){if(error instanceof Error&&['agent_not_found','agent_capability_revoked'].includes(error.message))return null;throw error;}
   if(policy.mode!=='suggest'||!policy.current)return null;
   const policyRow=this.rawPolicy(owner,source.agent_id),existing=this.db.prepare('SELECT status,policy_version,epoch FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND source_run_id=?').get(owner,source.agent_id,runId) as Row|undefined;
   if(existing&&(existing.status!=='watching'||Number(existing.policy_version)!==policy.version||Number(existing.epoch)!==Number(policyRow?.epoch)))return null;
   return this.captureTaskReport(owner,source.agent_id,runId,source.source_sha256);
  });
 }
 captureTaskReport(owner:string,agentId:string,runId:string,expectedSourceSha256:string){return withImmediateTransaction(this.db,()=>{
  if(typeof runId!=='string'||!runId||runId.length>128||typeof expectedSourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSourceSha256))throw Error('invalid_memory_capture');
  const actor=this.ports.agent(owner,agentId),policy=this.rawPolicy(owner,agentId);
  if(!policy||policy.mode!=='suggest')throw Error('memory_capture_disabled');
  if(policy.epoch!==actor.capability_epoch)throw Error('memory_capture_policy_stale');
  const summary=new FinalizedWorkSources(this.db).summary(owner,runId);
  if(summary.source_sha256!==expectedSourceSha256)throw Error('completed_work_source_conflict');
  if(summary.agent_id!==agentId||summary.workspace_id!==actor.workspace_id||summary.project_id!==actor.project_id)throw Error('memory_scope_forbidden');
  const message=this.db.prepare(`SELECT m.*,c.archived_at FROM ga_messages m JOIN ga_conversations c ON c.id=m.conversation_id
   WHERE m.id=? AND m.run_id=? AND m.role='assistant' AND m.status='complete' AND c.owner_id=? AND c.workspace_id=? AND c.project_id=?`)
   .get(summary.final_message_id,runId,owner,actor.workspace_id,actor.project_id) as Row|undefined;
  if(!message)throw Error('completed_work_source_unavailable');
  const blocks=decodeStoredContent(String(message.content_json)).blocks;
  if(blocks.length!==1||blocks[0]?.kind!=='text'||typeof blocks[0].text!=='string'||!blocks[0].text.trim()
   ||(blocks[0].exposure!==undefined&&blocks[0].exposure!=='public'))throw Error('completed_work_source_unavailable');
  const reportText=blocks[0].text,capturedText=captureText(reportText,20000),usable=!!capturedText.trim(),status=usable?'ready':'no_source';
  const source:Source={kind:'task_report',source_id:'source-'+digest(JSON.stringify(['task_report',runId,summary.certificate_id,summary.source_sha256])).slice(0,32),
   message_id:String(message.id),block_id:'task-report:'+summary.certificate_id,block_index:0,role:'assistant',origin:'agent',content_sha256:digest(String(message.content_json)),
   text:capturedText,truncated:capturedText.length<reportText.length,task_run_id:runId,certificate_id:summary.certificate_id,source_sha256:summary.source_sha256};
  const sourceJson=JSON.stringify(usable?[source]:[]),infoJson=JSON.stringify({source_kind:'task_report',source_sha256:summary.source_sha256,certificate_id:summary.certificate_id,captured_chars:usable?source.text.length:0,truncated_blocks:usable?Number(source.truncated):0,omitted_blocks:usable?0:1,excluded_blocks:0,source_status:'succeeded'});
  const existing=this.db.prepare('SELECT * FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND source_run_id=?').get(owner,agentId,runId) as Row|undefined;
  if(existing){
   if(existing.workspace_id!==actor.workspace_id||existing.project_id!==actor.project_id||existing.source_conversation_id!==message.conversation_id||existing.run_kind!=='task'
    ||existing.policy_version!==policy.version||existing.epoch!==actor.capability_epoch)throw Error('memory_capture_source_conflict');
   if(existing.status==='no_source'&&existing.source_json===sourceJson&&existing.info_json===infoJson)return this.get(owner,agentId,String(existing.capture_id));
   const prior=this.sources(existing);
   if(prior.length===1&&prior[0]?.kind==='task_report'&&prior[0].source_sha256===summary.source_sha256&&prior[0].certificate_id===summary.certificate_id){this.requireSources(existing);return this.get(owner,agentId,String(existing.capture_id));}
   if(existing.status!=='watching'||existing.source_json!==null||existing.info_json!==null)throw Error('memory_capture_source_conflict');
   this.db.prepare("UPDATE wb_memory_captures SET source_json=?,info_json=?,status=?,version=version+1,updated_at=? WHERE capture_id=? AND version=?")
    .run(sourceJson,infoJson,status,now(),String(existing.capture_id),Number(existing.version));
   return this.get(owner,agentId,String(existing.capture_id));
  }
  const at=now(),captureId='capture-'+randomUUID();
  this.db.prepare(`INSERT INTO wb_memory_captures(capture_id,owner_id,workspace_id,project_id,agent_id,source_run_id,source_conversation_id,run_kind,policy_version,epoch,status,version,source_json,info_json,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).run(captureId,owner,actor.workspace_id,actor.project_id,agentId,runId,String(message.conversation_id),'task',Number(policy.version),actor.capability_epoch,status,sourceJson,infoJson,at,at);
  return this.get(owner,agentId,captureId);
 });}
 register(owner:string,agentId:string,runId:string){
  if(!this.db.isTransaction)throw new Error('memory_capture_transaction_required');const policy=this.rawPolicy(owner,agentId);if(!policy||policy.mode!=='suggest')return;
  const actor=this.ports.agent(owner,agentId);if(policy.epoch!==actor.capability_epoch)return;
  const run=this.db.prepare(`SELECT r.conversation_id,b.kind FROM ga_runs r JOIN wb_run_bindings b ON b.run_id=r.id WHERE r.id=? AND b.owner_id=? AND b.agent_id=?`).get(runId,owner,agentId) as Row|undefined;
  if(!run||!['chat','task','native_team','internal_mailbox'].includes(String(run.kind))||(run.kind!=='chat'&&!policy.include_assistant&&!policy.include_automation))return;
  if(this.db.prepare('SELECT 1 FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND source_run_id=?').get(owner,agentId,runId))return;
  const at=now();this.db.prepare(`INSERT INTO wb_memory_captures(capture_id,owner_id,workspace_id,project_id,agent_id,source_run_id,source_conversation_id,run_kind,policy_version,epoch,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'watching',1,?,?)`)
   .run('capture-'+randomUUID(),owner,actor.workspace_id,actor.project_id,agentId,runId,String(run.conversation_id),String(run.kind),Number(policy.version),actor.capability_epoch,at,at);
 }
 private row(owner:string,agentId:string,id:string){const actor=this.ports.agent(owner,agentId),row=this.db.prepare('SELECT * FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND capture_id=?').get(owner,agentId,id) as Row|undefined;if(!row)throw new Error('memory_capture_not_found');if(row.workspace_id!==actor.workspace_id||row.project_id!==actor.project_id)throw new Error('memory_scope_forbidden');return row;}
 private readSnapshot<T>(operation:()=>T):T{
  if(this.db.isTransaction)return operation();
  this.db.exec('BEGIN');
  try{const value=operation();this.db.exec('COMMIT');return value;}
  catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
 }
 private policyCurrent(row:Row){const p=this.rawPolicy(String(row.owner_id),String(row.agent_id)),actor=this.ports.agent(String(row.owner_id),String(row.agent_id));return !!p&&p.mode==='suggest'&&p.version===row.policy_version&&p.epoch===row.epoch&&row.epoch===actor.capability_epoch;}
 private currentSource(row:Row,source:Source){
  if(source.kind==='task_report'){
   try{const summary=new FinalizedWorkSources(this.db).summary(String(row.owner_id),String(source.task_run_id));
    if(source.task_run_id!==row.source_run_id||summary.source_sha256!==source.source_sha256||summary.certificate_id!==source.certificate_id
     ||summary.final_message_id!==source.message_id||summary.agent_id!==row.agent_id||summary.workspace_id!==row.workspace_id||summary.project_id!==row.project_id)return false;
   }catch{return false;}
  }
  const message=this.db.prepare(`SELECT m.content_json,m.status,m.role,c.archived_at FROM ga_messages m JOIN ga_conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.conversation_id=? AND c.owner_id=? AND c.workspace_id=? AND c.project_id=?`).get(source.message_id,String(row.source_conversation_id),String(row.owner_id),String(row.workspace_id),String(row.project_id)) as Row|undefined;
  return !!message&&message.status==='complete'&&message.role===source.role&&(source.kind==='task_report'||message.archived_at===null)&&digest(String(message.content_json))===source.content_sha256;
 }
 private sources(row:Row){return (row.source_json?JSON.parse(String(row.source_json)):[]) as Source[];}
 private requireSources(row:Row){const sources=this.sources(row);if(!sources.length||sources.some(source=>!this.currentSource(row,source)))throw new Error('memory_capture_source_conflict');return sources;}
 private processing(row:Row){
  if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_memory_processing_runs'").get())return null;
  const job=this.db.prepare(`SELECT r.status,r.reason_code FROM wb_memory_processing_runs p LEFT JOIN ga_runs r ON r.id=p.processor_run_id
   WHERE p.capture_id=? AND p.owner_id=? AND p.agent_id=?`).get(String(row.capture_id),String(row.owner_id),String(row.agent_id)) as {status:string|null;reason_code:string|null}|undefined;
  return job?{status:job.status??'missing',reason_code:job.reason_code}:null;
 }
 private header(row:Row){const sources=this.sources(row),proposal=row.proposal_json?JSON.parse(String(row.proposal_json)):null;return {processing:this.processing(row),capture_id:String(row.capture_id),agent_id:String(row.agent_id),workspace_id:String(row.workspace_id),project_id:String(row.project_id),source_run_id:String(row.source_run_id),source_conversation_id:String(row.source_conversation_id),run_kind:String(row.run_kind),policy_version:Number(row.policy_version),policy_current:this.policyCurrent(row),status:String(row.status),version:Number(row.version),source_count:sources.length,notes_count:proposal?.notes.length??0,created_at:String(row.created_at),updated_at:String(row.updated_at)};}
 list(owner:string,agentId:string,beforeId?:string){this.ports.agent(owner,agentId);let before:number|null=null;if(beforeId!==undefined){const cursor=this.db.prepare('SELECT sequence FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND capture_id=?').get(owner,agentId,beforeId) as {sequence:number}|undefined;if(!cursor)throw new Error('memory_capture_not_found');before=cursor.sequence;}
  const rows=this.db.prepare('SELECT * FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT 26').all(owner,agentId,before,before) as Row[],page=rows.slice(0,25);return {items:page.map(row=>this.header(row)),next_before_id:rows.length>25?String(page.at(-1)!.capture_id):null};}
 get(owner:string,agentId:string,id:string){const row=this.row(owner,agentId,id),sources=this.sources(row),availability=sources.map(source=>this.currentSource(row,source)),available=availability.every(Boolean);return {...this.header(row),info:row.info_json?JSON.parse(String(row.info_json)):null,
  sources:sources.map((source,index)=>{const {text,...metadata}=source,current=availability[index]===true;return {...metadata,available:current,...(current?{text}:{})};}),
  proposal:available&&row.proposal_json?JSON.parse(String(row.proposal_json)):null,proposal_unavailable:!available&&row.proposal_json!==null,results:row.results_json?JSON.parse(String(row.results_json)):null};}
 recovery(owner:string,agentId:string,id:string){return this.readSnapshot(()=>{
  const row=this.row(owner,agentId,id),sources=this.sources(row),policyCurrent=this.policyCurrent(row),sourcesCurrent=sources.every(source=>this.currentSource(row,source));
  const captureProcessorRunId=row.processor_run_id===null||row.processor_run_id===undefined?null:String(row.processor_run_id);
  const processingTable=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_memory_processing_runs'").get();
  const processing=processingTable?this.db.prepare(`SELECT p.processor_run_id FROM wb_memory_processing_runs p
   WHERE p.capture_id=? AND p.owner_id=? AND p.agent_id=? AND p.workspace_id=? AND p.project_id=?
    AND p.source_run_id=? AND p.source_conversation_id=? AND p.policy_version=? AND p.epoch=? AND (? IS NULL OR p.processor_run_id=?)`).get(id,owner,agentId,String(row.workspace_id),String(row.project_id),String(row.source_run_id),String(row.source_conversation_id),Number(row.policy_version),Number(row.epoch),captureProcessorRunId,captureProcessorRunId) as {processor_run_id:string}|undefined:null;
  const runId=processing?String(processing.processor_run_id):captureProcessorRunId;
  const run=runId?this.db.prepare(`SELECT r.status,r.reason_code FROM wb_memory_processing_runs p
   JOIN ga_runs r ON r.id=p.processor_run_id AND r.conversation_id=p.conversation_id
   JOIN ga_conversations c ON c.id=r.conversation_id JOIN wb_run_bindings b ON b.run_id=r.id
   WHERE p.processor_run_id=? AND p.capture_id=? AND p.owner_id=? AND p.agent_id=? AND p.workspace_id=? AND p.project_id=?
    AND p.source_run_id=? AND p.source_conversation_id=? AND p.policy_version=? AND p.epoch=?
    AND b.owner_id=p.owner_id AND b.agent_id=p.agent_id AND b.epoch=p.epoch AND b.kind='memory_capture'
    AND c.owner_id=p.owner_id AND c.workspace_id=p.workspace_id AND c.project_id=p.project_id`).get(runId,id,owner,agentId,String(row.workspace_id),String(row.project_id),String(row.source_run_id),String(row.source_conversation_id),Number(row.policy_version),Number(row.epoch)) as {status:string;reason_code:string|null}|undefined:null;
  const runStatuses=new Set(['queued','starting','running','waiting_user','waiting_approval','succeeded','partial','failed','interrupted','cancelling']);
  const processorRunStatus=runId===null?(processingTable?'not_started':'unavailable'):run?(runStatuses.has(run.status)?run.status:'unknown'):'unavailable';
  let usageState='no_attempt',usageBoundExceeded=false;
  if(runId!==null){
   if(!run)usageState='unavailable';
   else if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_model_budget_attempts'").get())usageState='unavailable';
   else{
    const attempts=this.db.prepare('SELECT state,bound_exceeded FROM wb_model_budget_attempts WHERE run_id=?').all(runId) as Array<{state:string;bound_exceeded:number}>;
    usageBoundExceeded=attempts.some(attempt=>attempt.bound_exceeded!==0);
    const states=new Set(attempts.map(attempt=>attempt.state)),unknown=states.has('unknown'),active=states.has('in_flight')||states.has('reserved');
    if(unknown&&active)usageState='held_mixed';
    else if(unknown)usageState='held_unknown';
    else if(active)usageState='held_in_flight';
    else if(attempts.some(attempt=>attempt.bound_exceeded!==0)||attempts.some(attempt=>!['settled','released'].includes(attempt.state)))usageState='unresolved';
    else if(attempts.some(attempt=>attempt.state==='settled'))usageState='settled';
    else if(attempts.length&&attempts.every(attempt=>attempt.state==='released'))usageState='released';
   }
  }
  const current=policyCurrent&&sourcesCurrent,hasProposal=row.status==='proposed'&&row.proposal_json!==null;
  const proposalAvailable=current&&sources.length>0&&hasProposal&&usageState==='settled'&&!['unknown','unavailable'].includes(processorRunStatus);
  const usageUnresolved=usageState.startsWith('held_')||['unresolved','unavailable'].includes(usageState)||(hasProposal&&(usageState!=='settled'||['unknown','unavailable'].includes(processorRunStatus)));
  const closedState=row.status==='ready'?'usage_settled_without_proposal':row.status==='no_notes'?'no_notes_settled':'no_recovery_needed';
  const recoveryState=!current?'source_or_policy_stale':usageBoundExceeded?'budget_bound_exceeded':usageUnresolved?'unresolved_usage_held':proposalAvailable?'committed_proposal_settled':usageState==='settled'?closedState:'no_recovery_needed';
  const providerReceiptTable=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_model_budget_provider_receipts'").get();
  const evidenceRefs=runId&&current&&reconcilableCapture(row)&&run?.status==='interrupted'&&run.reason_code==='MEMORY_EXTRACTION_RECONCILE_REQUIRED'&&providerReceiptTable
   ?this.db.prepare(`SELECT receipt.attempt_id,receipt.evidence_ref FROM wb_model_budget_provider_receipts receipt
     JOIN wb_model_budget_attempts attempt ON attempt.run_id=receipt.run_id AND attempt.attempt_id=receipt.attempt_id
     WHERE receipt.run_id=? AND receipt.owner_id=? AND (attempt.state IN ('in_flight','unknown') OR (attempt.state='settled' AND attempt.bound_exceeded=1))
       AND NOT EXISTS(SELECT 1 FROM wb_memory_capture_reconciliations done WHERE done.run_id=receipt.run_id AND done.attempt_id=receipt.attempt_id)
      ORDER BY receipt.attempt_id LIMIT 20`).all(runId,owner) as Array<{attempt_id:string;evidence_ref:string}>:[];
  return {capture_status:String(row.status),processor_run_status:processorRunStatus,proposal_available:proposalAvailable,usage_state:usageState,recovery_state:recoveryState,
   reconciliation_evidence:evidenceRefs.map(item=>({attempt_id:item.attempt_id,evidence_ref:item.evidence_ref,policy_version:Number(row.policy_version),epoch:Number(row.epoch)}))};
 });}
 reconcile(owner:string,agentId:string,id:string,input:Input){
  exact(input,['expected_capture_version','expected_policy_version','expected_epoch','attempt_id','evidence_ref']);
  for(const key of ['expected_capture_version','expected_policy_version','expected_epoch'])if(!Number.isSafeInteger(input[key])||Number(input[key])<0)throw new Error('invalid_memory_capture');
  const attemptId=text(input.attempt_id,192),evidenceRef=text(input.evidence_ref,128);
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(attemptId)||!/^musage-[A-Za-z0-9-]{16,64}$/.test(evidenceRef))throw new Error('invalid_memory_capture');
  if(!this.ports.budgetLedger||!this.ports.verifyUsageReceipt||!this.ports.finalizeRun)throw new Error('memory_capture_reconcile_unavailable');
  const snapshot=this.readSnapshot(()=>{
   const row=this.row(owner,agentId,id);expected(input.expected_capture_version,Number(row.version));
   if(Number(input.expected_policy_version)!==Number(row.policy_version)||Number(input.expected_epoch)!==Number(row.epoch))throw new Error('memory_capture_reconcile_conflict');
   if(!reconcilableCapture(row))throw new Error('memory_capture_proposal_unavailable');
   const processing=this.db.prepare(`SELECT p.*,r.status AS run_status,r.reason_code AS run_reason_code,r.conversation_id AS run_conversation_id,b.kind,b.owner_id AS binding_owner,b.agent_id AS binding_agent,b.epoch AS binding_epoch,
    c.owner_id AS conversation_owner,c.workspace_id AS conversation_workspace,c.project_id AS conversation_project
    FROM wb_memory_processing_runs p JOIN ga_runs r ON r.id=p.processor_run_id JOIN wb_run_bindings b ON b.run_id=p.processor_run_id
    JOIN ga_conversations c ON c.id=r.conversation_id WHERE p.capture_id=? AND p.owner_id=? AND p.agent_id=?`).get(id,owner,agentId) as Record<string,unknown>|undefined;
   if(!processing||processing.source_run_id!==row.source_run_id||processing.source_conversation_id!==row.source_conversation_id||Number(processing.policy_version)!==Number(row.policy_version)||Number(processing.epoch)!==Number(row.epoch)
    ||processing.binding_owner!==owner||processing.binding_agent!==agentId||Number(processing.binding_epoch)!==Number(row.epoch)||processing.kind!=='memory_capture'
    ||processing.conversation_id!==processing.run_conversation_id||processing.conversation_owner!==owner||processing.conversation_workspace!==row.workspace_id||processing.conversation_project!==row.project_id)
    throw new Error('memory_capture_reconcile_conflict');
   if(row.status==='ready'?Number(row.version)!==Number(processing.source_version)
    :row.processor_run_id!==processing.processor_run_id||Number(row.version)<=Number(processing.source_version))throw new Error('memory_capture_reconcile_conflict');
   if(!this.policyCurrent(row)||this.sources(row).length===0||this.sources(row).some(source=>!this.currentSource(row,source)))throw new Error('memory_capture_source_or_policy_stale');
   const runId=String(processing.processor_run_id),prior=this.db.prepare('SELECT * FROM wb_memory_capture_reconciliations WHERE run_id=? AND attempt_id=?').get(runId,attemptId) as Record<string,unknown>|undefined;
   if(prior)return {row,processing,attempt:null,prior,proof:null};
   if(processing.run_status!=='interrupted'||processing.run_reason_code!=='MEMORY_EXTRACTION_RECONCILE_REQUIRED')throw new Error('memory_capture_reconcile_run_not_interrupted');
   const lease=this.db.prepare('SELECT expires_at FROM ga_worker_leases WHERE resource_id=?').get(runId) as {expires_at:string}|undefined;
   if(lease&&Number(lease.expires_at)>Date.now())throw new Error('memory_capture_reconcile_live_lease');
   const attempt=this.db.prepare(`SELECT a.request_json,a.route_json,a.state,a.bound_exceeded FROM wb_model_budget_attempts a
    JOIN wb_model_budget_bindings b ON b.run_id=a.run_id WHERE a.run_id=? AND a.attempt_id=? AND b.owner_id=?`).get(runId,attemptId,owner) as Record<string,unknown>|undefined;
   if(!attempt||!['in_flight','unknown','settled'].includes(String(attempt.state))||(Number(attempt.bound_exceeded)!==0&&attempt.state!=='settled'))throw new Error('memory_capture_reconcile_attempt_invalid');
   const proof:Input={protocol:1,owner_id:owner,workspace_id:String(row.workspace_id),project_id:String(row.project_id),agent_id:agentId,capture_id:id,
    source_run_id:String(row.source_run_id),source_conversation_id:String(row.source_conversation_id),source_version:Number(processing.source_version),
    source_sha256:digest(String(row.source_json??'')),policy_version:Number(row.policy_version),epoch:Number(row.epoch),run_id:runId,attempt_id:attemptId,
    stable_request_id:attemptId,request_sha256:digest(String(attempt.request_json)),route_sha256:digest(String(attempt.route_json))};
   return {row,processing,attempt,prior:null,proof};
  });
  if(snapshot.prior){if(snapshot.prior.evidence_ref!==evidenceRef)throw new Error('memory_capture_reconcile_conflict');return JSON.parse(String(snapshot.prior.result_json));}
  let bytes:Uint8Array|null=null;try{bytes=this.ports.verifyUsageReceipt(snapshot.proof!,evidenceRef);}catch{/* Verification failure remains unresolved usage. */}
  if(!(bytes instanceof Uint8Array)||!bytes.byteLength)throw new Error('memory_capture_unresolved_usage_held');
  const evidenceSha=createHash('sha256').update(bytes).digest('hex');let payload:Input;
  try{payload=JSON.parse(Buffer.from(bytes).toString('utf8')) as Input;}catch{throw new Error('memory_capture_unresolved_usage_held');}
  const proofKeys=Object.keys(snapshot.proof!);
  const payloadKeys=['protocol','kind','owner_id','workspace_id','project_id','agent_id','capture_id','source_run_id','source_conversation_id','source_version','source_sha256','policy_version','epoch','run_id','attempt_id','stable_request_id','request_sha256','route_sha256','usage'];
  if(!payload||Object.keys(payload).length!==payloadKeys.length||Object.keys(payload).some(key=>!payloadKeys.includes(key))||payload.protocol!==1||payload.kind!=='memory_provider_usage_v1'
   ||proofKeys.some(key=>payload[key]!==snapshot.proof![key])||!payload.usage||typeof payload.usage!=='object'||Array.isArray(payload.usage))throw new Error('memory_capture_unresolved_usage_held');
  return withImmediateTransaction(this.db,()=>{
   const row=this.row(owner,agentId,id);expected(input.expected_capture_version,Number(row.version));
   if(!reconcilableCapture(row))throw new Error('memory_capture_proposal_unavailable');
   if(!this.policyCurrent(row)||this.sources(row).length===0||this.sources(row).some(source=>!this.currentSource(row,source))||Number(row.policy_version)!==Number(input.expected_policy_version)||Number(row.epoch)!==Number(input.expected_epoch))throw new Error('memory_capture_source_or_policy_stale');
   const runId=String(snapshot.proof!.run_id),prior=this.db.prepare('SELECT * FROM wb_memory_capture_reconciliations WHERE run_id=? AND attempt_id=?').get(runId,attemptId) as Record<string,unknown>|undefined;
   if(prior){if(prior.evidence_sha256!==evidenceSha)throw new Error('memory_capture_reconcile_conflict');return JSON.parse(String(prior.result_json));}
   const attempt=this.db.prepare('SELECT state,bound_exceeded,request_json,route_json FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(runId,attemptId) as Record<string,unknown>|undefined;
   if(!attempt||!['in_flight','unknown','settled'].includes(String(attempt.state))||(Number(attempt.bound_exceeded)!==0&&attempt.state!=='settled')||digest(String(attempt.request_json))!==snapshot.proof!.request_sha256||digest(String(attempt.route_json))!==snapshot.proof!.route_sha256)throw new Error('memory_capture_reconcile_attempt_invalid');
   const processing=this.db.prepare(`SELECT r.status,r.reason_code FROM wb_memory_processing_runs p JOIN ga_runs r ON r.id=p.processor_run_id JOIN wb_run_bindings b ON b.run_id=p.processor_run_id
     WHERE p.processor_run_id=? AND p.capture_id=? AND p.owner_id=? AND p.agent_id=? AND p.policy_version=? AND p.epoch=? AND b.kind='memory_capture' AND b.owner_id=p.owner_id AND b.agent_id=p.agent_id AND b.epoch=p.epoch`).get(runId,id,owner,agentId,Number(row.policy_version),Number(row.epoch)) as {status:string;reason_code:string|null}|undefined;
   if(!processing||processing.status!=='interrupted'||processing.reason_code!=='MEMORY_EXTRACTION_RECONCILE_REQUIRED')throw new Error('memory_capture_reconcile_run_not_interrupted');
   const lease=this.db.prepare('SELECT expires_at FROM ga_worker_leases WHERE resource_id=?').get(runId) as {expires_at:string}|undefined;
   if(lease&&Number(lease.expires_at)>Date.now())throw new Error('memory_capture_reconcile_live_lease');
   const receipt=this.ports.budgetLedger!.settle(owner,runId,attemptId,payload.usage);
   if(receipt.state!=='settled')throw new Error('memory_capture_unresolved_usage_held');
   const attempts=this.db.prepare('SELECT state,bound_exceeded FROM wb_model_budget_attempts WHERE run_id=?').all(runId) as Array<{state:string;bound_exceeded:number}>;
   const allClosed=attempts.some(item=>item.state==='settled')&&attempts.every(item=>['settled','released'].includes(item.state)),exceeded=attempts.some(item=>item.bound_exceeded!==0);
   const settledState=row.status==='ready'?'usage_settled_without_proposal':row.status==='no_notes'?'no_notes_settled':'committed_proposal_settled';
   const state=exceeded?'budget_bound_exceeded':allClosed?settledState:'usage_reconciled_held';
   const result={state,run_id:runId,reconciled_attempt_id:attemptId,evidence_sha256:evidenceSha};
   this.db.prepare('INSERT INTO wb_memory_capture_reconciliations VALUES(?,?,?,?,?,?,?,?)').run(runId,attemptId,id,evidenceRef,evidenceSha,Buffer.from(bytes).toString('utf8'),JSON.stringify(result),now());
   if(allClosed){
    const missingProposal=row.status==='ready';
    this.ports.finalizeRun!(runId,exceeded||missingProposal?'failed':'succeeded',
     exceeded?'MEMORY_EXTRACTION_BUDGET_BOUND_EXCEEDED':missingProposal?'MEMORY_EXTRACTION_PROPOSAL_UNAVAILABLE':null);
   }
   return result;
  });
 }
 collect(owner?:string,agentId?:string){if(owner!==undefined||agentId!==undefined){if(!owner||!agentId)throw new Error('invalid_memory_capture');this.ports.agent(owner,agentId);}
  return withImmediateTransaction(this.db,()=>{const rows=this.db.prepare(`SELECT b.*,r.status AS source_status,a.status AS actor_status,a.capability_epoch,p.mode AS policy_mode,p.version AS current_policy,p.include_assistant,p.include_automation
    FROM wb_memory_captures b LEFT JOIN ga_runs r ON r.id=b.source_run_id JOIN wb_agents a ON a.agent_id=b.agent_id JOIN wb_memory_capture_policies p ON p.agent_id=b.agent_id
    WHERE b.status='watching' AND (? IS NULL OR (b.owner_id=? AND b.agent_id=?)) AND (r.id IS NULL OR r.status IN ('succeeded','partial','failed','cancelled','interrupted','outcome_unknown') OR a.status!='active' OR a.capability_epoch!=b.epoch OR p.mode!='suggest' OR p.version!=b.policy_version)
    AND ((SELECT count(*) FROM wb_memory_captures q WHERE q.owner_id=b.owner_id AND q.agent_id=b.agent_id AND q.policy_version=b.policy_version AND q.status IN ('ready','proposed'))<50 OR r.id IS NULL OR r.status NOT IN ('succeeded','partial') OR a.status!='active' OR p.mode!='suggest' OR p.version!=b.policy_version OR a.capability_epoch!=b.epoch) ORDER BY b.sequence LIMIT 50`)
    .all(owner??null,owner??null,agentId??null) as Row[];let ready=0,skipped=0;
   for(const row of rows){let status='ready',sources:Source[]=[],captured=0,truncated=0,omitted=0,excluded=0;
    if(row.actor_status!=='active'||row.capability_epoch!==row.epoch||row.policy_mode!=='suggest'||row.current_policy!==row.policy_version)status='stale';
    else if(!['succeeded','partial'].includes(String(row.source_status)))status='source_failed';
    else{
     const count=this.db.prepare("SELECT count(*) n FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND policy_version=? AND status IN ('ready','proposed')").get(String(row.owner_id),String(row.agent_id),Number(row.policy_version)) as {n:number};if(count.n>=50)continue;
     const run=this.db.prepare('SELECT input_message_id FROM ga_runs WHERE id=?').get(String(row.source_run_id)) as Row;
     const messages=this.db.prepare(`SELECT m.* FROM ga_messages m JOIN ga_conversations c ON c.id=m.conversation_id WHERE c.owner_id=? AND c.workspace_id=? AND c.project_id=? AND c.archived_at IS NULL AND m.conversation_id=? AND (m.id=? OR (m.run_id=? AND m.role='assistant')) ORDER BY CASE m.role WHEN 'user' THEN 0 ELSE 1 END,m.created_at,m.id`)
       .all(String(row.owner_id),String(row.workspace_id),String(row.project_id),String(row.source_conversation_id),String(run.input_message_id),String(row.source_run_id)) as Row[];
     for(const message of messages){for(const [index,block] of decodeStoredContent(String(message.content_json)).blocks.entries()){
      const role=String(message.role),allowed=message.status==='complete'&&(role==='user'?(row.run_kind==='chat'||!!row.include_automation):role==='assistant'&&!!row.include_assistant);
      if(!allowed||block.kind!=='text'||(block.exposure!==undefined&&block.exposure!=='public')||typeof block.text!=='string'||!block.text.trim()){excluded++;continue;}
      if(sources.length>=20||captured>=20000){omitted++;continue;}const value=captureText(block.text,20000-captured);if(!value.trim()){omitted++;continue;}const short=value.length<block.text.length,hash=digest(String(message.content_json));if(short)truncated++;
      sources.push({source_id:'source-'+digest(JSON.stringify([message.id,index,hash])).slice(0,32),message_id:String(message.id),block_id:typeof block.block_id==='string'?block.block_id.slice(0,256):String(message.id)+':'+index,block_index:index,role,origin:role==='assistant'?'agent':row.run_kind==='chat'?'human':'automation',content_sha256:hash,text:value,truncated:short});captured+=value.length;
     }}if(!sources.length)status='no_source';
    }
    this.db.prepare('UPDATE wb_memory_captures SET source_json=?,info_json=?,status=?,version=version+1,updated_at=? WHERE capture_id=? AND version=?').run(JSON.stringify(sources),JSON.stringify({captured_chars:captured,truncated_blocks:truncated,omitted_blocks:omitted,excluded_blocks:excluded,source_status:row.source_status??'missing'}),status,now(),String(row.capture_id),Number(row.version));if(status==='ready')ready++;else skipped++;
   }return {ready,skipped};
  });}
 pending(owner:string,agentId:string){const actor=this.ports.agent(owner,agentId),p=this.rawPolicy(owner,agentId);if(!p||p.mode!=='suggest'||p.epoch!==actor.capability_epoch)return {items:[]};const rows=this.db.prepare("SELECT * FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND policy_version=? AND status='ready' ORDER BY sequence LIMIT 10").all(owner,agentId,Number(p.version)) as Row[];return {items:rows.map(row=>this.header(row))};}
 private assertCurrent(row:Row){if(!this.policyCurrent(row))throw new Error('memory_capture_policy_stale');}
 read(owner:string,agentId:string,id:string,processorRunId:string){this.ports.assertRun(owner,agentId,processorRunId);const row=this.row(owner,agentId,id);this.assertCurrent(row);if(!['ready','proposed','no_notes'].includes(String(row.status)))throw new Error('memory_capture_not_ready');this.requireSources(row);return this.get(owner,agentId,id);}
 propose(owner:string,agentId:string,id:string,input:Input,processorRunId:string){return withImmediateTransaction(this.db,()=>{
  this.ports.assertRun(owner,agentId,processorRunId);exact(input,['expected_version','summary','notes']);const row=this.row(owner,agentId,id);this.assertCurrent(row);expected(input.expected_version,Number(row.version));if(row.status!=='ready')throw new Error('memory_capture_state_conflict');const sources=this.requireSources(row),ids=new Set(sources.map(source=>source.source_id)),summary=text(input.summary,2000);
  if(!Array.isArray(input.notes)||input.notes.length>10)throw new Error('invalid_memory_capture');const notes:Note[]=input.notes.map(value=>{const note=value as Input;exact(note,['content','source_ids']);const content=text(note.content,3000);if(!Array.isArray(note.source_ids)||!note.source_ids.length||note.source_ids.length>20||note.source_ids.some(id=>typeof id!=='string'||!ids.has(id))||new Set(note.source_ids).size!==note.source_ids.length)throw new Error('invalid_memory_capture');return {content,source_ids:note.source_ids as string[]};});
  if(new Set(notes.map(note=>normalize(note.content))).size!==notes.length||notes.reduce((sum,note)=>sum+note.content.length,0)>20000)throw new Error('invalid_memory_capture');
  this.db.prepare('UPDATE wb_memory_captures SET proposal_json=?,processor_run_id=?,status=?,version=version+1,updated_at=? WHERE capture_id=?').run(JSON.stringify({summary,notes}),processorRunId,notes.length?'proposed':'no_notes',now(),id);return this.get(owner,agentId,id);
 });}
 apply(owner:string,agentId:string,id:string,version:number){return withImmediateTransaction(this.db,()=>{
  const row=this.row(owner,agentId,id);this.assertCurrent(row);expected(version,Number(row.version));if(row.status!=='proposed')throw new Error('memory_capture_state_conflict');const sources=new Map(this.requireSources(row).map(source=>[source.source_id,source])),proposal=JSON.parse(String(row.proposal_json)) as {notes:Note[]};
  const processing=this.db.prepare('SELECT processor_run_id FROM wb_memory_processing_runs WHERE capture_id=? AND owner_id=? AND agent_id=?').get(id,owner,agentId) as {processor_run_id:string}|undefined;
  if(processing){
   if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_model_budget_attempts'").get())throw new Error('memory_capture_unresolved_usage_held');
   const attempts=this.db.prepare(`SELECT a.state,a.bound_exceeded FROM wb_model_budget_attempts a JOIN wb_model_budget_bindings b ON b.run_id=a.run_id
    WHERE a.run_id=? AND b.owner_id=?`).all(processing.processor_run_id,owner) as Array<{state:string;bound_exceeded:number}>;
   if(!attempts.some(attempt=>attempt.state==='settled')||attempts.some(attempt=>!['settled','released'].includes(attempt.state)||attempt.bound_exceeded!==0))throw new Error('memory_capture_unresolved_usage_held');
  }
  const existing=this.db.prepare("SELECT memory_id,content,version FROM wb_memories WHERE owner_id=? AND workspace_id=? AND project_id=? AND agent_id=? AND scope='private' AND status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at,memory_id").all(owner,String(row.workspace_id),String(row.project_id),agentId,now()) as Row[],results=[];
  for(const note of proposal.notes){const prior=existing.find(value=>normalize(String(value.content))===normalize(note.content));if(prior){results.push({memory_id:String(prior.memory_id),version:Number(prior.version),reused:true});continue;}
   const refs=note.source_ids.map(id=>sources.get(id)!);const provenance=refs.map(source=>source.kind==='task_report'
    ?{kind:'task_report',reference:`${source.task_run_id}:message:${source.message_id}:certificate:${source.certificate_id}:source:${source.source_sha256}`}
    :{kind:'conversation_block',reference:source.message_id+':block:'+source.block_index});
   const revision=refs.map(source=>source.kind==='task_report'?['task_report',source.task_run_id,source.message_id,source.content_sha256,source.certificate_id,source.source_sha256]:[source.message_id,source.block_index,source.content_sha256]);
   const saved=this.ports.save(owner,String(row.workspace_id),{scope:'private',agent_id:agentId,project_id:row.project_id,content:note.content,verified:false,provenance,source_revision:digest(JSON.stringify(revision))});
   results.push({memory_id:String(saved.memory_id),version:Number(saved.version),reused:false});
  }
  this.db.prepare("UPDATE wb_memory_captures SET results_json=?,status='applied',version=version+1,updated_at=? WHERE capture_id=?").run(JSON.stringify(results),now(),id);return this.get(owner,agentId,id);
 });}
 reject(owner:string,agentId:string,id:string,version:number){return withImmediateTransaction(this.db,()=>{const row=this.row(owner,agentId,id);expected(version,Number(row.version));if(!['watching','ready','proposed'].includes(String(row.status)))throw new Error('memory_capture_state_conflict');this.db.prepare("UPDATE wb_memory_captures SET status='rejected',version=version+1,updated_at=? WHERE capture_id=?").run(now(),id);return this.get(owner,agentId,id);});}
}
