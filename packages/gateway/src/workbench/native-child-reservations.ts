import {randomUUID,createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {assertExecutionLease} from './execution-lease.ts';
import type {TaskCollaborationService} from './task-collaboration.ts';
import {taskMemberCapacityAvailable} from './task-mailbox.ts';
import {assertNativeTaskAssignment,type NativeTaskIntents} from './native-task-intents.ts';
import {installNativeChildRuns} from './native-child-identity.ts';
type Input=Record<string,unknown>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
/** Durable native child admission intent. A reservation confers no model/tool
 * execution authority; child run allocation and native publication must bind it.
 */
export class NativeChildReservations {
 private readonly db:DatabaseSync;private readonly collaboration:TaskCollaborationService;
 private intents:NativeTaskIntents|undefined;
 constructor(db:DatabaseSync,collaboration:TaskCollaborationService,intents?:NativeTaskIntents){
  this.db=db;this.collaboration=collaboration;this.intents=intents;
  installNativeChildRuns(db);
  db.exec(`CREATE TABLE IF NOT EXISTS wb_native_spawn_publications(
    reservation_id TEXT PRIMARY KEY REFERENCES wb_native_child_reservations(reservation_id),publication_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS wb_native_spawn_publication_no_update BEFORE UPDATE ON wb_native_spawn_publications BEGIN SELECT RAISE(ABORT,'native_spawn_publication_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS wb_native_spawn_publication_no_delete BEFORE DELETE ON wb_native_spawn_publications BEGIN SELECT RAISE(ABORT,'native_spawn_publication_immutable'); END;`);
 }
 reserve(input:Input){
  const fields=['run_id','session_ref','child_session_ref','role_ref','request_id','expected_policy_version','execution_lease','spawn_request_hash'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key))
   ||fields.slice(0,5).some(key=>typeof input[key]!=='string'||!ID.test(input[key] as string))
   ||input.child_session_ref===input.session_ref||!Number.isSafeInteger(input.expected_policy_version)||Number(input.expected_policy_version)<1
   ||input.spawn_request_hash!==undefined&&(typeof input.spawn_request_hash!=='string'||!/^[a-f0-9]{64}$/.test(input.spawn_request_hash)))throw new Error('native_child_request_invalid');
  return withImmediateTransaction(this.db,()=>{
   const runId=String(input.run_id),lease=assertExecutionLease(this.db,runId,input.execution_lease);
   const parent=this.db.prepare(`SELECT b.owner_id FROM ga_harness_session_bindings b JOIN ga_runs r ON r.conversation_id=b.conversation_id
    WHERE r.id=? AND b.session_id=?`).get(runId,String(input.session_ref)) as {owner_id:string}|undefined;
   if(!parent)throw new Error('workbench_identity_forbidden');
   const authorization=this.collaboration.authorizeNativeMember(parent.owner_id,runId,String(input.role_ref),Number(input.expected_policy_version));
   const budget=this.db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(parent.owner_id,runId) as {scopes_json:string}|undefined;
   if(!budget)throw new Error('budget_service_unavailable');
   const digest=createHash('sha256').update(JSON.stringify([runId,input.session_ref,input.child_session_ref,input.role_ref,input.expected_policy_version,lease,...(input.spawn_request_hash===undefined?[]:[input.spawn_request_hash])])).digest('hex');
   const prior=this.db.prepare('SELECT input_hash,snapshot_json FROM wb_native_child_reservations WHERE root_run_id=? AND request_id=?').get(runId,String(input.request_id)) as {input_hash:string;snapshot_json:string}|undefined;
   if(prior){if(prior.input_hash!==digest)throw new Error('idempotency_conflict');const saved=JSON.parse(prior.snapshot_json);if(saved.task_assignment)assertNativeTaskAssignment(this.db,parent.owner_id,saved.task_assignment);return saved;}
   if(this.db.prepare('SELECT 1 FROM ga_harness_session_bindings WHERE session_id=? UNION ALL SELECT 1 FROM wb_native_child_reservations WHERE child_session_ref=?').get(String(input.child_session_ref),String(input.child_session_ref)))throw new Error('native_child_identity_conflict');
   const native=this.db.prepare('SELECT count(*) n FROM wb_native_child_reservations WHERE owner_id=? AND occurrence_id=?').get(parent.owner_id,authorization.occurrence_id) as {n:number};
   const delegated=this.db.prepare(`SELECT count(*) n FROM wb_task_delegation_authorizations a JOIN wb_task_delegations d ON d.delegation_id=a.delegation_id WHERE d.owner_id=? AND d.occurrence_id=?`).get(parent.owner_id,authorization.occurrence_id) as {n:number};
   // Until lifecycle settlement is connected every reservation stays active.
   // Do not recycle an uncertain slot or replay a native creation on restart.
   if(!taskMemberCapacityAvailable(this.db,parent.owner_id,authorization.occurrence_id,authorization.max_active)||native.n+delegated.n>=authorization.max_delegations)throw new Error('task_collaboration_exhausted');
   const planned=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_native_task_intents'").get()
     &&this.db.prepare('SELECT 1 FROM wb_native_task_intents WHERE owner_id=? AND root_run_id=? AND request_id=?').get(parent.owner_id,runId,String(input.request_id));
   if(planned&&!this.intents)throw new Error('native_assignment_service_unavailable');
   const assignment=this.intents?.bind(parent.owner_id,runId,String(input.request_id),String(input.role_ref),Number(input.expected_policy_version));
   const receipt={reservation_id:`native-${randomUUID()}`,...authorization,parent_session_ref:String(input.session_ref),child_session_ref:String(input.child_session_ref),
    execution_lease:lease,root_budget_scope_ids:JSON.parse(budget.scopes_json),state:'reserved',execution_authorized:false,...(assignment?{task_assignment:assignment}:{}),...(input.spawn_request_hash===undefined?{}:{spawn_request_hash:input.spawn_request_hash})};
   this.db.prepare('INSERT INTO wb_native_child_reservations VALUES(?,?,?,?,?,?,?,?,?,?)').run(receipt.reservation_id,parent.owner_id,runId,authorization.task_id,authorization.occurrence_id,String(input.child_session_ref),String(input.request_id),digest,JSON.stringify(receipt),new Date().toISOString());
   return receipt;
  });
 }
 /** Metadata lookup only. Never recreates a child or grants execution. */
 lookup(input:Input){
  const fields=['run_id','session_ref','request_id','spawn_request_hash','execution_lease'];
  if(!input||Object.keys(input).some(key=>!fields.includes(key))||fields.slice(0,3).some(key=>typeof input[key]!=='string'||!ID.test(input[key] as string))
    ||typeof input.spawn_request_hash!=='string'||!/^[a-f0-9]{64}$/.test(input.spawn_request_hash))throw new Error('native_child_request_invalid');
  return withImmediateTransaction(this.db,()=>{
   const runId=String(input.run_id);assertExecutionLease(this.db,runId,input.execution_lease);
   const parent=this.db.prepare(`SELECT b.owner_id FROM ga_harness_session_bindings b JOIN ga_runs r ON r.conversation_id=b.conversation_id WHERE r.id=? AND b.session_id=?`).get(runId,String(input.session_ref)) as {owner_id:string}|undefined;
   if(!parent)throw new Error('workbench_identity_forbidden');
   const row=this.db.prepare('SELECT snapshot_json FROM wb_native_child_reservations WHERE owner_id=? AND root_run_id=? AND request_id=?').get(parent.owner_id,runId,String(input.request_id)) as {snapshot_json:string}|undefined;
   if(!row)return null;const saved=JSON.parse(row.snapshot_json);
   if(saved.spawn_request_hash!==input.spawn_request_hash)throw new Error('idempotency_conflict');
   this.collaboration.authorizeNativeMember(parent.owner_id,runId,saved.role_id,saved.policy_version);
   const stored=this.db.prepare('SELECT publication_json FROM wb_native_spawn_publications WHERE reservation_id=?').get(saved.reservation_id) as {publication_json:string}|undefined;
   return {reservation_id:saved.reservation_id,child_session_ref:saved.child_session_ref,role_ref:saved.role_id,execution_authorized:false,...(stored?{publication:JSON.parse(stored.publication_json)}:{})};
  });
 }
 publish(input:Input){
  const {publication,...identity}=input;
  if(!publication||typeof publication!=='object'||Array.isArray(publication)||Object.keys(publication).length!==1)throw new Error('native_spawn_publication_invalid');
  const member=(publication as Input).member as Input|undefined,keys=['id','name','role','status','description','provider','context','model','diagnostics'];
  if(!member||typeof member!=='object'||Array.isArray(member)||Object.keys(member).some(key=>!keys.includes(key))||typeof member.id!=='string'||!ID.test(member.id)
   ||typeof member.name!=='string'||!member.name||member.name.length>80||member.role!=='teammate'||!['running','inactive'].includes(String(member.status))
   ||!Array.isArray(member.diagnostics)||member.diagnostics.length>20||member.diagnostics.some(value=>typeof value!=='string'||value.length>500)
   ||['description','provider','model'].some(key=>member[key]!==undefined&&(typeof member[key]!=='string'||String(member[key]).length>2000))
   ||member.context!==undefined&&member.context!=='fresh')throw new Error('native_spawn_publication_invalid');
  const encoded=canonical(publication);if(Buffer.byteLength(encoded,'utf8')>8192)throw new Error('native_spawn_publication_invalid');
  return withImmediateTransaction(this.db,()=>{
   const saved=this.lookup(identity);if(!saved||member.id!==saved.child_session_ref)throw new Error('workbench_identity_forbidden');
   if(!this.db.prepare(`SELECT 1 FROM wb_native_child_runs n JOIN wb_run_bindings b ON b.run_id=n.run_id AND b.kind='native_team'
     WHERE n.reservation_id=? AND n.child_session_ref=?`).get(saved.reservation_id,saved.child_session_ref))throw new Error('native_spawn_publication_unbound');
   const prior=this.db.prepare('SELECT publication_json FROM wb_native_spawn_publications WHERE reservation_id=?').get(saved.reservation_id) as {publication_json:string}|undefined;
   if(prior){if(prior.publication_json!==encoded)throw new Error('idempotency_conflict');return JSON.parse(prior.publication_json);}
   this.db.prepare('INSERT INTO wb_native_spawn_publications VALUES(?,?,?)').run(saved.reservation_id,encoded,new Date().toISOString());return JSON.parse(encoded);
  });
 }
}
