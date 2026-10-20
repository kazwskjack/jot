import {DatabaseSync} from 'node:sqlite';
import {lstatSync,realpathSync} from 'node:fs';import {isAbsolute,resolve} from 'node:path';
import {retainOriginalGitDatabase} from '../git/database-identity.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {workspacePublicationSchema,upgradeWorkspacePublicationCoordination,assertWorkspacePublicationMaintenance} from '../workbench/workspace-coordination-upgrade.ts';
import {installWorkPublicationIntents} from '../persistent-tasks/work-publication-intents.ts';
import {installWorkPublicationExecutions} from '../persistent-tasks/work-publication-executions.ts';

type SchemaObject={type:string;name:string;tbl_name:string;sql:string};
type SchemaState='absent'|'partial'|'current'|'unsupported';
const fail=(code:string):never=>{throw Error('publication_maintenance_'+code)};
function objects(db:DatabaseSync):SchemaObject[]{return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'wb_work_publication_*' OR tbl_name GLOB 'wb_work_publication_*' ORDER BY type,name").all() as SchemaObject[]}
let expected:readonly SchemaObject[]|undefined;
function expectedObjects(){
 if(!expected){const db=new DatabaseSync(':memory:');try{installWorkPublicationIntents(db);installWorkPublicationExecutions(db);expected=Object.freeze(objects(db).map(v=>Object.freeze({...v})))}finally{db.close()}}
 return expected;
}
function publicationSchema(db:DatabaseSync):SchemaState{
 const actual=objects(db),wanted=expectedObjects();if(!actual.length)return 'absent';
 const byName=new Map(wanted.map(v=>[v.name,v]));
 if(actual.some(v=>JSON.stringify(v)!==JSON.stringify(byName.get(v.name))))return 'unsupported';
 return actual.length===wanted.length?'current':'partial';
}
function openExisting<T>(path:string,writable:boolean,operation:(db:DatabaseSync)=>T):T{
 try{
  if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)fail('database_invalid');
  const stat=lstatSync(path,{bigint:true}),actual=realpathSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||(process.platform==='win32'?actual.toLowerCase()!==path.toLowerCase():actual!==path))fail('database_invalid');
 }catch{fail('database_invalid')}
 const db=new DatabaseSync(path,{readOnly:!writable});
 try{db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');return operation(db)}finally{db.close()}
}
function view(db:DatabaseSync){const identity=retainOriginalGitDatabase(db);return{protocol:1 as const,database_sha256:identity.sha256,coordination:workspacePublicationSchema(db),publication_schema:publicationSchema(db),execution_authorized:false as const,offline_pool_drain_observed:false as const}}

/** Offline inspection only. Does not bootstrap a missing DB, upgrade a live
 * server or expose host paths, data, credentials or user approval authority. */
export function inspectPublicationMaintenance(path:string){return openExisting(path,false,db=>{db.exec('BEGIN DEFERRED');try{return view(db)}finally{db.exec('ROLLBACK')}})}

export function applyPublicationMaintenance(path:string,command:unknown){
 if(!command||typeof command!=='object'||Array.isArray(command)||Object.keys(command).sort().join(',')!=='expected_database_sha256,offline')fail('command_invalid');
 const input=command as {expected_database_sha256:unknown;offline:unknown};
 if(input.offline!==true||typeof input.expected_database_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.expected_database_sha256))fail('command_invalid');
 return openExisting(path,true,db=>{
  const identity=retainOriginalGitDatabase(db),before=view(db);if(identity.sha256!==input.expected_database_sha256)fail('database_changed');
  if(before.publication_schema==='unsupported')fail('schema_unsupported');
  assertWorkspacePublicationMaintenance(db);
  const coordination=upgradeWorkspacePublicationCoordination(db);
  // The original coordinator owns its separate generalized SQLite table change.
  // If later installation fails, that committed upgrade is not claimed rolled
  // back. Exact partial storage can resume; incompatible storage is never fixed.
  withImmediateTransaction(db,()=>{
   identity.assertCurrent();assertWorkspacePublicationMaintenance(db);
   if(publicationSchema(db)==='unsupported')fail('schema_unsupported');
   installWorkPublicationIntents(db);installWorkPublicationExecutions(db);
   if(publicationSchema(db)!=='current'||db.prepare('PRAGMA foreign_key_check').all().length)fail('integrity');identity.assertCurrent();
  });
  return{...view(db),state:coordination.state==='upgraded'?'upgraded' as const:before.publication_schema==='current'?'already_current' as const:'storage_installed' as const};
 });
}
