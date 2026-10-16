import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {WorkbenchService} from '../workbench/service.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {TaskExecutionEvidence} from '../persistent-tasks/execution-evidence.ts';
import {occurrenceSubtaskRows} from '../persistent-tasks/subtask-state.ts';
import {discoverySourceId,discoverySourceHash} from './source-collector.ts';
type Row=Record<string,any>;
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
function exact(value:unknown,keys:string[]):Row{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw Error('discovery_planning_invalid');return value as Row;}
function text(value:unknown,max=4000):string{if(typeof value!=='string'||!value.trim()||value.length>max||/\u0000/.test(value))throw Error('discovery_planning_invalid');return value.trim();}
function strings(value:unknown,max=32):string[]{if(!Array.isArray(value)||value.length>max)throw Error('discovery_planning_invalid');return value.map(v=>text(v));}
function count(value:unknown,min=0){if(!Number.isSafeInteger(value)||Number(value)<min)throw Error('discovery_planning_invalid');return Number(value);}

export function installDiscoveryPlanning(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS wb_discovery_plans(plan_id TEXT PRIMARY KEY,admission_id TEXT NOT NULL REFERENCES wb_discovery_admissions(admission_id),
  occurrence_id TEXT NOT NULL REFERENCES wb_task_occurrences(occurrence_id),run_id TEXT NOT NULL REFERENCES ga_runs(id),call_id TEXT NOT NULL,
  scope_sha256 TEXT NOT NULL,payload_sha256 TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,proposal_sha256 TEXT NOT NULL,
  UNIQUE(run_id,call_id),UNIQUE(admission_id,proposal_sha256));
 CREATE TABLE IF NOT EXISTS wb_discovery_reports(report_id TEXT PRIMARY KEY,admission_id TEXT NOT NULL REFERENCES wb_discovery_admissions(admission_id),
  occurrence_id TEXT NOT NULL REFERENCES wb_task_occurrences(occurrence_id),run_id TEXT NOT NULL REFERENCES ga_runs(id),call_id TEXT NOT NULL,
  scope_sha256 TEXT NOT NULL,payload_sha256 TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(run_id,call_id));`);
 db.exec(`CREATE TABLE IF NOT EXISTS wb_discovery_source_reads(receipt_id TEXT PRIMARY KEY REFERENCES wb_task_execution_receipts(receipt_id),
  admission_id TEXT NOT NULL REFERENCES wb_discovery_admissions(admission_id),revision INTEGER NOT NULL,source_sha256 TEXT NOT NULL,
  offset INTEGER NOT NULL CHECK(offset>=0),next_offset INTEGER CHECK(next_offset IS NULL OR next_offset>offset));
 CREATE TRIGGER IF NOT EXISTS wb_discovery_source_reads_valid BEFORE INSERT ON wb_discovery_source_reads
 WHEN NOT EXISTS(SELECT 1 FROM wb_task_execution_receipts e JOIN wb_task_run_occurrences o ON o.run_id=e.run_id
  JOIN wb_discovery_admissions a ON a.occurrence_id=o.occurrence_id JOIN wb_discovery_signals s ON s.policy_id=a.policy_id
  WHERE e.receipt_id=NEW.receipt_id AND e.operation='discovery.source' AND a.admission_id=NEW.admission_id
   AND s.revision=NEW.revision AND s.revision<=a.signal_revision AND s.source_sha256=NEW.source_sha256)
 BEGIN SELECT RAISE(ABORT,'discovery_source_unavailable'); END;`);
 for(const table of ['wb_discovery_plans','wb_discovery_reports','wb_discovery_source_reads']){
  for(const op of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'discovery_planning_immutable'); END;`);
  const key=table==='wb_discovery_plans'?'plan_id':table==='wb_discovery_reports'?'report_id':'receipt_id';
  const conflict=table==='wb_discovery_source_reads'?`${key}=NEW.${key}`:`${key}=NEW.${key} OR (run_id=NEW.run_id AND call_id=NEW.call_id)`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${conflict}) BEGIN SELECT RAISE(ABORT,'discovery_planning_immutable'); END;`);
 }
}

/** Original occurrence-owned proposals and reports. These records are evidence,
 * never business acceptance, project-file writes, permissions or a work loop. */
export class DiscoveryPlanning{
 private readonly db:DatabaseSync;private readonly workbench:WorkbenchService|undefined;
 constructor(db:DatabaseSync,workbench?:WorkbenchService){this.db=db;this.workbench=workbench;}
 private find(run:string){return this.db.prepare(`SELECT a.*,a.rowid AS admission_sequence,b.agent_id,b.project_id,b.workspace_id,t.version AS current_task_version,t.generation AS current_generation,
   t.status AS task_status,p.state AS policy_state,p.version AS current_policy_version,role.status AS role_status,role.version AS current_role_version,role.capability_epoch,
   r.conversation_id,r.status AS run_status FROM wb_discovery_admissions a JOIN wb_discovery_task_bindings b ON b.policy_id=a.policy_id
   JOIN wb_task_current_occurrences o ON o.occurrence_id=a.occurrence_id JOIN ga_runs r ON r.id=o.run_id
   JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=a.owner_id AND c.project_id=b.project_id AND c.workspace_id=b.workspace_id
   JOIN wb_persistent_tasks t ON t.task_id=a.task_id JOIN wb_discovery_policies p ON p.policy_id=a.policy_id
   JOIN wb_agents role ON role.agent_id=b.agent_id AND role.owner_id=a.owner_id WHERE o.run_id=?`).get(run) as Row|undefined;}
 private scope(run:string){
  const row=this.find(run);if(!row)throw Error('discovery_not_bound');
  if(row.policy_state!=='active'||row.current_policy_version!==row.policy_version||row.role_status!=='active'
    ||row.current_role_version!==row.role_version||row.capability_epoch!==row.role_epoch||row.current_generation!==row.task_generation
    ||row.current_task_version!==row.task_version||!['active','budget_exhausted'].includes(row.task_status)
    ||!['queued','starting','running','waiting_user','waiting_approval'].includes(row.run_status))throw Error('discovery_authority_revoked');
  const head=this.db.prepare('SELECT coalesce(max(revision),0) n FROM wb_discovery_signals WHERE policy_id=?').get(row.policy_id) as Row;
  if(head.n!==row.signal_revision)throw Error('discovery_source_changed');
  return row;
 }
 private from(row:Row){return Number((this.db.prepare('SELECT coalesce(max(signal_revision),0) n FROM wb_discovery_admissions WHERE policy_id=? AND rowid<?').get(row.policy_id,row.admission_sequence) as Row).n);}
 private base(row:Row){return {admission_id:row.admission_id,occurrence_id:row.occurrence_id,task_id:row.task_id,policy_version:row.policy_version,
   role_version:row.role_version,role_epoch:row.role_epoch,task_generation:row.task_generation,task_version:row.task_version,
   signal_from_revision:this.from(row),signal_revision:row.signal_revision,signal_sha256:row.signal_sha256};}
 private reportScope(row:Row,run:string){
  const steps=occurrenceSubtaskRows(this.db,row.task_id,row.occurrence_id).map(step=>({id:step.subtask_id,version:step.version,status:step.status,evidence:step.evidence_json}));
  const inputs=this.db.prepare("SELECT id,created_at,updated_at,status FROM ga_messages WHERE conversation_id=? AND role='user' ORDER BY id").all(row.conversation_id);
  const plans=this.db.prepare('SELECT plan_id,payload_sha256,scope_sha256 FROM wb_discovery_plans WHERE occurrence_id=? ORDER BY plan_id').all(row.occurrence_id);
  return digest({base:this.base(row),run,steps,inputs,plans});
 }
 context(run:string,after=0,planId?:string,afterPlan=''){
  const row=this.scope(run),cursor=count(after),plans=this.db.prepare('SELECT plan_id,payload_json FROM wb_discovery_plans WHERE occurrence_id=? AND plan_id>? ORDER BY plan_id LIMIT 50').all(row.occurrence_id,afterPlan===''?'':text(afterPlan,128)) as Row[];
  const selected=planId===undefined?undefined:this.db.prepare('SELECT plan_id,payload_json FROM wb_discovery_plans WHERE occurrence_id=? AND plan_id=?').get(row.occurrence_id,text(planId,128)) as Row|undefined;
  if(planId!==undefined&&!selected)throw Error('discovery_source_unavailable');
  return {admission:this.base(row),sources:this.db.prepare(`SELECT revision,kind,source_id,source_version,source_sha256 FROM wb_discovery_signals
   WHERE policy_id=? AND revision>? AND revision<=? ORDER BY revision LIMIT 50`).all(row.policy_id,Math.max(cursor,this.from(row)),row.signal_revision),
   plans:plans.map(p=>({plan_id:p.plan_id,summary:JSON.parse(p.payload_json).summary})),next_plan_id:plans.length===50?plans.at(-1)!.plan_id:null,
   ...(selected?{plan:{plan_id:selected.plan_id,...JSON.parse(selected.payload_json)}}:{}),accepted:false};
 }
 source(run:string,input:unknown){
  const value=exact(input,['revision','offset']),row=this.scope(run),revision=count(value.revision,1),offset=count(value.offset);
  const signal=this.db.prepare('SELECT * FROM wb_discovery_signals WHERE policy_id=? AND revision=? AND revision<=?').get(row.policy_id,revision,row.signal_revision) as Row|undefined;
  if(!signal||revision<=this.from(row))throw Error('discovery_source_unavailable');
  let content:string|undefined,path:string|undefined,images_omitted=false;
  if(signal.kind==='workspace_change'){
   const files=this.db.prepare('SELECT path,version,sha256,size,created_at FROM wb_file_versions WHERE owner_id=? AND project_id=? AND workspace_id=? AND version=?').all(row.owner_id,row.project_id,row.workspace_id,signal.source_version) as Row[];
   const file=files.find(f=>discoverySourceId('file',f.path)===signal.source_id);
   if(!file||discoverySourceHash(file)!==signal.source_sha256||!this.workbench)throw Error('discovery_source_unavailable');
   path=file.path;
   try{content=this.workbench.readFileVersion(row.owner_id,row.workspace_id,row.project_id,file.path,file.version,run).content;}
   catch(error){
    const message=error instanceof Error?error.message:'';
    if(message==='file_integrity_failed')throw Error('discovery_source_integrity_failed');
    if(message==='file_not_found'||(error as NodeJS.ErrnoException)?.code==='ENOENT')throw Error('discovery_source_unavailable');
    throw error;
   }
  }else if(signal.kind==='user_input'){
   const messages=this.db.prepare(`SELECT m.id,m.run_id,m.conversation_id,m.created_at,m.updated_at,b.epoch FROM ga_messages m JOIN ga_runs r ON r.id=m.run_id AND r.conversation_id=m.conversation_id
    JOIN ga_conversations c ON c.id=m.conversation_id JOIN wb_run_bindings b ON b.run_id=r.id AND b.owner_id=c.owner_id AND b.kind='chat'
    JOIN wb_agents a ON a.agent_id=b.agent_id AND a.owner_id=c.owner_id AND a.conversation_id=c.id
    WHERE c.owner_id=? AND c.project_id=? AND c.workspace_id=? AND a.agent_id=? AND m.role='user' AND m.status='complete'`).all(row.owner_id,row.project_id,row.workspace_id,row.agent_id) as Row[];
   const message=messages.find(m=>discoverySourceId('message',m.id)===signal.source_id);
   if(!message||discoverySourceHash(message)!==signal.source_sha256)throw Error('discovery_source_unavailable');
   const stored=this.db.prepare('SELECT content_json FROM ga_messages WHERE id=?').get(message.id) as Row;
   const blocks=JSON.parse(stored.content_json).blocks;if(!Array.isArray(blocks))throw Error('discovery_source_unavailable');
   content=blocks.filter(b=>b.kind==='text'&&typeof b.text==='string').map(b=>b.text).join('\n');images_omitted=blocks.some(b=>b.kind!=='text');
  }
  if(content===undefined||offset>content.length)throw Error('discovery_source_unavailable');
  if(offset>0&&/[\uDC00-\uDFFF]/.test(content[offset]??'')&&/[\uD800-\uDBFF]/.test(content[offset-1]??''))throw Error('discovery_planning_invalid');
  let end=Math.min(content.length,offset+32768);
  if(end<content.length&&/[\uD800-\uDBFF]/.test(content[end-1]??'')&&/[\uDC00-\uDFFF]/.test(content[end]??''))end--;
  return {revision,offset,source_sha256:signal.source_sha256,...(path?{path}:{}),text:content.slice(offset,end),next_offset:end<content.length?end:null,images_omitted,trusted:false};
 }
 /** Called by original transport only after actual retrieval and attestation. */
 recordRead(run:string,receipt:string,result:Row){const row=this.scope(run);this.db.prepare('INSERT INTO wb_discovery_source_reads VALUES(?,?,?,?,?,?)').run(receipt,row.admission_id,result.revision,result.source_sha256,result.offset,result.next_offset);}
 private coverage(row:Row){
  const signals=this.db.prepare('SELECT revision,source_sha256 FROM wb_discovery_signals WHERE policy_id=? AND revision>? AND revision<=? ORDER BY revision').all(row.policy_id,this.from(row),row.signal_revision) as Row[];
  const reads=this.db.prepare('SELECT revision,source_sha256,offset,next_offset FROM wb_discovery_source_reads WHERE admission_id=? ORDER BY revision,offset').all(row.admission_id) as Row[];
  let fully_read=0;
  for(const signal of signals){let offset:number|null=0;const chunks=reads.filter(r=>r.revision===signal.revision&&r.source_sha256===signal.source_sha256);
   for(let i=0;i<=chunks.length&&offset!==null;i++){const chunk=chunks.find(c=>c.offset===offset);if(!chunk)break;offset=chunk.next_offset;}
   if(offset===null)fully_read++;
  }
  return {signal_count:signals.length,fully_read};
 }
 private evidence(row:Row,value:unknown){
  if(!Array.isArray(value)||!value.length||value.length>100)throw Error('discovery_evidence_required');
  const proof=new TaskExecutionEvidence(this.db);
  return value.map(ref=>{const r=exact(ref,['kind','reference','hash']);
   const receipt=this.db.prepare('SELECT operation FROM wb_task_execution_receipts WHERE receipt_id=?').get(r.reference) as Row|undefined;
   if(r.kind!=='tool_receipt'||typeof r.hash!=='string'||!/^[a-f0-9]{64}$/.test(r.hash)||!proof.verified(row.owner_id,row.task_id,r as any,row.occurrence_id)
     ||!receipt||!['files.read','web.read','discovery.source','universe_search'].includes(receipt.operation))throw Error('discovery_evidence_required');
   return {kind:r.kind,reference:r.reference,hash:r.hash};});
 }
 private store(table:'wb_discovery_plans'|'wb_discovery_reports',row:Row,run:string,call:string,payload:unknown,scopeHash:string,proposalKey?:string){
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(call))throw Error('invalid_call_id');const key=table==='wb_discovery_plans'?'plan_id':'report_id',sha=digest(payload);
  const prior=this.db.prepare(`SELECT * FROM ${table} WHERE run_id=? AND call_id=?`).get(run,call) as Row|undefined;
  if(prior){if(prior.payload_sha256!==sha||prior.scope_sha256!==scopeHash)throw Error('idempotency_conflict');return {[key]:prior[key],sha256:sha,accepted:false};}
  if(table==='wb_discovery_plans'){
   const duplicate=this.db.prepare('SELECT plan_id,payload_sha256 FROM wb_discovery_plans WHERE admission_id=? AND proposal_sha256=?').get(row.admission_id,proposalKey!) as Row|undefined;
   if(duplicate)return {plan_id:duplicate.plan_id,sha256:duplicate.payload_sha256,accepted:false,deduplicated:true};
  }
  const id=(key==='plan_id'?'discovery-plan-':'discovery-report-')+digest([run,call]);
  const values=[id,row.admission_id,row.occurrence_id,run,call,scopeHash,sha,canonicalJson(payload),new Date().toISOString()];
  this.db.prepare(`INSERT INTO ${table} VALUES(${table==='wb_discovery_plans'?'?,?,?,?,?,?,?,?,?,?':'?,?,?,?,?,?,?,?,?'})`).run(...(table==='wb_discovery_plans'?[...values,proposalKey!]:values));
  return {[key]:id,sha256:sha,accepted:false};
 }
 plan(run:string,call:string,input:unknown){return withImmediateTransaction(this.db,()=>{
  const row=this.scope(run),value=exact(input,['summary','rationale','changes','evidence']);
  if(!Array.isArray(value.changes)||!value.changes.length||value.changes.length>32)throw Error('discovery_planning_invalid');
  const changes=value.changes.map(change=>{const c=exact(change,['path','description','steps','verification']),path=text(c.path,400),steps=strings(c.steps),verification=strings(c.verification);
   if(path.startsWith('/')||/[\\:\u0000-\u001f\u007f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||!steps.length||!verification.length)throw Error('discovery_planning_invalid');
   return {path,description:text(c.description),steps,verification};});
  const evidence=this.evidence(row,value.evidence),normalize=(s:string)=>s.normalize('NFKC').replace(/\s+/g,' ').trim();
  const objective=changes.map(c=>({...c,description:normalize(c.description),steps:c.steps.map(normalize),verification:c.verification.map(normalize)}));
  return this.store('wb_discovery_plans',row,run,call,{summary:text(value.summary),rationale:text(value.rationale,8000),changes,evidence},digest(this.base(row)),
   digest({base:this.base(row),objective,sources:[...new Set(evidence.map(e=>e.hash))].sort()}));
 });}
 report(run:string,call:string,input:unknown){return withImmediateTransaction(this.db,()=>{
  const row=this.scope(run),value=exact(input,['outcome','summary','limitations','plan_ids','evidence']);
  if(!['proposals','no_plan','blocked'].includes(value.outcome))throw Error('discovery_planning_invalid');
  const plans=this.db.prepare('SELECT plan_id,scope_sha256 FROM wb_discovery_plans WHERE occurrence_id=? ORDER BY plan_id').all(row.occurrence_id) as Row[];
  const requested=strings(value.plan_ids,32),ids=plans.map(p=>p.plan_id),limitations=strings(value.limitations);
  if(new Set(requested).size!==requested.length||requested.length&&canonicalJson([...requested].sort())!==canonicalJson(ids)||plans.some(p=>p.scope_sha256!==digest(this.base(row)))
    ||value.outcome==='no_plan'&&ids.length||value.outcome==='proposals'&&!ids.length||value.outcome==='blocked'&&!limitations.length)throw Error('discovery_planning_invalid');
  const steps=occurrenceSubtaskRows(this.db,row.task_id,row.occurrence_id),proof=new TaskExecutionEvidence(this.db);
  if(!steps.length||steps.some(s=>s.status!=='completed'||!proof.completionVerified(row.owner_id,row.task_id,JSON.parse(s.evidence_json),row.occurrence_id,s.subtask_id)))throw Error('discovery_report_steps_incomplete');
  const coverage=this.coverage(row);
  if(coverage.fully_read!==coverage.signal_count&&(value.outcome==='no_plan'||!limitations.length))throw Error('discovery_report_source_coverage_required');
  return this.store('wb_discovery_reports',row,run,call,{outcome:value.outcome,summary:text(value.summary,8000),limitations,plan_ids:[...ids].sort(),evidence:this.evidence(row,value.evidence),coverage},this.reportScope(row,run));
 });}
 completion(run:string){
  if(!this.find(run))return undefined;const row=this.scope(run),report=this.db.prepare('SELECT * FROM wb_discovery_reports WHERE occurrence_id=? ORDER BY rowid DESC LIMIT 1').get(row.occurrence_id) as Row|undefined;
  if(!report)throw Error('discovery_report_required');
  if(report.run_id!==run||report.scope_sha256!==this.reportScope(row,run)||digest(JSON.parse(report.payload_json))!==report.payload_sha256)throw Error('discovery_report_stale');
  return {report_id:report.report_id,sha256:report.payload_sha256,...JSON.parse(report.payload_json)};
 }
}
