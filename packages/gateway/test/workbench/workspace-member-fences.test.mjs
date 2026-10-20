// Trusted reservation fixture. Original Git admission is separately exercised
// by test/git/workspace-reservation.test.mjs; no public grant is minted here.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {openProductDatabase,withImmediateTransaction} from '../../src/db/database.ts';
import {ProjectRepository} from '../../src/projects/repository.ts';import {ConversationRepository} from '../../src/conversations/repository.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';import {ensureModeSession} from '../../src/conversations/mode-sessions.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {reserveWorkspaceOperation,readReservedWorkspaceFamily} from '../../src/workbench/workspace-coordination.ts';
import {EventStore} from '../../src/events/event-store.ts';import {RunRepository} from '../../src/runs/repository.ts';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jot-workspace-members-')),db=openProductDatabase(join(root,'state.sqlite'));
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'shared')});
 const projects=new ProjectRepository(db),project=projects.create('owner',{title:'Synthetic'}).project_id,conversations=new ConversationRepository(db,projects),bindings=new SessionBindingRepository(db);
 const create=(owner='owner',target=project)=>{const value=conversations.create(owner,{workspace_id:'ws',project_id:target,model:{},mode:'work'});return {...value,id:value.conversation_id};};
 const original=create(),bound=bindings.getOrCreate('owner',original.id);
 const source={owner_id:'owner',project_id:project,operation_kind:'git_index',operation_id:'original-fixture-operation',binding_sha256:'a'.repeat(64)};
 return {db,root,project,projects,conversations,bindings,original,bound,source,create,reserve:()=>withImmediateTransaction(db,()=>reserveWorkspaceOperation(db,source)),
  run:(id='run')=>db.prepare("INSERT INTO ga_runs(id,conversation_id,status,version,created_at,updated_at) VALUES(?,?,'completed',1,'now','now')").run(id,original.id)};
}
test('original unchanged work binding remains readable but new work/Chat admission is fenced',t=>{
 const f=fixture(t),later=f.create();f.reserve();
 assert.deepEqual(f.bindings.getOrCreate('owner',f.original.id),f.bound);
 assert.throws(()=>f.bindings.getOrCreate('owner',later.id),/workspace_coordination_required/);
 assert.throws(()=>ensureModeSession(f.db,'owner',f.original.id,'chat'),/workspace_coordination_required/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_harness_session_bindings WHERE conversation_id=?').get(later.id).n,0);
});

test('an active original run from the former owner blocks a new project reservation',t=>{
 const f=fixture(t);f.run('old-owner-active');f.db.prepare("UPDATE ga_runs SET status='running' WHERE id='old-owner-active'").run();
 f.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('replacement',f.project);
 assert.throws(()=>withImmediateTransaction(f.db,()=>reserveWorkspaceOperation(f.db,{...f.source,owner_id:'replacement'})),/workspace_project_busy/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservations').get().n,0);
});
test('direct binding remap and deletion cannot remove a held native family member',t=>{
 const f=fixture(t);f.reserve();
 assert.throws(()=>f.db.prepare('UPDATE ga_harness_session_bindings SET session_id=? WHERE conversation_id=?').run('new-session',f.original.id),/workspace_coordination_required/);
 assert.throws(()=>f.db.prepare('DELETE FROM ga_harness_session_bindings WHERE conversation_id=?').run(f.original.id),/workspace_coordination_required/);
 assert.equal(f.db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=?').get(f.original.id).session_id,f.bound.session_id);
});
test('unique Session replacement cannot move a held binding into another project',t=>{
 const f=fixture(t),other=f.projects.create('owner',{title:'Other'}).project_id,later=f.create('owner',other);f.reserve();
 assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(later.id,'owner',f.bound.session_id,'now','now'),/workspace_coordination_required/);
 assert.equal(f.db.prepare('SELECT conversation_id FROM ga_harness_session_bindings WHERE session_id=?').get(f.bound.session_id).conversation_id,f.original.id);
});
test('an existing Chat mapping cannot be replaced or deleted during reservation',t=>{
 const f=fixture(t),chat=ensureModeSession(f.db,'owner',f.original.id,'chat');f.reserve();
 assert.throws(()=>f.db.prepare("UPDATE ga_conversation_mode_sessions SET session_id=? WHERE conversation_id=? AND mode='chat'").run('changed-chat',f.original.id),/workspace_coordination_required/);
 assert.throws(()=>f.db.prepare("DELETE FROM ga_conversation_mode_sessions WHERE conversation_id=? AND mode='chat'").run(f.original.id),/workspace_coordination_required/);
 assert.equal(ensureModeSession(f.db,'owner',f.original.id,'chat'),chat);
});
test('new runtime and persisted native references cannot bypass a completed logical run',t=>{
 const f=fixture(t);f.run();f.reserve();
 assert.throws(()=>f.db.prepare('INSERT INTO ga_runtime_bindings(run_id,harness_session_ref,created_at,updated_at) VALUES(?,?,?,?)').run('run','runtime-session','now','now'),/workspace_coordination_required/);
 assert.throws(()=>f.db.prepare('UPDATE ga_runs SET native_session_ref=?,native_owner_id=?,native_conversation_id=? WHERE id=?').run('native-session','owner',f.original.id,'run'),/workspace_coordination_required/);
});
test('a native child reservation cannot admit another member behind the family snapshot',t=>{
 const f=fixture(t);f.run();f.reserve();
 assert.throws(()=>f.db.prepare('INSERT INTO wb_native_child_reservations VALUES(?,?,?,?,?,?,?,?,?,?)').run('child-reservation','owner','run','task','occurrence','child-session','child-request','b'.repeat(64),'{}','now'),/workspace_coordination_required/);
});
test('conversation relocation cannot change physical workspace family while held',t=>{
 const f=fixture(t),other=f.projects.create('owner',{title:'Other'}).project_id;f.reserve();
 assert.throws(()=>f.db.prepare('UPDATE ga_conversations SET project_id=? WHERE id=?').run(other,f.original.id),/workspace_coordination_required/);
 assert.throws(()=>f.db.prepare('UPDATE ga_conversations SET workspace_id=? WHERE id=?').run('other-ws',f.original.id),/workspace_coordination_required/);
});
test('unrelated owned projects and other owners retain native admission',t=>{
 const f=fixture(t),other=f.projects.create('owner',{title:'Other'}).project_id,foreign=f.projects.create('other-owner',{title:'Foreign'}).project_id;
 const otherConversation=f.create('owner',other),foreignConversation=f.create('other-owner',foreign);f.reserve();
 assert.equal(f.bindings.getOrCreate('owner',otherConversation.id).owner_id,'owner');
 assert.equal(f.bindings.getOrCreate('other-owner',foreignConversation.id).owner_id,'other-owner');
});

test('new human input can queue behind a frozen family without creating a native member',t=>{
 const f=fixture(t);f.run('historical');f.db.prepare('UPDATE ga_runs SET native_session_ref=?,native_owner_id=?,native_conversation_id=? WHERE id=?').run(f.bound.session_id,'owner',f.original.id,'historical');f.reserve();
 const runs=new RunRepository(f.db,new EventStore(f.db)),receipt=runs.enqueue(f.original.id,'owner',{client_message_id:'queued-human',content:[{type:'text',text:'Synthetic follow-up while maintenance is held.'}]});
 assert.equal(runs.get(receipt.run_id,'owner').status,'queued');
 assert.equal(f.db.prepare('SELECT native_session_ref FROM ga_runs WHERE id=?').get(receipt.run_id).native_session_ref,f.bound.session_id);
});

test('database reopening and exact Work alias backfill do not require new Session admission',t=>{
 const f=fixture(t);f.reserve();const second=openProductDatabase(join(f.root,'state.sqlite'));
 try{assert.equal(new SessionBindingRepository(second).getOrCreate('owner',f.original.id).session_id,f.bound.session_id);
  assert.equal(second.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);
 }finally{second.close();}
});
test('already mapped Chat input can queue without admitting a different Session',t=>{
 const f=fixture(t),chat=ensureModeSession(f.db,'owner',f.original.id,'chat');f.reserve();
 f.db.prepare("INSERT INTO ga_runs(id,conversation_id,status,version,created_at,updated_at,native_session_ref,native_owner_id,native_conversation_id) VALUES(?,?,'queued',1,'now','now',?,?,?)")
  .run('queued-chat',f.original.id,chat,'owner',f.original.id);
 assert.equal(f.db.prepare('SELECT native_session_ref FROM ga_runs WHERE id=?').get('queued-chat').native_session_ref,chat);
});
test('runtime metadata can advance but its Session cannot be stolen through a unique conflict',t=>{
 const f=fixture(t),other=f.projects.create('owner',{title:'Other'}).project_id,later=f.create('owner',other);f.run('original-run');
 f.db.prepare("INSERT INTO ga_runs(id,conversation_id,status,version,created_at,updated_at) VALUES(?,?,'completed',1,'now','now')").run('other-run',later.id);
 f.db.prepare('INSERT INTO ga_runtime_bindings(run_id,harness_session_ref,created_at,updated_at) VALUES(?,?,?,?)').run('original-run','runtime-session','now','now');f.reserve();
 f.db.prepare('UPDATE ga_runtime_bindings SET last_runtime_revision=1 WHERE run_id=?').run('original-run');
 assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO ga_runtime_bindings(run_id,harness_session_ref,created_at,updated_at) VALUES(?,?,?,?)').run('other-run','runtime-session','now','now'),/workspace_coordination_required/);
 assert.equal(f.db.prepare('SELECT last_runtime_revision FROM ga_runtime_bindings WHERE run_id=?').get('original-run').last_runtime_revision,1);
});
test('member admission fence and original reservation roll back in the same database transaction',t=>{
 const f=fixture(t),later=f.create();
 assert.throws(()=>withImmediateTransaction(f.db,()=>{f.reserve();assert.throws(()=>f.bindings.getOrCreate('owner',later.id),/workspace_coordination_required/);throw Error('rollback');}),/rollback/);
 assert.equal(f.bindings.getOrCreate('owner',later.id).owner_id,'owner');
});

test('reserved family includes Work, Chat, historical runtime and native child references',t=>{
 const f=fixture(t),chat=ensureModeSession(f.db,'owner',f.original.id,'chat');f.run('historical');
 f.db.prepare('INSERT INTO ga_runtime_bindings(run_id,harness_session_ref,created_at,updated_at) VALUES(?,?,?,?)').run('historical','older-runtime','now','now');
 f.db.prepare('UPDATE ga_runs SET native_session_ref=?,native_owner_id=?,native_conversation_id=? WHERE id=?').run('older-native','owner',f.original.id,'historical');
 f.db.prepare('INSERT INTO ga_session_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?)').run('checkpoint','historical',f.original.id,'older-checkpoint',2,1,'goal',1,'c'.repeat(64),'now');
 const snapshot={owner_id:'owner',project_id:f.project,workspace_id:'ws',root_run_id:'historical',parent_session_ref:f.bound.session_id,child_session_ref:'reserved-child'};
 f.db.prepare('INSERT INTO wb_native_child_reservations VALUES(?,?,?,?,?,?,?,?,?,?)').run('child-reservation','owner','historical','task','occurrence','reserved-child','request','b'.repeat(64),JSON.stringify(snapshot),'now');
 f.reserve();const family=withImmediateTransaction(f.db,()=>readReservedWorkspaceFamily(f.db,f.source));
 assert.deepEqual(family.members.map(member=>member.session_ref).sort(),[f.bound.session_id,chat,'older-runtime','older-native','older-checkpoint','reserved-child'].sort());
 assert.equal(family.execution_authorized,false);assert.match(family.family_sha256,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(family).includes('snapshot_json'),false);
});
test('new queued references to a known member do not change the family membership digest',t=>{
 const f=fixture(t);f.reserve();const read=()=>withImmediateTransaction(f.db,()=>readReservedWorkspaceFamily(f.db,f.source)),before=read();
 new RunRepository(f.db,new EventStore(f.db)).enqueue(f.original.id,'owner',{client_message_id:'queued',content:[{type:'text',text:'Synthetic follow-up'}]});
 assert.equal(read().family_sha256,before.family_sha256);
});
test('a family read requires the held original reservation and current project owner',t=>{
 const f=fixture(t);assert.throws(()=>withImmediateTransaction(f.db,()=>readReservedWorkspaceFamily(f.db,f.source)),/workspace_reservation_not_found/);
 f.reserve();f.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('replacement',f.project);
 assert.throws(()=>withImmediateTransaction(f.db,()=>readReservedWorkspaceFamily(f.db,f.source)),/project_not_found/);
});

test('a foreign native child cannot borrow an owned Work Session identity',t=>{
 const f=fixture(t),foreign=f.projects.create('other-owner',{title:'Foreign'}).project_id,other=f.create('other-owner',foreign);
 f.db.prepare("INSERT INTO ga_runs(id,conversation_id,status,version,created_at,updated_at) VALUES(?,?,'completed',1,'now','now')").run('foreign-root',other.id);
 const snapshot={owner_id:'other-owner',project_id:foreign,workspace_id:'ws',root_run_id:'foreign-root',parent_session_ref:'foreign-parent',child_session_ref:f.bound.session_id};
 f.db.prepare('INSERT INTO wb_native_child_reservations VALUES(?,?,?,?,?,?,?,?,?,?)').run('foreign-child','other-owner','foreign-root','task','occurrence',f.bound.session_id,'request','b'.repeat(64),JSON.stringify(snapshot),'now');
 f.reserve();assert.throws(()=>withImmediateTransaction(f.db,()=>readReservedWorkspaceFamily(f.db,f.source)),/workspace_family_ambiguous/);
});

test('a held native creation cannot replace its original request metadata under the same member identity',t=>{
 const f=fixture(t);f.run();
 f.db.prepare('INSERT INTO wb_native_child_reservations VALUES(?,?,?,?,?,?,?,?,?,?)').run('reserved-child','owner','run','task','occurrence','child-session','request','b'.repeat(64),'{}','now');f.reserve();
 assert.throws(()=>f.db.prepare(`INSERT OR REPLACE INTO wb_native_child_reservations
  SELECT reservation_id,owner_id,root_run_id,task_id,occurrence_id,child_session_ref,request_id,?,snapshot_json,created_at
  FROM wb_native_child_reservations WHERE reservation_id=?`).run('d'.repeat(64),'reserved-child'),/workspace_coordination_required/);
 assert.equal(f.db.prepare('SELECT input_hash FROM wb_native_child_reservations WHERE reservation_id=?').get('reserved-child').input_hash,'b'.repeat(64));
});
