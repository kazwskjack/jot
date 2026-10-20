import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

type Source={owner_id:string;project_id:string;operation_kind:'git_index';operation_id:string;binding_sha256:string};
type Reservation=Source&{reservation_id:string;created_at:string};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
function installSchema(db:DatabaseSync,name:string,operation:()=>void){
 db.exec('SAVEPOINT '+name);
 try{operation();db.exec('RELEASE '+name);}
 catch(error){db.exec('ROLLBACK TO '+name+'; RELEASE '+name);throw error;}
}
const normalized=(sql:string)=>sql.replace(/\bIF NOT EXISTS\s+/gi,'').replace(/\s+/g,' ').trim().replace(/;$/,'');
function installTrigger(db:DatabaseSync,name:string,sql:string){
 const prior=db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(name);
 if(prior&&(prior.type!=='trigger'||typeof prior.sql!=='string'))throw Error('workspace_member_schema_unavailable');
 if(prior&&normalized(String(prior.sql))===normalized(sql))return;
 // The caller holds the schema savepoint across the complete installation.
 // Refresh older module-owned SQL atomically; repeated calls do not change the
 // schema revision or invalidate original immutable source observations.
 db.exec('DROP TRIGGER IF EXISTS "'+name+'"');db.exec(sql);
}
export const WORKSPACE_RESERVATION_MATCH=`SELECT 1 FROM wb_workspace_reservations wr
 LEFT JOIN wb_workspace_reservation_releases wx ON wx.reservation_id=wr.reservation_id
 WHERE (wr.project_id=c.project_id OR(c.project_id IS NULL AND wr.owner_id=c.owner_id)) AND wx.reservation_id IS NULL`;

/** Original project coordination records, not a scheduler or filesystem grant.
 * Reservations never expire: lease expiry cannot prove a native producer ended.
 */
export function installWorkspaceCoordination(db:DatabaseSync){
 installSchema(db,'wb_workspace_coordination_install',()=>{
 db.exec(`CREATE TABLE IF NOT EXISTS wb_workspace_reservations(
  reservation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN('git_index')),operation_id TEXT NOT NULL,
  binding_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,record_sha256 TEXT NOT NULL,
  UNIQUE(operation_kind,operation_id));
  CREATE INDEX IF NOT EXISTS wb_workspace_reservations_project ON wb_workspace_reservations(owner_id,project_id);
  CREATE INDEX IF NOT EXISTS wb_workspace_reservations_resource ON wb_workspace_reservations(project_id);
  CREATE TABLE IF NOT EXISTS wb_workspace_reservation_releases(
  reservation_id TEXT PRIMARY KEY REFERENCES wb_workspace_reservations(reservation_id),released_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS wb_workspace_reservations_no_original_replace BEFORE INSERT ON wb_workspace_reservations
   WHEN EXISTS(SELECT 1 FROM wb_workspace_reservations WHERE operation_kind=NEW.operation_kind AND operation_id=NEW.operation_id)
   BEGIN SELECT RAISE(ABORT,'workspace_coordination_immutable'); END;`);
 installTrigger(db,'wb_workspace_run_insert',`CREATE TRIGGER wb_workspace_run_insert BEFORE INSERT ON ga_runs
   WHEN NEW.status IN('starting','running','waiting_user','waiting_approval','cancelling')
    AND EXISTS(SELECT 1 FROM ga_conversations c WHERE c.id=NEW.conversation_id AND EXISTS(${WORKSPACE_RESERVATION_MATCH}))
   BEGIN SELECT RAISE(ABORT,'workspace_coordination_required'); END;`);
 installTrigger(db,'wb_workspace_run_update',`CREATE TRIGGER wb_workspace_run_update BEFORE UPDATE OF status,conversation_id ON ga_runs
   WHEN NEW.status IN('starting','running','waiting_user','waiting_approval','cancelling')
    AND EXISTS(SELECT 1 FROM ga_conversations c WHERE c.id=NEW.conversation_id AND EXISTS(${WORKSPACE_RESERVATION_MATCH}))
   BEGIN SELECT RAISE(ABORT,'workspace_coordination_required'); END;`);
 for(const table of ['wb_workspace_reservations','wb_workspace_reservation_releases'])db.exec(`
  CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'workspace_coordination_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'workspace_coordination_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
   WHEN EXISTS(SELECT 1 FROM ${table} WHERE reservation_id=NEW.reservation_id)
   BEGIN SELECT RAISE(ABORT,'workspace_coordination_immutable'); END;`);
 installWorkspaceMemberFences(db);
 });
}
/** Fence the existing Session identity stores, including tables installed later
 * by the native workbench. No Session is created, resolved or authorized here. */
