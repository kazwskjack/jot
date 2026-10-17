import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {WorkCycles,type WorkCycleScope} from './work-cycles.ts';
import type {PrivateSourceRecord} from './workbench-source.ts';
import {workspaceRelativePath} from './workspace-provider.ts';
type Row=Record<string,any>;
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value:unknown,keys:string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error();return value as Row;};
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
/** Private host-only persistence; shape verification grants no read capability.
 * Source restore and byte verification remain the source adapter's responsibility. */
export class WorkCycleSources{
 private readonly db:DatabaseSync;
 private readonly cycles:WorkCycles;
 constructor(db:DatabaseSync){this.db=db;this.cycles=new WorkCycles(db);}
 private validate(owner:string,scope:WorkCycleScope,cycleId:string,value:unknown,code:string):PrivateSourceRecord{
  try{const r=exact(value,['protocol','provider','owner','scope','cycle_id','root','files','sha256']);
   exact(r.scope,['agent_id','workspace_id','project_id']);
   if(r.protocol!==1||r.provider!=='workbench-project'||r.owner!==owner||r.cycle_id!==cycleId||canonicalJson(r.scope)!==canonicalJson(scope)||!digest(r.sha256)||!Array.isArray(r.files))throw Error();
   if(r.root!==null){const root=exact(r.root,['canonical','dev','ino']);if(typeof root.canonical!=='string'||!isAbsolute(root.canonical)||/[\x00-\x1f\x7f]/.test(root.canonical)||typeof root.dev!=='string'||!/^\d+$/.test(root.dev)||typeof root.ino!=='string'||!/^\d+$/.test(root.ino))throw Error();}
   if(r.files.length&&r.root===null)throw Error();
   const seen=new Set<string>();let previous:string|undefined;
   for(const value of r.files){const f=exact(value,['path','version','sha256','size','blob_name']),path=workspaceRelativePath(f.path),key=path.normalize('NFC').toLowerCase();
    if(seen.has(key)||(previous!==undefined&&Buffer.compare(Buffer.from(previous),Buffer.from(path))>=0)||!Number.isSafeInteger(f.version)||f.version<1||!digest(f.sha256)||!Number.isSafeInteger(f.size)||f.size<0||typeof f.blob_name!=='string'||!/^[-a-zA-Z0-9_]+\.[a-zA-Z0-9]+$/.test(f.blob_name))throw Error();
    seen.add(key);previous=path;
    // Historical immutable versions are allowed even after current inventory changes.
    const original=this.db.prepare('SELECT sha256,size,blob_name FROM wb_file_versions WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=? AND version=?').get(owner,scope.workspace_id,scope.project_id,path,f.version) as Row|undefined;
    if(!original||original.sha256!==f.sha256||original.size!==f.size||original.blob_name!==f.blob_name)throw Error();
   }
   const {sha256,...body}=r;if(hash(body)!==sha256)throw Error();return frozen(JSON.parse(canonicalJson(r))) as PrivateSourceRecord;
  }catch{throw Error(code);}
 }
 private row(owner:string,scope:WorkCycleScope,cycleId:string){const row=this.db.prepare('SELECT * FROM wb_discovery_work_cycle_sources WHERE cycle_id=?').get(cycleId) as Row|undefined;if(!row)return undefined;
  try{if(row.owner_id!==owner||row.agent_id!==scope.agent_id||row.project_id!==scope.project_id||row.workspace_id!==scope.workspace_id)throw Error();
   const parsed=JSON.parse(row.record_json),record=this.validate(owner,scope,cycleId,parsed,'work_cycle_source_corrupt');
   if(canonicalJson(record)!==row.record_json||hash(record)!==row.record_sha256||hash(record.files.map(({path,version,sha256,size})=>({path,version,sha256,size})))!==row.source_manifest_sha256)throw Error();return record;
  }catch{throw Error('work_cycle_source_corrupt');}
 }
 get(owner:string,scope:WorkCycleScope,cycleId:string):PrivateSourceRecord|undefined{
  const read=()=>{this.cycles.guard(owner,scope,cycleId);return this.row(owner,scope,cycleId);};
  if(this.db.isTransaction)return read();this.db.exec('BEGIN DEFERRED');try{return read();}finally{this.db.exec('ROLLBACK');}
 }
 pin(owner:string,scope:WorkCycleScope,cycleId:string,record:PrivateSourceRecord):PrivateSourceRecord{
  return withImmediateTransaction(this.db,()=>{this.cycles.guard(owner,scope,cycleId);const valid=this.validate(owner,scope,cycleId,record,'work_cycle_source_invalid'),prior=this.row(owner,scope,cycleId);
   if(prior){if(canonicalJson(prior)!==canonicalJson(valid))throw Error('work_cycle_source_conflict');return prior;}
   this.db.prepare('INSERT INTO wb_discovery_work_cycle_sources VALUES(?,?,?,?,?,?,?,?,?)').run(cycleId,owner,scope.project_id,scope.workspace_id,scope.agent_id,canonicalJson(valid),hash(valid),hash(valid.files.map(({path,version,sha256,size})=>({path,version,sha256,size}))),new Date().toISOString());return valid;
  });
 }
}
