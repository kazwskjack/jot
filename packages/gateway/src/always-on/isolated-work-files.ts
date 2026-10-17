import {createHash,randomUUID} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {lstat,realpath,readdir,open,mkdir,rename} from 'node:fs/promises';
import {resolve,dirname,join,relative,sep,isAbsolute} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {workspaceRelativePath,type SnapshotRecoveryRecord} from './workspace-provider.ts';
import type {LogicalPreparedWorkCycleWorkspace} from './logical-work-cycle-workspace.ts';

export type IsolatedFileIdentity=Readonly<{owner_id:string;workspace_id:string;project_id:string;agent_id:string;cycle_id:string;snapshot_id:string;run_id:string;occurrence_id:string;call_id:string}>;
export type IsolatedFileOperation={operation:'files.list'}|{operation:'files.read';path:string}|{operation:'files.write';path:string;content:string;expected_version:number};
export type IsolatedFileResult=Readonly<{source:'isolated';receipt_id:string;cycle_id:string;snapshot_id:string;run_id:string;occurrence_id:string;call_id:string;[key:string]:unknown}>;
/** This resolver and synchronous guard are host injection boundaries, never model input. */
export type ResolvedIsolatedFiles={workspace:LogicalPreparedWorkCycleWorkspace;record:SnapshotRecoveryRecord;binding:Readonly<Omit<IsolatedFileIdentity,'call_id'>>;guard:()=>void};
type Options={db:DatabaseSync;resolve:(identity:IsolatedFileIdentity)=>Promise<ResolvedIsolatedFiles>;commitReceipt:(db:DatabaseSync,result:IsolatedFileResult)=>void};
type Fact={kind:'file'|'directory';identity:string;sha256?:string;size?:number};
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const meta=(s:BigIntStats)=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
const fail=(v:string)=>Error('isolated_file_'+v);
function syncGuard(guard:()=>void){const result=guard() as unknown;if(result&&typeof(result as PromiseLike<unknown>).then==='function')throw fail('guard_must_be_synchronous');}
function transaction<T>(db:DatabaseSync,body:()=>T):T{if(db.isTransaction)throw fail('outer_transaction_forbidden');db.exec('BEGIN IMMEDIATE');try{const result=body();db.exec('COMMIT');return result;}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}}
function parseOperation(input:IsolatedFileOperation):IsolatedFileOperation{
 if(!input||typeof input!=='object')throw fail('operation_invalid');
 const keys=Object.keys(input).sort().join(',');
 if(input.operation==='files.list'&&keys==='operation')return Object.freeze({...input});
 if(input.operation==='files.read'&&keys==='operation,path')return Object.freeze({...input,path:workspaceRelativePath(input.path)});
 if(input.operation==='files.write'&&keys==='content,expected_version,operation,path'&&typeof input.content==='string'&&Buffer.byteLength(input.content)<=1_048_576&&Number.isSafeInteger(input.expected_version)&&input.expected_version>=0)return Object.freeze({...input,path:workspaceRelativePath(input.path)});
 throw fail('operation_invalid');
}
function identityOf(value:IsolatedFileIdentity){const keys=['owner_id','workspace_id','project_id','agent_id','cycle_id','snapshot_id','run_id','occurrence_id','call_id'];if(!value||Object.keys(value).sort().join(',')!==keys.sort().join(',')||keys.some(k=>typeof value[k as keyof IsolatedFileIdentity]!=='string'||!value[k as keyof IsolatedFileIdentity]||value[k as keyof IsolatedFileIdentity].length>256))throw fail('identity_invalid');return Object.freeze({...value});}

