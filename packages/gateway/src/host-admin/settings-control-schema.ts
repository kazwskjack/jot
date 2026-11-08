import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {HOST_SETTINGS_OPERATION_RECEIPT_DDL_APPROVED,assertHostSettingsOperationReceiptSchema} from './settings-operation-receipt-schema.ts';

const VERSION_DDL=`CREATE TABLE ga_host_settings_versions (
 owner_id TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 namespace TEXT NOT NULL,
 settings_version INTEGER NOT NULL CHECK(settings_version >= 1),
 dsh_revision INTEGER NOT NULL CHECK(dsh_revision >= 0),
 schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint) = 64),
 settings_sha256 TEXT NOT NULL CHECK(length(settings_sha256) = 64),
 reconciliation_sha256 TEXT NOT NULL CHECK(length(reconciliation_sha256) = 64),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id, profile_id, namespace)
)`;
const GATE_DDL=`CREATE TABLE ga_host_settings_admission_gate (
 gate_id INTEGER PRIMARY KEY CHECK(gate_id = 1),
 state TEXT NOT NULL CHECK(state IN ('open', 'closed')),
 fence_id TEXT,
 scope_json TEXT,
 updated_at TEXT NOT NULL
)`;
const ADMISSIONS_DDL=`CREATE TABLE ga_host_settings_admissions (
 admission_id TEXT PRIMARY KEY,
 started_at TEXT NOT NULL
)`;
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const NAMESPACE=/^[a-z][a-z0-9._-]{0,127}$/;
const SCOPE_KEYS='actor_id,base_settings_sha256,expected_dsh_revision,expected_schema_fingerprint,expected_version,host_instance_id,namespace,operation,owner_id,patch_sha256,policy_epoch,profile_id';
const CONTROL_TABLES=[
 ['ga_host_settings_operations',HOST_SETTINGS_OPERATION_RECEIPT_DDL_APPROVED],
 ['ga_host_settings_versions',VERSION_DDL],
 ['ga_host_settings_admission_gate',GATE_DDL],
 ['ga_host_settings_admissions',ADMISSIONS_DDL],
] as const;

export type HostSettingsFenceScopeV1=Readonly<{
 owner_id:string;actor_id:string;profile_id:string;host_instance_id:string;policy_epoch:number;namespace:string;operation:'settings.update';
 expected_version:number;expected_dsh_revision:number;expected_schema_fingerprint:string;base_settings_sha256:string;patch_sha256:string;
}>;
export type HostSettingsFenceBindingV1=Readonly<{scope:HostSettingsFenceScopeV1;activity_admission_id:string}>;

function normalized(sql:string){return sql.replace(/\s+/g,' ').trim();}
function fingerprint(sql:string){return createHash('sha256').update(normalized(sql),'utf8').digest('hex');}
function tableSql(db:DatabaseSync,name:string){return (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as {sql?:unknown}|undefined)?.sql;}
function present(db:DatabaseSync,name:string){return typeof tableSql(db,name)==='string';}
function assertTable(db:DatabaseSync,name:string,expected:string){
 const sql=tableSql(db,name);
 if(typeof sql!=='string'||fingerprint(sql)!==fingerprint(expected))throw new Error('host_settings_control_schema_mismatch_offline_migration_required');
}

export function parseHostSettingsFenceBinding(value:unknown):HostSettingsFenceBindingV1|undefined{
 if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>8192)return;
 try{
  const parsed:unknown=JSON.parse(value);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return;
  const binding=parsed as Record<string,unknown>,scope=binding.scope;
  if(Object.keys(binding).sort().join(',')!=='activity_admission_id,scope'||typeof binding.activity_admission_id!=='string'||!UUID.test(binding.activity_admission_id)
   ||!scope||typeof scope!=='object'||Array.isArray(scope))return;
  const row=scope as Record<string,unknown>;
  if(Object.keys(row).sort().join(',')!==SCOPE_KEYS||!['owner_id','actor_id','profile_id','host_instance_id'].every(key=>typeof row[key]==='string'&&ID.test(row[key] as string))
   ||!Number.isSafeInteger(row.policy_epoch)||Number(row.policy_epoch)<1||typeof row.namespace!=='string'||!NAMESPACE.test(row.namespace)||row.namespace==='jot-host-policy'
   ||row.operation!=='settings.update'||!Number.isSafeInteger(row.expected_version)||Number(row.expected_version)<1
   ||!Number.isSafeInteger(row.expected_dsh_revision)||Number(row.expected_dsh_revision)<0
   ||!['expected_schema_fingerprint','base_settings_sha256','patch_sha256'].every(key=>typeof row[key]==='string'&&HASH.test(row[key] as string)))return;
  if(Buffer.byteLength(JSON.stringify(binding),'utf8')>8192)return;
  return{scope:row as unknown as HostSettingsFenceScopeV1,activity_admission_id:binding.activity_admission_id};
 }catch{return;}
}

