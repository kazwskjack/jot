import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {ProjectRepository} from '../projects/repository.ts';
import {retainOriginalGitDatabase} from '../git/database-identity.ts';
import type {GitWorkbench} from '../git/service.ts';
import type {GitPublicationTargetRead} from '../git/inspection.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';
import {freezeWorkAdmission} from '../always-on/work-admission-records.ts';
import {FinalizedWorkSources} from './finalized-work-sources.ts';

type Row=Record<string,any>;
export type WorkPublicationPrepare={request_id:string;source_run_id:string;source_sha256:string;paths:readonly string[]};
export type WorkPublicationControl={request_id:string;expected_version:number;action:'approve'|'cancel';review_sha256:string};
type Source=ReturnType<FinalizedWorkSources['summary']>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/;
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const exact=(value:unknown,keys:string[]):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function fail(code:string):never{throw Error('work_publication_'+code);}
function json(value:string){const parsed=JSON.parse(value);if(canonicalJson(parsed)!==value)fail('corrupt');return parsed;}

/** Explicit bootstrap only. Construction and all historical reads perform no DDL. */
export function installWorkPublicationIntents(db:DatabaseSync){
 const install=()=>db.exec(`CREATE TABLE IF NOT EXISTS wb_work_publication_intents(
  intent_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES ga_projects(id),
  source_run_id TEXT NOT NULL REFERENCES ga_runs(id),request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,
  selection_json TEXT NOT NULL,source_json TEXT NOT NULL,target_json TEXT NOT NULL,changes_json TEXT NOT NULL,
  target_binding_sha256 TEXT NOT NULL,database_sha256 TEXT NOT NULL,review_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
  UNIQUE(owner_id,project_id,request_id));
 CREATE TABLE IF NOT EXISTS wb_work_publication_events(
  intent_id TEXT NOT NULL REFERENCES wb_work_publication_intents(intent_id),version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','approved','cancelled')),request_id TEXT,request_sha256 TEXT,created_at TEXT NOT NULL,
  PRIMARY KEY(intent_id,version),UNIQUE(intent_id,request_id));
 CREATE TRIGGER IF NOT EXISTS wb_work_publication_intent_no_update BEFORE UPDATE ON wb_work_publication_intents BEGIN SELECT RAISE(ABORT,'work_publication_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_publication_intent_no_delete BEFORE DELETE ON wb_work_publication_intents BEGIN SELECT RAISE(ABORT,'work_publication_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_publication_intent_no_replace BEFORE INSERT ON wb_work_publication_intents
  WHEN EXISTS(SELECT 1 FROM wb_work_publication_intents WHERE intent_id=NEW.intent_id OR owner_id=NEW.owner_id AND project_id=NEW.project_id AND request_id=NEW.request_id)
  BEGIN SELECT RAISE(ABORT,'work_publication_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_publication_event_no_update BEFORE UPDATE ON wb_work_publication_events BEGIN SELECT RAISE(ABORT,'work_publication_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_publication_event_no_delete BEFORE DELETE ON wb_work_publication_events BEGIN SELECT RAISE(ABORT,'work_publication_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_publication_event_sequence BEFORE INSERT ON wb_work_publication_events
  WHEN NEW.version<>COALESCE((SELECT MAX(version)+1 FROM wb_work_publication_events WHERE intent_id=NEW.intent_id),1)
   OR NEW.version=1 AND (NEW.state<>'prepared' OR NEW.request_id IS NOT NULL OR NEW.request_sha256 IS NOT NULL)
   OR NEW.version>1 AND (NEW.request_id IS NULL OR NEW.request_sha256 IS NULL OR NEW.state='prepared'
    OR EXISTS(SELECT 1 FROM wb_work_publication_events WHERE intent_id=NEW.intent_id AND request_id=NEW.request_id)
    OR (SELECT state FROM wb_work_publication_events WHERE intent_id=NEW.intent_id ORDER BY version DESC LIMIT 1)='cancelled'
    OR NEW.state='approved' AND (SELECT state FROM wb_work_publication_events WHERE intent_id=NEW.intent_id ORDER BY version DESC LIMIT 1)<>'prepared')
  BEGIN SELECT RAISE(ABORT,'work_publication_transition_invalid'); END;`);
 if(db.isTransaction)install();else withImmediateTransaction(db,install);
}

/** A separate owner review of original completed source versus a configured
 * physical target. It creates no run, native Goal, lease, write or dispatch. */
