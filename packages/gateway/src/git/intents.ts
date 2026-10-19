import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {ProjectRepository} from '../projects/repository.ts';
import type {GitWorkbench} from './service.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';

type Operation='stage'|'unstage'|'commit'|'discard'|'delete-untracked';
export type GitReviewPrepare={request_id:string;action:Operation;paths:string[];snapshot_id:string;message?:string};
export type GitReviewControl={request_id:string;expected_version:number;action:'approve'|'cancel';review_sha256:string};
type Prepare=GitReviewPrepare;type Control=GitReviewControl;
type State='prepared'|'approved'|'cancelled';
type Row={intent_id:string;owner_id:string;project_id:string;request_id:string;request_sha256:string;action:Operation;selection_json:string;witness_json:string;review_sha256:string;created_at:string};
type Event={version:number;state:State;request_id:string|null;request_sha256:string|null;created_at:string};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Original owner review journal, not a planner, executor or execution grant.
 * Synchronous commit closures join the original HTTP receipt transaction. */
export class GitMutationIntents{
 private readonly db:DatabaseSync;private readonly projects:ProjectRepository;private readonly git:GitWorkbench;
 constructor(db:DatabaseSync,projects:ProjectRepository,git:GitWorkbench){
  this.db=db;this.projects=projects;this.git=git;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_git_mutation_intents(
   intent_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,
   request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,action TEXT NOT NULL,
   selection_json TEXT NOT NULL,witness_json TEXT NOT NULL,review_sha256 TEXT NOT NULL,
   created_at TEXT NOT NULL,UNIQUE(owner_id,project_id,request_id));
   CREATE TABLE IF NOT EXISTS wb_git_mutation_events(
    intent_id TEXT NOT NULL REFERENCES wb_git_mutation_intents(intent_id),version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','approved','cancelled')),request_id TEXT,request_sha256 TEXT,
    created_at TEXT NOT NULL,PRIMARY KEY(intent_id,version),UNIQUE(intent_id,request_id));
   CREATE TRIGGER IF NOT EXISTS wb_git_intent_no_update BEFORE UPDATE ON wb_git_mutation_intents BEGIN SELECT RAISE(ABORT,'git_intent_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_git_intent_no_delete BEFORE DELETE ON wb_git_mutation_intents BEGIN SELECT RAISE(ABORT,'git_intent_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_git_event_no_update BEFORE UPDATE ON wb_git_mutation_events BEGIN SELECT RAISE(ABORT,'git_intent_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_git_event_no_delete BEFORE DELETE ON wb_git_mutation_events BEGIN SELECT RAISE(ABORT,'git_intent_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_git_event_sequence BEFORE INSERT ON wb_git_mutation_events
    WHEN NEW.version<>COALESCE((SELECT MAX(version)+1 FROM wb_git_mutation_events WHERE intent_id=NEW.intent_id),1)
     OR NEW.version=1 AND (NEW.state<>'prepared' OR NEW.request_id IS NOT NULL OR NEW.request_sha256 IS NOT NULL)
     OR NEW.version>1 AND (NEW.request_id IS NULL OR NEW.request_sha256 IS NULL OR NEW.state='prepared'
      OR (SELECT state FROM wb_git_mutation_events WHERE intent_id=NEW.intent_id ORDER BY version DESC LIMIT 1)='cancelled'
      OR NEW.state='approved' AND (SELECT state FROM wb_git_mutation_events WHERE intent_id=NEW.intent_id ORDER BY version DESC LIMIT 1)<>'prepared')
    BEGIN SELECT RAISE(ABORT,'git_intent_transition_invalid'); END;`);
 }
 private row(owner:string,project:string,id:string){this.projects.assertOwned(project,owner);const row=this.db.prepare('SELECT * FROM wb_git_mutation_intents WHERE intent_id=? AND owner_id=? AND project_id=?').get(id,owner,project) as Row|undefined;if(!row)throw Error('git_intent_not_found');return row;}
 private latest(id:string){const event=this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? ORDER BY version DESC LIMIT 1').get(id) as Event|undefined;if(!event)throw Error('git_intent_unavailable');return event;}
 private view(row:Row,event:Event){const selection=JSON.parse(row.selection_json) as Prepare;return{intent_id:row.intent_id,project_id:row.project_id,action:row.action,paths:selection.paths,...(selection.message===undefined?{}:{message:selection.message}),snapshot_id:selection.snapshot_id,review_sha256:row.review_sha256,version:event.version,state:event.state,created_at:row.created_at,updated_at:event.created_at,execution_authorized:false as const};}
 get(owner:string,project:string,id:string){const row=this.row(owner,project,id);return this.view(row,this.latest(id));}
 private normalize(input:Prepare):Prepare{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['request_id','action','paths','snapshot_id','message'].includes(key))||typeof input.request_id!=='string'||!ID.test(input.request_id)||!['stage','unstage','commit','discard','delete-untracked'].includes(input.action)||typeof input.snapshot_id!=='string'||!SHA.test(input.snapshot_id)||!Array.isArray(input.paths)||!input.paths.length||input.paths.length>100||new Set(input.paths).size!==input.paths.length)throw Error('git_intent_invalid');
  const paths=input.paths.map(path=>{if(typeof path!=='string'||path.startsWith('-'))throw Error('git_intent_invalid');return workspaceRelativePath(path);}).sort();
  if(input.action==='commit'?(typeof input.message!=='string'||!input.message.trim()||input.message.length>4096||input.message.includes('\0')):input.message!==undefined)throw Error('git_intent_invalid');
  return{request_id:input.request_id,action:input.action,paths,snapshot_id:input.snapshot_id,...(input.message===undefined?{}:{message:input.message})};
 }
 async prepare(owner:string,project:string,value:Prepare,signal?:AbortSignal){return (await this.prepareChange(owner,project,value,signal))();}
 async prepareChange(owner:string,project:string,value:Prepare,signal?:AbortSignal){
  this.projects.assertOwned(project,owner);const input=this.normalize(value),requestHash=digest(input);
  const prior=this.db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
  if(prior){if(prior.request_sha256!==requestHash)throw Error('idempotency_conflict');return ()=>{signal?.throwIfAborted();const current=this.row(owner,project,prior.intent_id);return this.view(current,this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? AND version=1').get(prior.intent_id) as Event);};}
  const snapshot=await this.git.inspect(owner,project,signal);if(snapshot.snapshot_id!==input.snapshot_id)throw Error('git_snapshot_changed');
  const selected=snapshot.entries.filter(entry=>input.paths.includes(entry.path));
  if(selected.length!==input.paths.length||selected.some(entry=>entry.conflicted||!['file','missing'].includes(entry.kind)))throw Error('git_selection_invalid');
  const staged=(value:{index_status:string})=>![' ','?'].includes(value.index_status);
  if(input.action==='commit'&&(snapshot.omitted_count>0||selected.some(entry=>!staged(entry))||snapshot.entries.filter(staged).length!==selected.length)
   ||input.action==='stage'&&selected.some(entry=>entry.worktree_status===' ')
   ||input.action==='unstage'&&selected.some(entry=>!staged(entry))
   ||input.action==='discard'&&selected.some(entry=>entry.index_status==='?'||entry.worktree_status===' ')
   ||input.action==='delete-untracked'&&selected.some(entry=>entry.index_status!=='?'||entry.worktree_status!=='?'))throw Error('git_selection_invalid');
  const witness=await this.git.freeze(owner,project,input.snapshot_id,input.paths,signal);signal?.throwIfAborted();
  return ()=>withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();
   this.projects.assertOwned(project,owner);
   const existing=this.db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
   if(existing){if(existing.request_sha256!==requestHash)throw Error('idempotency_conflict');return this.view(existing,this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? AND version=1').get(existing.intent_id) as Event);}
   const id='git-intent-'+randomUUID(),at=new Date().toISOString(),reviewHash=digest({action:input.action,paths:input.paths,message:input.message??null,witness});
   this.db.prepare('INSERT INTO wb_git_mutation_intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,owner,project,input.request_id,requestHash,input.action,JSON.stringify(input),JSON.stringify(witness),reviewHash,at);
   this.db.prepare('INSERT INTO wb_git_mutation_events VALUES(?,?,?,?,?,?)').run(id,1,'prepared',null,null,at);
   return this.get(owner,project,id);
  });
 }
 async control(owner:string,project:string,id:string,input:Control,signal?:AbortSignal){return (await this.prepareControl(owner,project,id,input,signal))();}
 async prepareControl(owner:string,project:string,id:string,input:Control,signal?:AbortSignal){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['request_id','expected_version','action','review_sha256'].includes(key))||typeof input.request_id!=='string'||!ID.test(input.request_id)||!Number.isSafeInteger(input.expected_version)||input.expected_version<1||!['approve','cancel'].includes(input.action)||typeof input.review_sha256!=='string'||!SHA.test(input.review_sha256))throw Error('git_intent_invalid');
  const row=this.row(owner,project,id),requestHash=digest({request_id:input.request_id,expected_version:input.expected_version,action:input.action,review_sha256:input.review_sha256});
  const replay=()=>{const prior=this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? AND request_id=?').get(id,input.request_id) as Event|undefined;if(prior&&prior.request_sha256!==requestHash)throw Error('idempotency_conflict');return prior?this.view(row,prior):undefined;};
  const cached=replay();if(cached)return ()=>{signal?.throwIfAborted();this.row(owner,project,id);return cached;};
  const assertCurrent=()=>{this.row(owner,project,id);const event=this.latest(id);if(event.version!==input.expected_version)throw Error('version_conflict');if(row.review_sha256!==input.review_sha256)throw Error('git_review_changed');if(event.state==='cancelled'||input.action==='approve'&&event.state!=='prepared')throw Error('git_intent_closed');return event;};
  assertCurrent();if(input.action==='approve'){
   const selection=JSON.parse(row.selection_json) as Prepare,witness=await this.git.freeze(owner,project,selection.snapshot_id,selection.paths,signal);
   if(JSON.stringify(witness)!==row.witness_json)throw Error('git_review_changed');
  }
  signal?.throwIfAborted();return ()=>withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();
   this.row(owner,project,id);const cached=replay();if(cached)return cached;const event=assertCurrent();
   this.db.prepare('INSERT INTO wb_git_mutation_events VALUES(?,?,?,?,?,?)').run(id,event.version+1,input.action==='approve'?'approved':'cancelled',input.request_id,requestHash,new Date().toISOString());return this.get(owner,project,id);
  });
 }
}