function assertGateState(db:DatabaseSync){
 const rows=db.prepare('SELECT gate_id,state,fence_id,scope_json FROM ga_host_settings_admission_gate').all() as Array<{gate_id:number;state:string;fence_id:string|null;scope_json:string|null}>;
 if(rows.length!==1||rows[0]?.gate_id!==1)throw new Error('host_settings_admission_gate_state_invalid');
 const row=rows[0];
 if(!row)throw new Error('host_settings_admission_gate_state_invalid');
 if(row.state==='open'&&row.fence_id===null&&row.scope_json===null)return;
 const binding=parseHostSettingsFenceBinding(row.scope_json);
 if(row.state!=='closed'||typeof row.fence_id!=='string'||!UUID.test(row.fence_id)||!binding
  ||!db.prepare('SELECT 1 FROM ga_host_settings_admissions WHERE admission_id=?').get(binding.activity_admission_id))
  throw new Error('host_settings_admission_gate_state_invalid');
 const scope=binding.scope;
 const version=db.prepare('SELECT settings_version,dsh_revision,schema_fingerprint,settings_sha256,reconciliation_sha256 FROM ga_host_settings_versions WHERE owner_id=? AND profile_id=? AND namespace=?')
  .get(scope.owner_id,scope.profile_id,scope.namespace) as {settings_version:unknown;dsh_revision:unknown;schema_fingerprint:unknown;settings_sha256:unknown;reconciliation_sha256:unknown}|undefined;
 if(!version||!Number.isSafeInteger(version.settings_version)||Number(version.settings_version)<scope.expected_version
  ||!Number.isSafeInteger(version.dsh_revision)||Number(version.dsh_revision)<scope.expected_dsh_revision
  ||version.schema_fingerprint!==scope.expected_schema_fingerprint
  ||![version.schema_fingerprint,version.settings_sha256,version.reconciliation_sha256].every(value=>typeof value==='string'&&HASH.test(value)))
  throw new Error('host_settings_admission_gate_version_invalid');
}

export function assertHostSettingsControlSchema(db:DatabaseSync){
 for(const [name,ddl] of CONTROL_TABLES)assertTable(db,name,ddl);
 assertHostSettingsOperationReceiptSchema(db);
 assertGateState(db);
}

/** Install all four approved controls together on a fresh Gateway database; existing shapes are validation-only. */
export function installHostSettingsControlSchema(db:DatabaseSync):void{
 if(!db||typeof db.exec!=='function'||db.isTransaction)throw new TypeError('host_settings_control_schema_database_invalid');
 db.exec('BEGIN IMMEDIATE');
 try{
  const presentTables=CONTROL_TABLES.map(([name])=>present(db,name));
  if(!presentTables.some(Boolean)){
   db.exec(HOST_SETTINGS_OPERATION_RECEIPT_DDL_APPROVED);
   db.exec(VERSION_DDL);
   db.exec(GATE_DDL);
   db.exec(ADMISSIONS_DDL);
   db.prepare("INSERT INTO ga_host_settings_admission_gate(gate_id,state,fence_id,scope_json,updated_at) VALUES(1,'open',NULL,NULL,?)")
    .run(new Date().toISOString());
  }else{
   CONTROL_TABLES.forEach(([name,ddl],index)=>{if(presentTables[index])assertTable(db,name,ddl);});
   if(presentTables.some(value=>!value))throw new Error('host_settings_control_schema_partial_offline_migration_required');
  }
  assertHostSettingsControlSchema(db);
  db.exec('COMMIT');
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}
