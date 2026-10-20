import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

type Source={owner_id:string;project_id:string;operation_kind:'git_index';operation_id:string;binding_sha256:string};
type Reservation=Source&{reservation_id:string;created_at:string};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export const WORKSPACE_RESERVATION_MATCH=`SELECT 1 FROM wb_workspace_reservations wr
 LEFT JOIN wb_workspace_reservation_releases wx ON wx.reservation_id=wr.reservation_id
 WHERE wr.owner_id=c.owner_id AND (wr.project_id=c.project_id OR c.project_id IS NULL) AND wx.reservation_id IS NULL`;

/** Original project coordination records, not a scheduler or filesystem grant.
 * Reservations never expire: lease expiry cannot prove a native producer ended.
 */
export function installWorkspaceCoordination(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_workspace_reservations(
  reservation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN('git_index')),operation_id TEXT NOT NULL,
  binding_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,record_sha256 TEXT NOT NULL,
  UNIQUE(operation_kind,operation_id));
  CREATE INDEX IF NOT EXISTS wb_workspace_reservations_project ON wb_workspace_reservations(owner_id,project_id);
  CREATE TABLE IF NOT EXISTS wb_workspace_reservation_releases(
  reservation_id TEXT PRIMARY KEY REFERENCES wb_workspace_reservations(reservation_id),released_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS wb_workspace_reservations_no_original_replace BEFORE INSERT ON wb_workspace_reservations
   WHEN EXISTS(SELECT 1 FROM wb_workspace_reservations WHERE operation_kind=NEW.operation_kind AND operation_id=NEW.operation_id)
   BEGIN SELECT RAISE(ABORT,'workspace_coordination_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_workspace_run_insert BEFORE INSERT ON ga_runs
   WHEN NEW.status IN('starting','running','waiting_user','waiting_approval','cancelling')
    AND EXISTS(SELECT 1 FROM ga_conversations c WHERE c.id=NEW.conversation_id AND EXISTS(${WORKSPACE_RESERVATION_MATCH}))
   BEGIN SELECT RAISE(ABORT,'workspace_coordination_required'); END;
  CREATE TRIGGER IF NOT EXISTS wb_workspace_run_update BEFORE UPDATE OF status,conversation_id ON ga_runs
   WHEN NEW.status IN('starting','running','waiting_user','waiting_approval','cancelling')
    AND EXISTS(SELECT 1 FROM ga_conversations c WHERE c.id=NEW.conversation_id AND EXISTS(${WORKSPACE_RESERVATION_MATCH}))
   BEGIN SELECT RAISE(ABORT,'workspace_coordination_required'); END;`);
 for(const table of ['wb_workspace_reservations','wb_workspace_reservation_releases'])db.exec(`
  CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'workspace_coordination_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'workspace_coordination_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
   WHEN EXISTS(SELECT 1 FROM ${table} WHERE reservation_id=NEW.reservation_id)
   BEGIN SELECT RAISE(ABORT,'workspace_coordination_immutable'); END;`);
}
function available(db:DatabaseSync){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_workspace_reservations'").get();}
export function assertWorkspaceWritable(db:DatabaseSync,owner:string,project:string){
 if(available(db)&&db.prepare(`SELECT 1 FROM wb_workspace_reservations wr
  LEFT JOIN wb_workspace_reservation_releases wx ON wx.reservation_id=wr.reservation_id
  WHERE wr.owner_id=? AND wr.project_id=? AND wx.reservation_id IS NULL`).get(owner,project))throw Error('workspace_coordination_required');
}
function record(db:DatabaseSync,source:Source):Reservation|undefined{
 const row=db.prepare('SELECT * FROM wb_workspace_reservations WHERE operation_kind=? AND operation_id=?').get(source.operation_kind,source.operation_id);
 if(!row)return;
 const value:Reservation={owner_id:String(row.owner_id),project_id:String(row.project_id),operation_kind:row.operation_kind as 'git_index',operation_id:String(row.operation_id),binding_sha256:String(row.binding_sha256),reservation_id:String(row.reservation_id),created_at:String(row.created_at)};
 if(digest(value)!==row.record_sha256||Object.keys(source).some(key=>source[key as keyof Source]!==value[key as keyof Source]))throw Error('workspace_reservation_source_changed');
 return value;
}
function view(db:DatabaseSync,value:Reservation){return{reservation_id:value.reservation_id,project_id:value.project_id,
 state:db.prepare('SELECT 1 FROM wb_workspace_reservation_releases WHERE reservation_id=?').get(value.reservation_id)?'released_unstarted' as const:'reserved' as const,execution_authorized:false as const};}
/** Trusted owning-service call, inside its original admission transaction. The
 * caller must verify its immutable original operation; this is not a wire API. */
export function reserveWorkspaceOperation(db:DatabaseSync,source:Source){
 if(!db.isTransaction||!available(db))throw Error('workspace_coordination_unavailable');
 if(![source.owner_id,source.project_id,source.operation_id].every(value=>typeof value==='string'&&ID.test(value))||source.operation_kind!=='git_index'||!/^[a-f0-9]{64}$/.test(source.binding_sha256))throw Error('workspace_reservation_source_invalid');
 const prior=record(db,source);if(prior){const current=view(db,prior);if(current.state!=='reserved')throw Error('workspace_reservation_closed');return current;}
 assertWorkspaceWritable(db,source.owner_id,source.project_id);
 if(db.prepare(`SELECT 1 FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
  WHERE c.owner_id=? AND (c.project_id=? OR c.project_id IS NULL) AND r.status IN('starting','running','waiting_user','waiting_approval','cancelling') LIMIT 1`).get(source.owner_id,source.project_id))throw Error('workspace_project_busy');
 const value:Reservation={owner_id:source.owner_id,project_id:source.project_id,operation_kind:source.operation_kind,operation_id:source.operation_id,binding_sha256:source.binding_sha256,reservation_id:'workspace-reservation-'+randomUUID(),created_at:new Date().toISOString()};
 db.prepare('INSERT INTO wb_workspace_reservations VALUES(?,?,?,?,?,?,?,?)').run(value.reservation_id,value.owner_id,value.project_id,value.operation_kind,value.operation_id,value.binding_sha256,value.created_at,digest(value));return view(db,value);
}
/** Pre-dispatch release only. The original owning service must prove that its
 * producer never started; settled/unknown producer release is a separate path. */
export function releaseUnstartedWorkspaceOperation(db:DatabaseSync,source:Source){
 if(!db.isTransaction||!available(db))throw Error('workspace_coordination_unavailable');
 const value=record(db,source);if(!value)throw Error('workspace_reservation_not_found');
 if(view(db,value).state==='released_unstarted')return view(db,value);
 db.prepare('INSERT INTO wb_workspace_reservation_releases VALUES(?,?)').run(value.reservation_id,new Date().toISOString());return view(db,value);
}