/** Async isolated IO prerequisite. Unknown intents are held, never automatically repeated. */
export class IsolatedWorkFiles{
 private readonly options:Options;
 constructor(options:Options){this.options=options;}
 private async safePath(root:string,path:string,missing=false){
  const target=resolve(root,...path.split('/')),rel=relative(root,target);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw fail('path_unsafe');
  for(let p=target;;p=dirname(p)){
   try{const s=await lstat(p,{bigint:true});if(s.isSymbolicLink()||s.isFile()&&s.nlink!==1n)throw fail('path_unsafe');if(p!==target&&!s.isDirectory())throw fail('path_unsafe');}
   catch(e){if(!(missing&&(e as NodeJS.ErrnoException).code==='ENOENT'))throw e;}
   if(dirname(p)===p)break;
  }
  return target;
 }
 private async rootCurrent(bound:ResolvedIsolatedFiles){
  const {workspace,record}=bound;
  for(const root of [record.storage_root,record.isolated_root]){await this.safePath(root.path,'');const stat=await lstat(root.path,{bigint:true});if(!stat.isDirectory()||String(stat.dev)!==root.dev||String(stat.ino)!==root.ino||await realpath(root.path)!==root.canonical)throw fail('root_changed');}
  if(resolve(workspace.snapshot.isolated_root)!==record.isolated_root.path)throw fail('binding_invalid');syncGuard(bound.guard);
 }
 private async bytes(bound:ResolvedIsolatedFiles,path:string,collect=true){
  await this.rootCurrent(bound);const target=await this.safePath(bound.record.isolated_root.path,path),before=await lstat(target,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size>BigInt(bound.record.limits.max_file_bytes))throw fail('path_unsafe');
  const handle=await open(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{if(meta(await handle.stat({bigint:true}))!==meta(before))throw fail('file_changed');const chunks:Buffer[]=[],hash=createHash('sha256');let size=0;const block=Buffer.alloc(65536);for(;;){syncGuard(bound.guard);const {bytesRead}=await handle.read(block,0,block.length,null);if(!bytesRead)break;size+=bytesRead;if(size>bound.record.limits.max_file_bytes)throw fail('limit');hash.update(block.subarray(0,bytesRead));if(collect){if(size>1_048_576)throw fail('read_limit');chunks.push(Buffer.from(block.subarray(0,bytesRead)));}}
   if(meta(await handle.stat({bigint:true}))!==meta(before))throw fail('file_changed');await this.rootCurrent(bound);await this.safePath(bound.record.isolated_root.path,path);if(meta(await lstat(target,{bigint:true}))!==meta(before))throw fail('file_changed');return {bytes:Buffer.concat(chunks),identity:meta(before),size,sha256:hash.digest('hex')};
  }finally{await handle.close();}
 }
 private async inventory(bound:ResolvedIsolatedFiles,changed?:{path:string;sha256:string;size:number}){
  await this.rootCurrent(bound);const map=new Map<string,Fact>();let total=0;
  const visit=async(path:string):Promise<void>=>{workspaceRelativePath(path);if(path.split('/').length>bound.record.limits.max_depth||map.size>=bound.record.limits.max_entries)throw fail('limit');
   const target=await this.safePath(bound.record.isolated_root.path,path),s=await lstat(target,{bigint:true});
   if(s.isDirectory()){map.set(path,{kind:'directory',identity:meta(s)});for(const entry of await readdir(target))await visit(path+'/'+entry);}
   else if(s.isFile()){const read=await this.bytes(bound,path,false);total+=read.size;if(total>bound.record.limits.max_total_bytes)throw fail('limit');map.set(path,{kind:'file',identity:read.identity,sha256:read.sha256,size:read.size});}
   else throw fail('path_unsafe');
  };
  for(const entry of await readdir(bound.record.isolated_root.path))await visit(entry);
  const plans=new Set(bound.workspace.plan_paths),base=new Map(bound.record.manifest.entries.map(e=>[e.path,e]));
  const structural=(p:string)=>[...plans].some(path=>path.startsWith(p+'/'));
  for(const path of plans){
   const latest=this.options.db.prepare('SELECT sha256,length(bytes) size FROM wb_isolated_file_results WHERE cycle_id=? AND snapshot_id=? AND path=? AND version IS NOT NULL ORDER BY version DESC LIMIT 1').get(bound.binding.cycle_id,bound.binding.snapshot_id,path);
   const original=base.get(path),expected=changed?.path===path?changed:latest??(original?.kind==='file'?{sha256:original.sha256,size:original.bytes}:undefined),actual=map.get(path);
   if(expected? !actual||actual.kind!=='file'||actual.sha256!==expected.sha256||actual.size!==Number(expected.size):!!actual)throw fail('file_changed');
  }
  for(const [path,fact]of map){const expected=base.get(path);if(plans.has(path)){if(fact.kind!=='file')throw fail('path_unsafe');continue;}if(!expected){if(fact.kind==='directory'&&structural(path))continue;throw fail('context_changed');}if(fact.kind!==expected.kind||expected.kind==='file'&&(fact.sha256!==expected.sha256||fact.size!==expected.bytes))throw fail('context_changed');}
  for(const [path]of base)if(!plans.has(path)&&!map.has(path))throw fail('context_changed');
  await this.rootCurrent(bound);return {map,total};
 }
 private currentVersion(identity:IsolatedFileIdentity,path:string){const row=this.options.db.prepare('SELECT max(version) version FROM wb_isolated_file_results WHERE cycle_id=? AND snapshot_id=? AND path=?').get(identity.cycle_id,identity.snapshot_id,path);return Number(row?.version??0);}
 private async ancestorsCurrent(bound:ResolvedIsolatedFiles,directories:Map<string,string>){
  for(const [path,identity]of directories){const target=await this.safePath(bound.record.isolated_root.path,path),stat=await lstat(target,{bigint:true});if(!stat.isDirectory()||meta(stat).split(':').slice(0,3).join(':')!==identity)throw fail('ancestor_changed');}
 }
 async execute(inputIdentity:IsolatedFileIdentity,input:IsolatedFileOperation):Promise<IsolatedFileResult>{
  const {db}=this.options;if(db.isTransaction)throw fail('outer_transaction_forbidden');const identity=identityOf(inputIdentity),operation=parseOperation(input),key=sha(canonicalJson(identity)),digest=sha(canonicalJson({identity,operation}));
  const old=db.prepare('SELECT digest FROM wb_isolated_file_intents WHERE call_key=?').get(key);if(old){if(old.digest!==digest)throw fail('identity_conflict');const saved=db.prepare('SELECT response_json FROM wb_isolated_file_results WHERE call_key=?').get(key);if(saved)return Object.freeze(JSON.parse(String(saved.response_json)));throw fail('uncertain');}
  const bound=await this.options.resolve(identity),w=bound.workspace,r=bound.record;
  if(w.cycle.cycle_id!==identity.cycle_id||canonicalJson(bound.binding)!==canonicalJson(Object.fromEntries(Object.entries(identity).filter(([k])=>k!=='call_id')))||w.snapshot.receipt.snapshot_id!==identity.snapshot_id||r.snapshot_id!==identity.snapshot_id||canonicalJson(w.snapshot.manifest)!==canonicalJson(r.manifest))throw fail('binding_invalid');
  syncGuard(bound.guard);
  if(operation.operation==='files.write'&&!w.plan_paths.includes(operation.path))throw fail('path_not_granted');
  if(db.prepare('SELECT 1 FROM wb_isolated_file_pending WHERE cycle_id=?').get(identity.cycle_id))throw fail('pending');
  const before=await this.inventory(bound);
  if(operation.operation==='files.write'&&(Buffer.byteLength(operation.content)>r.limits.max_file_bytes||before.total-(before.map.get(operation.path)?.size??0)+Buffer.byteLength(operation.content)>r.limits.max_total_bytes||operation.path.split('/').length>r.limits.max_depth))throw fail('limit');
  transaction(db,()=>{syncGuard(bound.guard);if(db.prepare('SELECT 1 FROM wb_isolated_file_pending WHERE cycle_id=?').get(identity.cycle_id))throw fail('pending');if(operation.operation==='files.write'&&this.currentVersion(identity,operation.path)!==operation.expected_version)throw fail('version_conflict');db.prepare('INSERT INTO wb_isolated_file_intents VALUES(?,?,?,?,?,?,?,?)').run(key,identity.cycle_id,identity.snapshot_id,canonicalJson(identity),canonicalJson(operation),digest,canonicalJson([...before.map]),new Date().toISOString());db.prepare('INSERT INTO wb_isolated_file_pending VALUES(?,?)').run(identity.cycle_id,key);});
  const directories=new Map([...before.map].filter(([,fact])=>fact.kind==='directory').map(([path,fact])=>[path,fact.identity.split(':').slice(0,3).join(':')]));
  let bytes:Buffer|undefined;let output:Record<string,unknown>;
  if(operation.operation==='files.list')output={files:[...before.map].filter(([,f])=>f.kind==='file').map(([path,f])=>({path,size:f.size,sha256:f.sha256,version:this.currentVersion(identity,path)}))};
  else if(operation.operation==='files.read'){const result=await this.bytes(bound,operation.path);if(result.bytes.length>1_048_576)throw fail('read_limit');output={path:operation.path,content:result.bytes.toString('utf8'),size:result.bytes.length,sha256:sha(result.bytes),version:this.currentVersion(identity,operation.path)};}
  else{
   bytes=Buffer.from(operation.content);const parent=dirname(operation.path).replaceAll('\\','/');
   if(parent!=='.'){const parts=parent.split('/');for(let n=1;n<=parts.length;n++){const p=parts.slice(0,n).join('/');await this.rootCurrent(bound);await this.ancestorsCurrent(bound,directories);const safe=await this.safePath(r.isolated_root.path,p,true);try{await mkdir(safe);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}await this.safePath(r.isolated_root.path,p);if(!directories.has(p))directories.set(p,meta(await lstat(safe,{bigint:true})).split(':').slice(0,3).join(':'));}}
   const target=await this.safePath(r.isolated_root.path,operation.path,true),temp=join(dirname(target),'.jot-write-'+randomUUID());await this.rootCurrent(bound);
   const handle=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|(constants.O_NOFOLLOW??0),0o600);let staged:BigIntStats;
   try{await handle.writeFile(bytes);await handle.sync();staged=await handle.stat({bigint:true});if(staged.nlink!==1n||!staged.isFile())throw fail('path_unsafe');}finally{await handle.close();}
   // Temp bytes are excluded from inventory only by removing their pathname from
   // this private verification pass; a substituted temp is never accepted.
   const tempStat=await lstat(temp,{bigint:true});if(meta(tempStat)!==meta(staged!))throw fail('file_changed');
   await this.rootCurrent(bound);await this.safePath(r.isolated_root.path,operation.path,true);
   const initial=before.map.get(operation.path);let now:BigIntStats|undefined;try{now=await lstat(target,{bigint:true});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   if(initial? !now||meta(now)!==initial.identity:!!now)throw fail('file_changed');syncGuard(bound.guard);await this.ancestorsCurrent(bound,directories);await this.safePath(r.isolated_root.path,relative(r.isolated_root.path,temp).split(sep).join('/'));if(meta(await lstat(temp,{bigint:true}))!==meta(staged!))throw fail('file_changed');await rename(temp,target);
   const after=await this.bytes(bound,operation.path);if(sha(after.bytes)!==sha(bytes))throw fail('write_uncertain');
   output={path:operation.path,version:operation.expected_version+1,sha256:sha(bytes),size:bytes.length,updated_at:new Date().toISOString()};
  }
  await this.inventory(bound,operation.operation==='files.write'?{path:operation.path,sha256:sha(bytes!),size:bytes!.length}:undefined);syncGuard(bound.guard);
  await this.ancestorsCurrent(bound,directories);
  const result:IsolatedFileResult=Object.freeze({...identity,source:'isolated',receipt_id:randomUUID(),...output});
  transaction(db,()=>{syncGuard(bound.guard);if(!db.prepare('SELECT 1 FROM wb_isolated_file_pending WHERE cycle_id=? AND call_key=?').get(identity.cycle_id,key))throw fail('pending_changed');db.prepare('INSERT INTO wb_isolated_file_results VALUES(?,?,?,?,?,?,?,?,?)').run(key,result.receipt_id,identity.cycle_id,identity.snapshot_id,'path'in operation?operation.path:null,operation.operation==='files.write'?Number(result.version):null,operation.operation==='files.write'?String(result.sha256):null,bytes??null,canonicalJson(result));const committed=this.options.commitReceipt(db,result) as unknown;if(committed&&typeof(committed as PromiseLike<unknown>).then==='function')throw fail('receipt_must_be_synchronous');db.prepare('DELETE FROM wb_isolated_file_pending WHERE cycle_id=? AND call_key=?').run(identity.cycle_id,key);});return result;
 }
 /** Internal immutable output source; caller must authorize original receipt scope. */
 version(receiptId:string){const row=this.options.db.prepare('SELECT bytes,response_json FROM wb_isolated_file_results WHERE receipt_id=? AND version IS NOT NULL').get(receiptId);if(!row)throw fail('version_missing');return Object.freeze({...JSON.parse(String(row.response_json)),content:Buffer.from(row.bytes as Uint8Array).toString('utf8')});}
}