export class WorkPublicationIntents{
 private readonly db:DatabaseSync;private readonly git:GitWorkbench;private readonly projects:ProjectRepository;
 private readonly sources:FinalizedWorkSources;private readonly originalDb:ReturnType<typeof retainOriginalGitDatabase>;
 constructor(db:DatabaseSync,git:GitWorkbench){this.db=db;this.git=git;this.projects=new ProjectRepository(db);this.sources=new FinalizedWorkSources(db);this.originalDb=retainOriginalGitDatabase(db);}
 private read<T>(fn:()=>T):T{const outer=this.db.isTransaction;if(!outer)this.db.exec('BEGIN DEFERRED');try{this.originalDb.assertCurrent();return fn();}finally{if(!outer&&this.db.isTransaction)this.db.exec('ROLLBACK');}}
 private latest(id:string){const event=this.db.prepare('SELECT * FROM wb_work_publication_events WHERE intent_id=? ORDER BY version DESC LIMIT 1').get(id) as Row|undefined;if(!event)fail('corrupt');return event;}
 private row(owner:string,project:string,id:string){
  this.originalDb.assertCurrent();this.projects.assertOwned(project,owner);
  const row=this.db.prepare('SELECT * FROM wb_work_publication_intents WHERE intent_id=? AND owner_id=? AND project_id=?').get(id,owner,project) as Row|undefined;if(!row)fail('not_found');
  if(row.database_sha256!==this.originalDb.sha256)fail('database_changed');
  const selection=json(row.selection_json),source=json(row.source_json),target=json(row.target_json),changes=json(row.changes_json),{target_sha256,...witness}=target;
  if(hash(selection)!==row.request_sha256||selection.request_id!==row.request_id||selection.source_run_id!==row.source_run_id
   ||selection.source_sha256!==source.source_sha256||source.owner_id!==owner||source.project_id!==project||source.run_id!==row.source_run_id
   ||target.kind!=='publication_target'||target.execution_authorized!==false||hash(witness)!==target_sha256
   ||hash({owner,project,selection,source,target,changes,target_binding_sha256:row.target_binding_sha256,database_sha256:row.database_sha256})!==row.review_sha256)fail('corrupt');
  return row;
 }
 private view(row:Row,event:Row){return freezeWorkAdmission({intent_id:row.intent_id,project_id:row.project_id,source:json(row.source_json),target:json(row.target_json),changes:json(row.changes_json),paths:json(row.selection_json).paths,
  review_sha256:row.review_sha256,version:Number(event.version),state:event.state,created_at:row.created_at,updated_at:event.created_at,execution_authorized:false as const});}
 get(owner:string,project:string,id:string){return this.read(()=>{const row=this.row(owner,project,id);return this.view(row,this.latest(id));});}
 /** Original owned history only; a cursor selects an original row in this same
  * source, never another scope or a mutable filesystem location. */
 history(owner:string,project:string,runId:string,before?:string){return this.read(()=>{
  this.projects.assertOwned(project,owner);if(typeof runId!=='string'||!ID.test(runId)||before!==undefined&&(typeof before!=='string'||!ID.test(before)))fail('invalid');
  const cursor=before?this.row(owner,project,before):undefined;if(cursor&&cursor.source_run_id!==runId)fail('not_found');
  const rows=this.db.prepare(`SELECT intent_id FROM wb_work_publication_intents WHERE owner_id=? AND project_id=? AND source_run_id=?
   AND (? IS NULL OR created_at<? OR created_at=? AND intent_id<?) ORDER BY created_at DESC,intent_id DESC LIMIT 26`)
   .all(owner,project,runId,cursor?.created_at??null,cursor?.created_at??null,cursor?.created_at??null,before??null) as Row[];
  const items=rows.slice(0,25).map(item=>{const row=this.row(owner,project,item.intent_id),event=this.latest(row.intent_id),source=json(row.source_json);
   return{intent_id:row.intent_id,project_id:project,source_run_id:runId,source_sha256:source.source_sha256,paths:json(row.selection_json).paths,
    review_sha256:row.review_sha256,version:Number(event.version),state:event.state,created_at:row.created_at,updated_at:event.created_at,execution_authorized:false as const};});
  return freezeWorkAdmission({project_id:project,source_run_id:runId,items,next_cursor:rows.length>25?items.at(-1)!.intent_id as string:null});
 });}
 /** Original service-only prerequisite, not a serializable execution grant. */
 executionSource(owner:string,project:string,id:string,version:number,reviewSha256:string){
  return this.read(()=>{
   if(!Number.isSafeInteger(version)||version<1||!SHA.test(reviewSha256))fail('invalid');
   const row=this.row(owner,project,id),event=this.latest(id);if(event.state!=='approved'||event.version!==version||row.review_sha256!==reviewSha256)fail('review_changed');
   const input=json(row.selection_json) as WorkPublicationPrepare,source=this.selected(owner,project,input);
   if(canonicalJson(source.summary)!==row.source_json||this.git.executionBinding(owner,project)!==row.target_binding_sha256)fail('review_changed');
   return freezeWorkAdmission({intent_id:id,review_version:version,review_sha256:reviewSha256,source:source.summary,target:json(row.target_json),changes:json(row.changes_json),paths:input.paths,
    binding_sha256:row.target_binding_sha256,database_sha256:row.database_sha256,execution_authorized:false as const});
  });
 }
 private input(value:unknown):WorkPublicationPrepare{
  if(!exact(value,['request_id','source_run_id','source_sha256','paths'])||typeof value.request_id!=='string'||!ID.test(value.request_id)||typeof value.source_run_id!=='string'||!ID.test(value.source_run_id)
   ||typeof value.source_sha256!=='string'||!SHA.test(value.source_sha256)||!Array.isArray(value.paths)||!value.paths.length||value.paths.length>100)fail('invalid');
  const paths=value.paths.map(workspaceRelativePath).sort(),folded=paths.map(path=>path.normalize('NFC').toLowerCase());
  if(new Set(folded).size!==paths.length||folded.some(path=>folded.some(other=>path!==other&&path.startsWith(other+'/'))))fail('invalid');
  return{request_id:value.request_id,source_run_id:value.source_run_id,source_sha256:value.source_sha256,paths};
 }
 private selected(owner:string,project:string,input:WorkPublicationPrepare){
  this.projects.assertOwned(project,owner);const result=this.sources.readSelection(owner,input.source_run_id,input.paths,input.source_sha256),source=result.summary;
  if(source.project_id!==project||source.owner_id!==owner)fail('source_scope');
  // Keep the original inventory unchanged. A directory has no independent
  // file-version receipt, but creating an original selected new file necessarily
  // creates its missing ancestors. Permit only those exact structural additions;
  // unrelated directories and every other unsupported change still refuse.
  for(const unsupported of source.unsupported_changes){
   const change=source.work_review.diff.changes.find(entry=>entry.path===unsupported.path&&entry.kind===unsupported.kind);
   if(change?.kind!=='add'||change.after.kind!=='directory'
    ||!input.paths.some(path=>path.startsWith(change.path+'/')&&source.work_review.diff.changes.some(entry=>entry.path===path&&entry.kind==='add'&&entry.after.kind==='file')))
    fail('source_unsupported');
  }
  for(const path of input.paths){const change=source.work_review.diff.changes.find(entry=>entry.path===path);if(!change||!['add','modify'].includes(change.kind))fail('selection_invalid');}
  return result;
 }
 private changes(source:Source,selected:Map<string,Buffer>,target:GitPublicationTargetRead){
  return [...selected].map(([path,bytes])=>{
   const base=source.work_review.base_manifest.entries.find(entry=>entry.path===path),after=source.work_review.result_manifest.entries.find(entry=>entry.path===path),before=target.witness.files.find(entry=>entry.path===path);
   if(!before||after?.kind!=='file'||bytesHash(bytes)!==after.sha256||bytes.length!==after.bytes||base&&base.kind!=='file')fail('source_unsupported');
   const original=target.contents.get(path);
   if(base?.kind==='file'){
    if(before.kind!=='file'||before.sha256!==base.sha256||before.size!==base.bytes||Boolean(before.mode&0o111)!==base.executable||!original||bytesHash(original)!==before.sha256||original.length!==before.size)fail('target_base_changed');
   }else if(before.kind!=='missing'||original!==undefined)fail('target_base_changed');
   let beforeText:string|null=null,afterText:string;try{const decoder=new TextDecoder('utf8',{fatal:true});afterText=decoder.decode(bytes);if(original)beforeText=decoder.decode(original);if(bytes.includes(0)||original?.includes(0))fail('source_unsupported');}catch{fail('source_unsupported');}
   return{path,kind:base?'modify' as const:'add' as const,before:base??null,after,before_text:beforeText,after_text:afterText};
  });
 }
 async prepare(owner:string,project:string,input:WorkPublicationPrepare,signal?:AbortSignal){return (await this.prepareChange(owner,project,input,signal))();}
 async prepareChange(owner:string,project:string,value:WorkPublicationPrepare,signal?:AbortSignal){
  if(this.db.isTransaction)fail('async_transaction');this.originalDb.assertCurrent();this.projects.assertOwned(project,owner);signal?.throwIfAborted();
  const input=this.input(value),requestHash=hash(input),prior=this.db.prepare('SELECT intent_id,request_sha256 FROM wb_work_publication_intents WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
  if(prior){if(prior.request_sha256!==requestHash)throw Error('idempotency_conflict');return()=>this.read(()=>{signal?.throwIfAborted();const row=this.row(owner,project,prior.intent_id);return this.view(row,this.db.prepare('SELECT * FROM wb_work_publication_events WHERE intent_id=? AND version=1').get(row.intent_id) as Row);});}
  const source=this.selected(owner,project,input),binding=this.git.executionBinding(owner,project),target=await this.git.publicationTarget(owner,project,input.paths,signal);
  signal?.throwIfAborted();this.originalDb.assertCurrent();const fresh=this.selected(owner,project,input);if(canonicalJson(fresh.summary)!==canonicalJson(source.summary)||this.git.executionBinding(owner,project)!==binding)fail('review_changed');
  const changes=this.changes(fresh.summary,fresh.files,target),sourceJson=canonicalJson(fresh.summary),targetJson=canonicalJson(target.witness),changesJson=canonicalJson(changes);
  const reviewHash=hash({owner,project,selection:input,source:fresh.summary,target:target.witness,changes,target_binding_sha256:binding,database_sha256:this.originalDb.sha256});
  return()=>withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();this.originalDb.assertCurrent();this.projects.assertOwned(project,owner);
   if(canonicalJson(this.selected(owner,project,input).summary)!==sourceJson||this.git.executionBinding(owner,project)!==binding)fail('review_changed');
   const prior=this.db.prepare('SELECT intent_id,request_sha256 FROM wb_work_publication_intents WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
   if(prior){if(prior.request_sha256!==requestHash)throw Error('idempotency_conflict');const row=this.row(owner,project,prior.intent_id);return this.view(row,this.db.prepare('SELECT * FROM wb_work_publication_events WHERE intent_id=? AND version=1').get(row.intent_id) as Row);}
   const id='work-publication-'+randomUUID(),at=new Date().toISOString();
   this.db.prepare('INSERT INTO wb_work_publication_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,owner,project,input.source_run_id,input.request_id,requestHash,canonicalJson(input),sourceJson,targetJson,changesJson,binding,this.originalDb.sha256,reviewHash,at);
   this.db.prepare('INSERT INTO wb_work_publication_events VALUES(?,?,?,?,?,?)').run(id,1,'prepared',null,null,at);return this.get(owner,project,id);
  });
 }
 async control(owner:string,project:string,id:string,input:WorkPublicationControl,signal?:AbortSignal){return(await this.prepareControl(owner,project,id,input,signal))();}
 async prepareControl(owner:string,project:string,id:string,value:WorkPublicationControl,signal?:AbortSignal){
  const input=structuredClone(value);
  if(this.db.isTransaction)fail('async_transaction');
  if(!exact(input,['request_id','expected_version','action','review_sha256'])||typeof input.request_id!=='string'||!ID.test(input.request_id)||!Number.isSafeInteger(input.expected_version)||input.expected_version<1||!['approve','cancel'].includes(input.action)||typeof input.review_sha256!=='string'||!SHA.test(input.review_sha256))fail('invalid');
  signal?.throwIfAborted();const row=this.row(owner,project,id),requestHash=hash(input);
  const replay=()=>{const event=this.db.prepare('SELECT * FROM wb_work_publication_events WHERE intent_id=? AND request_id=?').get(id,input.request_id) as Row|undefined;if(event&&event.request_sha256!==requestHash)throw Error('idempotency_conflict');return event;};
  if(replay())return()=>this.read(()=>{signal?.throwIfAborted();const current=this.row(owner,project,id);return this.view(current,replay()!);});
  const current=()=>{this.row(owner,project,id);const event=this.latest(id);if(event.version!==input.expected_version)throw Error('version_conflict');if(row.review_sha256!==input.review_sha256)fail('review_changed');if(event.state==='cancelled'||input.action==='approve'&&event.state!=='prepared')fail('closed');return event;};
  current();const selection=json(row.selection_json) as WorkPublicationPrepare;
  if(input.action==='approve'){
   const source=this.selected(owner,project,selection),target=await this.git.publicationTarget(owner,project,selection.paths,signal);this.originalDb.assertCurrent();signal?.throwIfAborted();
   if(canonicalJson(source.summary)!==row.source_json||canonicalJson(target.witness)!==row.target_json||this.git.executionBinding(owner,project)!==row.target_binding_sha256)fail('review_changed');
  }
  return()=>withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();this.row(owner,project,id);const cached=replay();if(cached)return this.view(row,cached);const event=current();
   if(input.action==='approve'&&(canonicalJson(this.selected(owner,project,selection).summary)!==row.source_json||this.git.executionBinding(owner,project)!==row.target_binding_sha256))fail('review_changed');
   const next=event.version+1,at=new Date().toISOString();this.db.prepare('INSERT INTO wb_work_publication_events VALUES(?,?,?,?,?,?)').run(id,next,input.action==='approve'?'approved':'cancelled',input.request_id,requestHash,at);return this.get(owner,project,id);
  });
 }
}
