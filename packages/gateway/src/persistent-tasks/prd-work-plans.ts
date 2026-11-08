import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {workspaceSelection,workspaceRelativePath} from '../always-on/workspace-provider.ts';

type Row=Record<string,any>;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const digest=(value:unknown)=>hash(canonicalJson(value));
const invalid=()=>Error('invalid_prd_work_plan');
function object(value:unknown,keys:string[]):Row{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw invalid();
 return value as Row;
}
function text(value:unknown,max=4000):string{
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)||Buffer.from(value,'utf8').toString('utf8')!==value)throw invalid();
 return value.trim();
}
function lines(value:unknown):string[]{
 if(!Array.isArray(value)||!value.length||value.length>32)throw invalid();
 return value.map(item=>text(item));
}

export function installPrdWorkPlans(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_prd_work_plans(
  plan_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),
  binding_id TEXT NOT NULL REFERENCES wb_task_prd_bindings(binding_id),occurrence_id TEXT NOT NULL REFERENCES wb_task_occurrences(occurrence_id),
  root_run_id TEXT NOT NULL REFERENCES ga_runs(id),run_id TEXT NOT NULL REFERENCES ga_runs(id),call_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,snapshot_sha256 TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(run_id,call_id));
  CREATE INDEX IF NOT EXISTS wb_task_prd_work_plan_scope ON wb_task_prd_work_plans(owner_id,task_id);
  CREATE TRIGGER IF NOT EXISTS wb_task_prd_work_plan_no_replace BEFORE INSERT ON wb_task_prd_work_plans
   WHEN EXISTS(SELECT 1 FROM wb_task_prd_work_plans WHERE plan_id=NEW.plan_id OR run_id=NEW.run_id AND call_id=NEW.call_id)
   BEGIN SELECT RAISE(ABORT,'task_prd_work_plan_immutable'); END;`);
 for(const op of ['UPDATE','DELETE']){
  db.exec(`CREATE TRIGGER IF NOT EXISTS wb_task_prd_work_plan_no_${op.toLowerCase()} BEFORE ${op} ON wb_task_prd_work_plans
   BEGIN SELECT RAISE(ABORT,'task_prd_work_plan_immutable'); END;`);
 }
}

function view(row:Row){
 const snapshot=JSON.parse(row.snapshot_json);
 if(canonicalJson(snapshot)!==row.snapshot_json||digest(snapshot)!==row.snapshot_sha256||snapshot.plan_id!==row.plan_id
  ||snapshot.task_id!==row.task_id||snapshot.source.binding_id!==row.binding_id||snapshot.occurrence_id!==row.occurrence_id
  ||snapshot.root_run_id!==row.root_run_id||snapshot.run_id!==row.run_id||snapshot.call_id!==row.call_id||snapshot.created_at!==row.created_at
  ||snapshot.execution_authorized!==false||snapshot.accepted!==false)throw Error('prd_work_plan_integrity_failed');
 return {...snapshot,sha256:String(row.snapshot_sha256)};
}

/** Proposal material only. Original task/role, current ledger and pinned source are supplied by the scoped service. */
export function proposePrdWorkPlan(db:DatabaseSync,owner:string,runId:string,callId:string,task:Row,role:Row,source:Row,subtasks:unknown[],input:unknown){
 if(!db.isTransaction)throw Error('prd_work_plan_transaction_required');
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callId))throw invalid();
 const request=object(input,['summary','rationale','changes','evidence']),requestHash=digest(request);
 if(Buffer.byteLength(canonicalJson(request),'utf8')>131072)throw invalid();
 const prior=db.prepare('SELECT * FROM wb_task_prd_work_plans WHERE owner_id=? AND run_id=? AND call_id=?').get(owner,runId,callId) as Row|undefined;
 if(prior){
  if(prior.request_sha256!==requestHash)throw Error('idempotency_conflict');
  return view(prior);
 }
 const summary=text(request.summary),rationale=text(request.rationale,8000);
 if(!Array.isArray(request.changes)||!request.changes.length||request.changes.length>32)throw invalid();
 const changes=request.changes.map((item:unknown)=>{
  const change=object(item,['path','description','steps','verification']),path=workspaceRelativePath(change.path);
  if(path.length>400||Buffer.from(path,'utf8').toString('utf8')!==path)throw invalid();
  return {path,description:text(change.description),steps:lines(change.steps),verification:lines(change.verification)};
 });
 workspaceSelection(changes.map(change=>change.path));
 if(!Array.isArray(request.evidence)||!request.evidence.length||request.evidence.length>256)throw invalid();
 const bytes=Buffer.from(source.content,'utf8'),descriptor=JSON.parse(source.source_json);
 if(bytes.length>1048576||hash(bytes)!==source.content_sha256||descriptor.sha256!==source.content_sha256||descriptor.size!==bytes.length)throw Error('prd_source_integrity_failed');
 const seen=new Set<string>(),ranges:{start:number;end:number}[]=[];
 const evidence=request.evidence.map((item:unknown)=>{
  const ref=object(item,['kind','reference','hash']);
  if(ref.kind!=='tool_receipt'||typeof ref.reference!=='string'||!ref.reference||ref.reference.length>200||typeof ref.hash!=='string'||!/^[a-f0-9]{64}$/.test(ref.hash)||seen.has(ref.reference))throw invalid();
  seen.add(ref.reference);
  const read=db.prepare(`SELECT e.*,w.response_json FROM wb_task_execution_receipts e JOIN wb_tool_receipts w ON w.run_id=e.run_id AND w.call_id=e.call_id
   JOIN wb_task_run_occurrences o ON o.run_id=e.run_id JOIN wb_persistent_tasks t ON t.task_id=o.task_id
   WHERE e.receipt_id=? AND e.operation='tasks.prd.read' AND t.owner_id=? AND o.task_id=? AND o.occurrence_id=?`)
   .get(ref.reference,owner,task.task_id,source.occurrence_id) as Row|undefined;
  if(!read||read.result_hash!==ref.hash)throw Error('prd_work_plan_read_unverified');
  const {execution_receipt,...result}=JSON.parse(read.response_json),start=result.offset_bytes,length=result.returned_bytes;
  if(canonicalJson(execution_receipt)!==canonicalJson(ref)||hash(JSON.stringify(result))!==read.result_hash||result.binding_id!==source.binding_id
   ||result.content_sha256!==source.content_sha256||result.size!==bytes.length||canonicalJson(result.source)!==canonicalJson(descriptor)
   ||result.source_untrusted!==true||result.execution_authorized!==false||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(length)||length<0||length>65536
   ||start+length>bytes.length||typeof result.content!=='string'||!Buffer.from(result.content,'utf8').equals(bytes.subarray(start,start+length))||result.eof!==(start+length===bytes.length))throw Error('prd_work_plan_read_unverified');
  ranges.push({start,end:start+length});
  return {kind:'tool_receipt' as const,reference:ref.reference as string,hash:ref.hash as string};
 });
 let end=0;
 for(const range of ranges.sort((a,b)=>a.start-b.start)){
  if(range.start>end)throw Error('prd_work_plan_full_read_required');
  end=Math.max(end,range.end);
 }
 if(end!==bytes.length)throw Error('prd_work_plan_full_read_required');
 let ledgerBytes=0;
 for(const subtask of subtasks){
  ledgerBytes+=Buffer.byteLength(canonicalJson(subtask),'utf8');
  if(ledgerBytes>4194304)throw Error('invalid_prd_work_plan_ledger_too_large');
 }
 const at=new Date().toISOString(),planId='prd-plan-'+digest({owner,run_id:runId,call_id:callId});
 const snapshot={protocol:1,plan_id:planId,task_id:task.task_id,task_version:task.version,objective_sha256:hash(task.objective),
  role:{agent_id:role.agent_id,version:role.version,capability_epoch:role.capability_epoch,workspace_id:role.workspace_id,project_id:role.project_id},
  source:{binding_id:source.binding_id,content_sha256:source.content_sha256,size:bytes.length},occurrence_id:source.occurrence_id,root_run_id:source.root_run_id,run_id:runId,call_id:callId,
  summary,rationale,changes,evidence,subtasks,ledger_sha256:digest(subtasks),created_at:at,accepted:false,execution_authorized:false};
 const snapshotHash=digest(snapshot);
 db.prepare('INSERT INTO wb_task_prd_work_plans VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(planId,owner,task.task_id,source.binding_id,source.occurrence_id,source.root_run_id,runId,callId,requestHash,snapshotHash,canonicalJson(snapshot),at);
 return {...snapshot,sha256:snapshotHash};
}

export function listPrdWorkPlans(db:DatabaseSync,owner:string,taskId:string,before:unknown){
 if(before!==undefined&&(typeof before!=='string'||!before||before.length>200))throw invalid();
 let boundary=Number.MAX_SAFE_INTEGER;
 if(before!==undefined){
  const row=db.prepare('SELECT rowid sequence FROM wb_task_prd_work_plans WHERE owner_id=? AND task_id=? AND plan_id=?').get(owner,taskId,before as string);
  if(!row)throw invalid();
  boundary=Number(row.sequence);
 }
 const rows=db.prepare('SELECT rowid sequence,plan_id FROM wb_task_prd_work_plans WHERE owner_id=? AND task_id=? AND rowid<? ORDER BY rowid DESC LIMIT 21').all(owner,taskId,boundary) as Row[];
 return {task_id:taskId,items:rows.slice(0,20).map(row=>{
  const plan=getPrdWorkPlan(db,owner,taskId,String(row.plan_id));
  return {plan_id:plan.plan_id,sha256:plan.sha256,task_version:plan.task_version,binding_id:plan.source.binding_id,
   occurrence_id:plan.occurrence_id,run_id:plan.run_id,summary:plan.summary,path_count:plan.changes.length,subtask_count:plan.subtasks.length,created_at:plan.created_at,accepted:false,execution_authorized:false};
 }),next_before_id:rows.length>20?String(rows[19]!.plan_id):null,execution_authorized:false as const};
}

export function getPrdWorkPlan(db:DatabaseSync,owner:string,taskId:string,planId:string){
 if(typeof planId!=='string'||!planId||planId.length>200)throw invalid();
 const row=db.prepare('SELECT * FROM wb_task_prd_work_plans WHERE owner_id=? AND task_id=? AND plan_id=?').get(owner,taskId,planId) as Row|undefined;
 if(!row)throw Error('prd_work_plan_not_found');
 return view(row);
}