export function installWorkspaceMemberFences(db:DatabaseSync){
 if(!available(db))return;
 installSchema(db,'wb_workspace_members_install',()=>{
 const specs=[
  {table:'ga_harness_session_bindings',scope:'conversation_id',ids:['conversation_id','owner_id','session_id']},
  {table:'ga_conversation_mode_sessions',scope:'conversation_id',ids:['conversation_id','owner_id','mode','session_id']},
  {table:'ga_runtime_bindings',scope:'run_id',ids:['run_id','harness_session_ref','runtime_run_id']},
  {table:'ga_conversation_goal_controls',scope:'conversation_id',ids:['control_id','owner_id','conversation_id','session_id','run_id']},
  {table:'ga_session_checkpoints',scope:'conversation_id',ids:['checkpoint_id','run_id','conversation_id','session_ref']},
  {table:'wb_native_child_reservations',scope:'root_run_id',ids:['reservation_id','owner_id','root_run_id','child_session_ref','snapshot_json']},
  {table:'wb_native_child_runs',scope:'root_run_id',ids:['run_id','reservation_id','owner_id','root_run_id','child_session_ref']},
  {table:'wb_native_child_activations',scope:'root_run_id',ids:['run_id','activation_id','reservation_id','owner_id','root_run_id','child_session_ref','snapshot_json']},
  {table:'ga_runs',scope:'conversation_id',ids:['id','conversation_id','native_session_ref','native_owner_id','native_conversation_id'],native:true},
  {table:'ga_conversations',scope:'self',ids:['id','owner_id','project_id','workspace_id']},
 ];
 const quoted=(name:string)=>'"'+name.replaceAll('"','""')+'"';
 for(const spec of specs){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(spec.table))continue;
  const knownWork=(alias:string,session:string,owner:string)=>`EXISTS(SELECT 1 FROM ga_harness_session_bindings known
   JOIN ga_conversations known_c ON known_c.id=known.conversation_id AND known_c.owner_id=known.owner_id
   WHERE known.conversation_id=${alias}.conversation_id AND known.session_id=${session} AND known.owner_id=${owner})`;
  const relevant=(alias:string)=>{
   if(spec.native)return `${alias}.native_session_ref IS NOT NULL AND NOT (${alias}.native_conversation_id IS ${alias}.conversation_id
    AND (${knownWork(alias,alias+'.native_session_ref',alias+'.native_owner_id')} OR EXISTS(SELECT 1 FROM ga_conversation_mode_sessions known
     JOIN ga_conversations known_c ON known_c.id=known.conversation_id AND known_c.owner_id=known.owner_id
     WHERE known.conversation_id=${alias}.conversation_id AND known.session_id=${alias}.native_session_ref AND known.owner_id=${alias}.native_owner_id)))`;
   if(spec.table==='ga_conversation_mode_sessions')return `NOT (${alias}.mode='work' AND ${knownWork(alias,alias+'.session_id',alias+'.owner_id')})`;
   return '1';
  };
  const held=(alias:string)=>{
   if(spec.scope==='self')return `EXISTS(SELECT 1 FROM wb_workspace_reservations wr LEFT JOIN wb_workspace_reservation_releases wx
    ON wx.reservation_id=wr.reservation_id WHERE (wr.project_id=${alias}.project_id OR(${alias}.project_id IS NULL AND wr.owner_id=${alias}.owner_id)) AND wx.reservation_id IS NULL)`;
   const conversation=spec.scope==='conversation_id'?`${alias}.conversation_id`:`(SELECT conversation_id FROM ga_runs WHERE id=${alias}.${spec.scope})`;
   return `EXISTS(SELECT 1 FROM ga_conversations c WHERE c.id=${conversation} AND EXISTS(${WORKSPACE_RESERVATION_MATCH}))`;
  };
  // SQLite REPLACE does not run ordinary delete triggers unless recursive
  // triggers are enabled. Check every existing unique-key conflict on INSERT.
  // Partial indexes (for example one *executing* run per conversation) do not
  // imply that a queued input conflicts with an old completed native run.
  const indexes=db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique"=1 AND partial=0').all(spec.table);
  const conflicts=indexes.map(index=>{
   const columns=db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(String(index.name));
   if(!columns.length||columns.some(column=>typeof column.name!=='string'))throw Error('workspace_member_schema_unavailable');
   return '('+columns.map(column=>`previous.${quoted(String(column.name))}=NEW.${quoted(String(column.name))}`).join(' AND ')+')';
  });
  if(!conflicts.length)throw Error('workspace_member_schema_unavailable');
  const storedColumns=db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(spec.table).map(column=>String(column.name));
  const same=storedColumns.map(column=>`previous.${quoted(column)} IS NEW.${quoted(column)}`).join(' AND ');
  const changed=spec.ids.map(column=>`OLD.${quoted(column)} IS NOT NEW.${quoted(column)}`).join(' OR ');
  const table=quoted(spec.table),prefix='wb_workspace_member_'+spec.table;
  installTrigger(db,prefix+'_insert',`CREATE TRIGGER ${prefix}_insert BEFORE INSERT ON ${table}
   WHEN ((${relevant('NEW')}) AND ${held('NEW')} OR EXISTS(SELECT 1 FROM ${table} previous
    WHERE (${conflicts.join(' OR ')}) AND (${relevant('previous')}) AND ${held('previous')}))
    AND NOT EXISTS(SELECT 1 FROM ${table} previous WHERE ${same})
   BEGIN SELECT RAISE(ABORT,'workspace_coordination_required'); END;`);
  installTrigger(db,prefix+'_update',`CREATE TRIGGER ${prefix}_update BEFORE UPDATE OF ${spec.ids.map(quoted).join(',')} ON ${table}
    WHEN (${changed}) AND ((${relevant('OLD')}) AND ${held('OLD')} OR (${relevant('NEW')}) AND ${held('NEW')})
   BEGIN SELECT RAISE(ABORT,'workspace_coordination_required'); END;`);
  installTrigger(db,prefix+'_delete',`CREATE TRIGGER ${prefix}_delete BEFORE DELETE ON ${table}
    WHEN (${relevant('OLD')}) AND ${held('OLD')}
   BEGIN SELECT RAISE(ABORT,'workspace_coordination_required'); END;`);
 }
 });
}
function available(db:DatabaseSync){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_workspace_reservations'").get();}
// Ownership is checked by the original caller. The unresolved reservation owns
// the project resource across transfer; it cannot disappear with its old owner.
export function assertWorkspaceWritable(db:DatabaseSync,_owner:string,project:string){
 if(available(db)&&db.prepare(`SELECT 1 FROM wb_workspace_reservations wr
  LEFT JOIN wb_workspace_reservation_releases wx ON wx.reservation_id=wr.reservation_id
  WHERE wr.project_id=? AND wx.reservation_id IS NULL`).get(project))throw Error('workspace_coordination_required');
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
  WHERE (c.project_id=? OR(c.project_id IS NULL AND c.owner_id=?)) AND r.status IN('starting','running','waiting_user','waiting_approval','cancelling') LIMIT 1`).get(source.project_id,source.owner_id))throw Error('workspace_project_busy');
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

type FamilyMember={session_ref:string;scopes:Array<{conversation_id:string;workspace_id:string}>;source_kinds:string[]};
/** Trusted original-family inventory under the held reservation. It includes
 * archived and historical references, never resolves an Agent, and does not
 * certify native quiescence, a physical root or permission to execute. */
export function readReservedWorkspaceFamily(db:DatabaseSync,source:Source){
 if(!db.isTransaction||!available(db))throw Error('workspace_coordination_unavailable');
 if(!db.prepare('SELECT 1 FROM ga_projects WHERE id=? AND owner_id=?').get(source.project_id,source.owner_id))throw Error('project_not_found');
 const saved=record(db,source);if(!saved)throw Error('workspace_reservation_not_found');
 if(view(db,saved).state!=='reserved')throw Error('workspace_reservation_closed');
 const queries=[
  `SELECT 'work_binding' kind,b.session_id session_ref,b.owner_id record_owner,c.id conversation_id,c.owner_id,c.workspace_id,c.project_id,c.id bound_conversation FROM ga_harness_session_bindings b JOIN ga_conversations c ON c.id=b.conversation_id`,
  `SELECT 'mode_binding',b.session_id,b.owner_id,c.id,c.owner_id,c.workspace_id,c.project_id,c.id FROM ga_conversation_mode_sessions b JOIN ga_conversations c ON c.id=b.conversation_id`,
  `SELECT 'runtime',b.harness_session_ref,c.owner_id,c.id,c.owner_id,c.workspace_id,c.project_id,c.id FROM ga_runtime_bindings b JOIN ga_runs r ON r.id=b.run_id JOIN ga_conversations c ON c.id=r.conversation_id`,
  `SELECT 'run_native',r.native_session_ref,r.native_owner_id,c.id,c.owner_id,c.workspace_id,c.project_id,r.native_conversation_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.native_session_ref IS NOT NULL`,
  `SELECT 'checkpoint',b.session_ref,c.owner_id,c.id,c.owner_id,c.workspace_id,c.project_id,r.conversation_id FROM ga_session_checkpoints b JOIN ga_runs r ON r.id=b.run_id JOIN ga_conversations c ON c.id=b.conversation_id`,
  `SELECT 'goal_control',b.session_id,b.owner_id,c.id,c.owner_id,c.workspace_id,c.project_id,c.id FROM ga_conversation_goal_controls b JOIN ga_conversations c ON c.id=b.conversation_id`,
 ];
 const members=new Map<string,{scopes:Map<string,{conversation_id:string;workspace_id:string}>;kinds:Set<string>}>();
 const add=(row:Record<string,unknown>)=>{
  if(!['session_ref','conversation_id','workspace_id'].every(key=>typeof row[key]==='string'&&ID.test(row[key] as string))
   ||row.owner_id!==source.owner_id||row.record_owner!==source.owner_id||row.project_id!==source.project_id||row.bound_conversation!==row.conversation_id)throw Error('workspace_family_unconfirmed');
  const id=String(row.session_ref);let member=members.get(id);if(!member){if(members.size>=256)throw Error('workspace_family_too_large');members.set(id,member={scopes:new Map(),kinds:new Set()});}
  member.scopes.set(String(row.conversation_id)+'\0'+String(row.workspace_id),{conversation_id:String(row.conversation_id),workspace_id:String(row.workspace_id)});member.kinds.add(String(row.kind));
 };
 const union=queries.join(' UNION ALL ');
 const rows=db.prepare(`SELECT DISTINCT * FROM (${union}) WHERE project_id=? OR(owner_id=? AND project_id IS NULL) LIMIT 10001`).all(source.project_id,source.owner_id);
 if(rows.length>10000)throw Error('workspace_family_too_large');for(const row of rows)add(row);
 const nativeTable=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_native_child_reservations'").get();
 if(nativeTable){
  const children=db.prepare(`SELECT b.*,c.id conversation_id,c.owner_id scope_owner,c.workspace_id scope_workspace,c.project_id scope_project
   FROM wb_native_child_reservations b JOIN ga_runs r ON r.id=b.root_run_id JOIN ga_conversations c ON c.id=r.conversation_id
   WHERE c.project_id=? OR(b.owner_id=? AND (c.project_id IS NULL OR NOT json_valid(b.snapshot_json)
    OR CASE WHEN json_valid(b.snapshot_json) THEN json_extract(b.snapshot_json,'$.project_id') END=?)) LIMIT 10001`).all(source.project_id,source.owner_id,source.project_id);
  if(children.length>10000)throw Error('workspace_family_too_large');
  for(const child of children){
   let snapshot:Record<string,unknown>;try{snapshot=JSON.parse(String(child.snapshot_json));}catch{throw Error('workspace_family_unconfirmed');}
   if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)||snapshot.owner_id!==source.owner_id||snapshot.project_id!==source.project_id
    ||snapshot.workspace_id!==child.scope_workspace||snapshot.root_run_id!==child.root_run_id||snapshot.child_session_ref!==child.child_session_ref
    ||child.owner_id!==source.owner_id||child.scope_owner!==source.owner_id||child.scope_project!==source.project_id)throw Error('workspace_family_unconfirmed');
   for(const [kind,ref] of [['native_parent',snapshot.parent_session_ref],['native_child',snapshot.child_session_ref]])add({kind,session_ref:ref,record_owner:child.owner_id,
    conversation_id:child.conversation_id,bound_conversation:child.conversation_id,owner_id:child.scope_owner,workspace_id:child.scope_workspace,project_id:child.scope_project});
  }
 }
 // Detect cross-table collisions too: individual binding tables have their own
 // unique indexes, but another project's alias must not borrow this live Agent.
 const ids=[...members.keys()];if(ids.length){
  const ambiguous=db.prepare(`SELECT 1 FROM (${union}) WHERE session_ref IN(${ids.map(()=>'?').join(',')})
   AND(owner_id IS NOT ? OR record_owner IS NOT ? OR project_id IS NOT ? OR bound_conversation IS NOT conversation_id) LIMIT 1`).get(...ids,source.owner_id,source.owner_id,source.project_id);
  if(ambiguous)throw Error('workspace_family_ambiguous');
  if(nativeTable){
   const slots=ids.map(()=>'?').join(','),parent=`CASE WHEN json_valid(b.snapshot_json) THEN json_extract(b.snapshot_json,'$.parent_session_ref') END`;
   const collision=db.prepare(`SELECT 1 FROM wb_native_child_reservations b JOIN ga_runs r ON r.id=b.root_run_id
    JOIN ga_conversations c ON c.id=r.conversation_id WHERE(b.child_session_ref IN(${slots}) OR ${parent} IN(${slots}))
    AND(b.owner_id IS NOT ? OR c.owner_id IS NOT ? OR c.project_id IS NOT ?) LIMIT 1`).get(...ids,...ids,source.owner_id,source.owner_id,source.project_id);
   if(collision)throw Error('workspace_family_ambiguous');
  }
 }
 const result:FamilyMember[]=[...members].map(([session_ref,member])=>({session_ref,scopes:[...member.scopes.values()].sort((a,b)=>(a.conversation_id+'\0'+a.workspace_id).localeCompare(b.conversation_id+'\0'+b.workspace_id,'en')),source_kinds:[...member.kinds].sort()})).sort((a,b)=>a.session_ref.localeCompare(b.session_ref,'en'));
 // A queued input may add evidence for an already held Session. Only original
 // member identities and workspace relationships define the membership fence.
 const family_sha256=digest({reservation_id:saved.reservation_id,owner_id:source.owner_id,project_id:source.project_id,binding_sha256:source.binding_sha256,
  members:result.map(({session_ref,scopes})=>({session_ref,scopes}))});
 return {protocol:1 as const,reservation_id:saved.reservation_id,execution_id:source.operation_id,owner_id:source.owner_id,project_id:source.project_id,
  binding_sha256:source.binding_sha256,family_sha256,members:result,execution_authorized:false as const};
}
