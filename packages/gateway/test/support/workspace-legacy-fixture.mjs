// Test-only historical schema construction. Old databases never contained the
// new member triggers; SQLite rightly refuses DROP COLUMN while they refer to
// that column. No production migration disables its fences.
import assert from 'node:assert/strict';
import {ProjectRepository} from '../../src/projects/repository.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {reserveWorkspaceOperation} from '../../src/workbench/workspace-coordination.ts';

export function stripNewMemberFencesForLegacyFixture(db){
 assert.equal(db.prepare(`SELECT count(*) n FROM wb_workspace_reservations r
  LEFT JOIN wb_workspace_reservation_releases x ON x.reservation_id=r.reservation_id WHERE x.reservation_id IS NULL`).get().n,0);
 const triggers=db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'wb_workspace_member_*'").all();
 assert.ok(triggers.length>0);
 for(const {name} of triggers){assert.match(name,/^wb_workspace_member_[a-z_]+_(?:insert|update|delete)$/);db.exec('DROP TRIGGER "'+name+'"');}
}

export function assertReopenedMemberFences(db){
 const conversation=db.prepare('SELECT id,owner_id,project_id FROM ga_conversations ORDER BY id LIMIT 1').get();assert.ok(conversation);
 const saved=db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=?').get(conversation.id)
  ??new SessionBindingRepository(db).getOrCreate(conversation.owner_id,conversation.id);
 const project=conversation.project_id??new ProjectRepository(db).create(conversation.owner_id,{title:'Synthetic reopened fence'}).project_id;
 withImmediateTransaction(db,()=>reserveWorkspaceOperation(db,{owner_id:conversation.owner_id,project_id:project,operation_kind:'git_index',operation_id:'test-reopened-fence',binding_sha256:'a'.repeat(64)}));
 assert.throws(()=>db.prepare('UPDATE ga_harness_session_bindings SET session_id=? WHERE conversation_id=?').run('test-migration-replacement',conversation.id),/workspace_coordination_required/);
 assert.equal(db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=?').get(conversation.id).session_id,saved.session_id);
}
