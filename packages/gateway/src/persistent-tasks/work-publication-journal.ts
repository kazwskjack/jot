import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {normalizeExecutionLease,assertExecutionLease} from '../workbench/execution-lease.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';
import type {PublicationPlan,PublicationStep,PublicationEffect,PublicationReceipt} from '../git/publication-effects.ts';

type Row=Record<string,any>;
type Kind='start'|'prepared'|'intent'|'effect'|'applied'|'finish'|'disposition';
const SHA=/^[a-f0-9]{64}$/,IDENTITY=/^[0-9]+:[0-9]+$/;
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const exact=(value:any,keys:string)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys;
function valid(value:unknown):asserts value{if(!value)throw Error('work_publication_journal_corrupt');}
const time=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value));
export const publicationWorkerResource=(row:Row)=>'git-index-binding:'+row.binding_sha256;

/** Original database only; installing storage neither starts a producer nor
 * grants a file effect. The owning bootstrap already holds its schema txn. */
export function installWorkPublicationJournal(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_work_publication_journal(
  execution_id TEXT NOT NULL REFERENCES wb_work_publication_executions(execution_id),sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('start','prepared','intent','effect','applied','finish','disposition')),
  record_json TEXT NOT NULL,record_sha256 TEXT NOT NULL,PRIMARY KEY(execution_id,sequence));
 CREATE TRIGGER IF NOT EXISTS wb_work_publication_journal_no_update BEFORE UPDATE ON wb_work_publication_journal BEGIN SELECT RAISE(ABORT,'work_publication_journal_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_publication_journal_no_delete BEFORE DELETE ON wb_work_publication_journal BEGIN SELECT RAISE(ABORT,'work_publication_journal_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_publication_journal_order BEFORE INSERT ON wb_work_publication_journal
  WHEN NEW.sequence<>COALESCE((SELECT MAX(sequence)+1 FROM wb_work_publication_journal WHERE execution_id=NEW.execution_id),1)
  BEGIN SELECT RAISE(ABORT,'work_publication_journal_sequence_invalid'); END;`);
}
function review(db:DatabaseSync,row:Row){
 const original=db.prepare('SELECT * FROM wb_work_publication_intents WHERE intent_id=?').get(row.intent_id) as Row|undefined;valid(original);
 const parse=(value:string)=>{const v=JSON.parse(value);valid(canonicalJson(v)===value);return v;};
 const selection=parse(original.selection_json),source=parse(original.source_json),target=parse(original.target_json),changes=parse(original.changes_json);
 valid(original.owner_id===row.owner_id&&original.project_id===row.project_id&&original.database_sha256===row.database_sha256
  &&original.target_binding_sha256===row.binding_sha256&&original.review_sha256===row.review_sha256
  &&hash({owner:row.owner_id,project:row.project_id,selection,source,target,changes,target_binding_sha256:row.binding_sha256,database_sha256:row.database_sha256})===row.review_sha256
  &&source.source_sha256===row.source_sha256&&target.target_sha256===row.target_sha256);
 return{selection,source,target,changes};
}
function stepsFor(plan:PublicationPlan,source:ReturnType<typeof review>):PublicationStep[]{
 valid(exact(plan,'execution_authorized,files,plan_id,protocol,repository_sha256,target_sha256')&&plan.protocol===1&&plan.execution_authorized===false
  &&/^work-publication-plan-[a-f0-9-]{36}$/.test(plan.plan_id)&&plan.target_sha256===source.target.target_sha256&&plan.repository_sha256===source.target.repository_sha256
  &&Array.isArray(plan.files)&&plan.files.length===source.selection.paths.length);
 for(const [index,file] of plan.files.entries()){
  const change=source.changes[index],before=source.target.files[index];
  valid(exact(file,'kind,mode,path,scratch,sha256,size')&&file.path===source.selection.paths[index]&&file.path===change.path&&file.kind===change.kind
   &&file.sha256===change.after.sha256&&file.size===change.after.bytes&&(before.kind==='file'?file.mode===before.mode:[0o644,0o666].includes(file.mode)));
  const parent=file.path.includes('/')?file.path.slice(0,file.path.lastIndexOf('/')+1):'';
  valid(workspaceRelativePath(file.scratch)===file.scratch&&new RegExp('^\\.jot-publication-[a-f0-9-]{36}\\.tmp$').test(file.scratch.slice(parent.length))&&file.scratch.startsWith(parent));
 }
 // The physical inspector stops at the first absent ancestor. Its descendants
 // cannot exist yet; enumerate only the remaining parents of the selected file,
 // and require each in the original inspected result manifest as a directory.
 const required=new Set<string>();
 for(const file of source.target.files){
  const missing=file.ancestors.find((parent:Row)=>parent.kind==='missing');if(!missing)continue;
  valid(typeof missing.path==='string');const parts=file.path.split('/');parts.pop();
  for(let length=1;length<=parts.length;length++){
   const path=parts.slice(0,length).join('/');if(path!==missing.path&&!path.startsWith(missing.path+'/'))continue;
   valid(source.source.work_review.result_manifest.entries.some((entry:Row)=>entry.path===path&&entry.kind==='directory'));required.add(path);
  }
 }
 const directories=[...required].sort((a,b)=>a.split('/').length-b.split('/').length||(a<b?-1:a>b?1:0));
 const result:PublicationStep[]=directories.map(path=>({plan_id:plan.plan_id,step_id:'directory:'+path,phase:'directory',path}));
 for(const file of plan.files)for(const phase of ['stage','publish'] as const)result.push({plan_id:plan.plan_id,step_id:phase+':'+file.path,phase,path:file.path,scratch:file.scratch,sha256:file.sha256,size:file.size});
 return result;
}
function effectFact(effect:PublicationEffect,expected:PublicationStep){
 const {fact,...step}=effect;valid(canonicalJson(step)===canonicalJson(expected));
 if(expected.phase==='directory'){valid(exact(fact,'identity,kind')&&fact.kind==='directory'&&IDENTITY.test(fact.identity));return;}
 valid(exact(fact,'identity,kind,mode,sha256,size,stat_sha256')&&fact.kind==='file'&&IDENTITY.test(fact.identity)&&SHA.test(fact.stat_sha256)
  &&fact.sha256===expected.sha256&&fact.size===expected.size&&Number.isSafeInteger(fact.mode)&&fact.mode>=0&&fact.mode<=0o777);
}

/** Strict historical projection. It never touches files, installs schema,
 * acquires a lease, restores authority or retries an effect. */
export function readWorkPublicationJournal(db:DatabaseSync,row:Row,now:()=>number=Date.now){
 const source=review(db,row),records:Row[]=[];
 let start:Row|undefined,preparation:Row|undefined,applied:Row|undefined,finish:Row|undefined,disposition:Row|undefined,pending:PublicationStep|undefined;
 let plan:PublicationPlan|undefined,steps:PublicationStep[]=[],effects:PublicationEffect[]=[],previous:string|null=null;
 const rows=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='wb_work_publication_journal'").get()
  ?db.prepare('SELECT * FROM wb_work_publication_journal WHERE execution_id=? ORDER BY sequence').all(row.execution_id) as Row[]:[];
 for(const saved of rows){
  const entry=JSON.parse(saved.record_json);valid(exact(entry,'execution_id,kind,payload,previous_sha256,protocol,sequence')&&entry.protocol===1&&entry.execution_id===row.execution_id
   &&entry.sequence===records.length+1&&entry.sequence===saved.sequence&&entry.kind===saved.kind&&entry.previous_sha256===previous&&canonicalJson(entry)===saved.record_json&&hash(entry)===saved.record_sha256&&!disposition&&(!finish||entry.kind==='disposition'));
  const payload=entry.payload;
  if(entry.kind==='start'){
   valid(!records.length&&exact(payload,'execution_sha256,lease,started_at')&&payload.execution_sha256===hash(row)&&time(payload.started_at));
   normalizeExecutionLease(payload.lease);valid(/^work-publisher-[a-f0-9-]{36}$/.test(payload.lease.owner));start={...entry,sha256:saved.record_sha256};
  }else{
   valid(start);
   if(entry.kind==='prepared'){valid(!plan&&!pending&&!applied);plan=payload;steps=stepsFor(plan!,source);preparation={...entry,sha256:saved.record_sha256};}
   else if(entry.kind==='intent'){valid(plan&&!pending&&!applied&&canonicalJson(payload)===canonicalJson(steps[effects.length]));pending=payload;}
   else if(entry.kind==='effect'){valid(plan&&pending&&!applied);effectFact(payload,pending);if(pending.phase!=='directory')valid(payload.fact.mode===plan.files.find(file=>file.path===pending!.path)?.mode);effects.push(payload);pending=undefined;}
   else if(entry.kind==='applied'){
    valid(plan&&!pending&&!applied&&effects.length===steps.length&&exact(payload,'execution_authorized,files,plan_id,protocol,state,target_sha256')
     &&payload.protocol===1&&payload.execution_authorized===false&&payload.state==='applied'&&payload.plan_id===plan.plan_id&&payload.target_sha256===row.target_sha256);
    const files=effects.filter(e=>e.phase==='publish').map(e=>{const {kind,...fact}=e.fact;return{path:e.path,...fact};});
    valid(canonicalJson(payload.files)===canonicalJson(files));applied={...entry,sha256:saved.record_sha256};
   }else if(entry.kind==='finish'){
    const state=applied?'applied':effects.length||pending?'unknown':plan?'prepared':payload.state==='cancelled_before_preparation'?'cancelled_before_preparation':'failed_before_preparation';
    valid(exact(payload,'finished_at,state')&&time(payload.finished_at)&&payload.state===state);finish={...entry,sha256:saved.record_sha256};
   }else if(entry.kind==='disposition'){
    valid(exact(payload,'acknowledge_unknown,action,expected_journal_sha256,request_id,settled_at')&&payload.acknowledge_unknown===true
     &&typeof payload.request_id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(payload.request_id)&&payload.expected_journal_sha256===previous&&time(payload.settled_at)
     &&(payload.action==='confirm_recorded'?!!applied:payload.action==='abandon_unknown'&&!applied));
    disposition={...entry,sha256:saved.record_sha256};
   }else valid(false);
  }
  previous=saved.record_sha256;records.push({...entry,sha256:saved.record_sha256});
 }
 let state:string='not_started';
 if(start){if(disposition)state=disposition.payload.action==='confirm_recorded'?'applied':'abandoned_unknown';else if(finish)state=finish.payload.state;else{try{assertExecutionLease(db,publicationWorkerResource(row),start.payload.lease,now);state='running';}catch{state='interrupted';}}}
 return{state,start,preparation,applied,finish,disposition,plan,steps,effects,pending,records,tail_sha256:previous,receipt:applied?.payload as PublicationReceipt|undefined};
}
export function appendWorkPublicationJournal(db:DatabaseSync,row:Row,kind:Kind,payload:unknown){
 if(!db.isTransaction)throw Error('work_publication_transaction_required');
 const current=readWorkPublicationJournal(db,row),entry={protocol:1,execution_id:row.execution_id,sequence:current.records.length+1,kind,previous_sha256:current.tail_sha256,payload};
 db.prepare('INSERT INTO wb_work_publication_journal VALUES(?,?,?,?,?)').run(row.execution_id,entry.sequence,kind,canonicalJson(entry),hash(entry));
 return readWorkPublicationJournal(db,row);
}
export function publicationSettlementEvidence(db:DatabaseSync,source:{operation_id:string;owner_id:string;project_id:string;binding_sha256:string}){
 for(const table of ['wb_work_publication_executions','wb_work_publication_intents','wb_work_publication_journal'])if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))throw Error('workspace_publication_producer_unsettled');
 const row=db.prepare('SELECT * FROM wb_work_publication_executions WHERE execution_id=? AND owner_id=? AND project_id=? AND binding_sha256=?').get(source.operation_id,source.owner_id,source.project_id,source.binding_sha256) as Row|undefined;
 if(!row)throw Error('workspace_publication_producer_unsettled');const journal=readWorkPublicationJournal(db,row);
 if(!journal.start||db.prepare('SELECT 1 FROM ga_worker_leases WHERE resource_id=?').get(publicationWorkerResource(row)))throw Error('workspace_publication_producer_unsettled');
 if(journal.disposition)return{outcome_sha256:(journal.applied?.sha256??journal.disposition.sha256) as string,producer_sha256:journal.start.sha256 as string,finish_sha256:journal.disposition.sha256 as string};
 if(journal.state!=='applied'||!journal.applied||!journal.finish)throw Error('workspace_publication_producer_unsettled');
 return{outcome_sha256:journal.applied.sha256 as string,producer_sha256:journal.start.sha256 as string,finish_sha256:journal.finish.sha256 as string};
}
