import {createHash,randomUUID} from 'node:crypto';
import {constants as fsConstants,lstatSync,realpathSync,openSync,readSync,closeSync,existsSync,renameSync,unlinkSync,rmdirSync,readdirSync} from 'node:fs';
import {lstat,realpath,open} from 'node:fs/promises';
import {join,dirname,isAbsolute,relative,sep} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {SnapshotCopyWorkspaceProvider,validateWorkspaceRecoveryRecord} from '../always-on/snapshot-provider.ts';
import {validateWorkspaceManifest,workspaceManifestHash,workspaceRelativePath,workspaceSelection,type SnapshotRecoveryRecord,type WorkspaceGuard,type WorkspaceManifest,type WorkspaceManifestEntry,type WorkspaceSnapshot} from '../always-on/workspace-provider.ts';
import {readWorkbenchSourceRevision} from '../always-on/workbench-source-revisions.ts';
import type {WorkbenchService} from './service.ts';
import {installWorkspaceCheckpointSchema} from './workspace-checkpoint-schema.ts';
import {reserveWorkspaceOperation,settleWorkspaceOperation,readWorkspaceOperation,type WorkspaceOperationSource} from './workspace-coordination.ts';
import {workspaceCheckpointCoordinationSchema} from './workspace-coordination-upgrade.ts';

type Row=Record<string,any>;
type RootIdentity=Readonly<{path:string;canonical:string;dev:string;ino:string}>;
type FileFact=Readonly<{path:string;version:number;sha256:string;size:number;blob_name:string;kind:'file'}>;
type AbsentFact=Readonly<{path:string;kind:'absent'}>;
type SourceFact=FileFact|AbsentFact;
type StoredBefore=Readonly<{path:string;kind:'absent'}>|Readonly<{path:string;kind:'file';version:number;sha256:string;size:number;blob_name:string}>;
type PublicFileState=Readonly<{path:string;kind:'file';version:number;sha256:string;size:number;executable:false}>;
type PublicAbsentState=Readonly<{path:string;kind:'absent'}>;
type PublicPathState=PublicFileState|PublicAbsentState;
type PinnedSource=Readonly<{owner_id:string;workspace_id:string;project_id:string;revision:number;root:RootIdentity|null;paths:readonly string[];facts:readonly SourceFact[];manifest:WorkspaceManifest}>;
type CheckpointOptions={storageRoot:string;limits?:Readonly<{max_entries?:number;max_total_bytes?:number;max_file_bytes?:number;max_depth?:number}>;leaseMs?:number;now?:()=>number;onPhase?:(phase:string,identity?:Readonly<Record<string,string>>)=>void;verifyBackupProof?:(proof:unknown,expected:Readonly<{checkpoint_id:string;manifest_sha256:string;snapshot_id:string}>)=>boolean|Promise<boolean>};
type Controls={guard?:WorkspaceGuard;signal?:AbortSignal};
type CreateLease=Readonly<{owner:string;generation:number}>;
type CheckpointReceipt=Readonly<{protocol:1;checkpoint_id:string;project_id:string;workspace_id:string;source_revision:number;snapshot_id:string;manifest_sha256:string;created_at:string;status:'ready';execution_authorized:false;restore_authorized:false}>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const COMMAND=/^[\x21-\x7e]{8,128}$/;
const failure=(code:string)=>Error(code);
const sha=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:canonicalJson(value)).digest('hex');
const fileIdentity=(stat:Awaited<ReturnType<typeof lstat>>)=>[stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeMs,stat.ctimeMs].map(String).join(':');
function exact(value:unknown,keys:readonly string[]):value is Row{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');}
function parseCanonical(value:string,code:string){try{const parsed=JSON.parse(value);if(canonicalJson(parsed)!==value)throw Error();return parsed;}catch{throw failure(code);}}
function validDigest(value:unknown):value is string{return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);}
function rootJson(root:RootIdentity|null){return canonicalJson(root);}
function publicState(value:SourceFact):PublicPathState{return value.kind==='absent'?Object.freeze({path:value.path,kind:'absent'}):Object.freeze({path:value.path,kind:'file',version:value.version,sha256:value.sha256,size:value.size,executable:false});}
function stateDigest(value:PublicPathState){return sha(value);}
function makeId(prefix:string){return `${prefix}-${randomUUID()}`;}
function boundedPath(path:string){return workspaceRelativePath(path);}
async function ensureSafe(path:string){let current=path;for(;;){const stat=await lstat(current);if(stat.isSymbolicLink())throw failure('workspace_checkpoint_path_unsafe');const parent=dirname(current);if(parent===current)break;current=parent;}}
async function rootIdentity(path:string|null):Promise<RootIdentity|null>{
 if(path===null)return null;if(!isAbsolute(path))throw failure('workspace_checkpoint_root_invalid');await ensureSafe(path);const stat=await lstat(path,{bigint:true});if(!stat.isDirectory())throw failure('workspace_checkpoint_root_invalid');
 return Object.freeze({path,canonical:await realpath(path),dev:String(stat.dev),ino:String(stat.ino)});
}
function syncRootIdentity(path:string|null):RootIdentity|null{
 if(path===null)return null;for(let current=path;;){const stat=lstatSync(current,{bigint:true});if(stat.isSymbolicLink())throw failure('workspace_checkpoint_root_changed');const parent=dirname(current);if(parent===current)break;current=parent;}
 const stat=lstatSync(path,{bigint:true});if(!stat.isDirectory())throw failure('workspace_checkpoint_root_changed');return{path,canonical:realpathSync(path),dev:String(stat.dev),ino:String(stat.ino)};
}
function rootsOverlap(left:string,right:string){
 const contains=(parent:string,child:string)=>{const rel=relative(parent,child);return rel===''||rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);};
 return contains(left,right)||contains(right,left);
}

async function *readBlob(root:RootIdentity,fact:FileFact,check:()=>Promise<void>):AsyncIterable<Uint8Array>{
 let handle:Awaited<ReturnType<typeof open>>|undefined;const absolute=join(root.path,'blobs',fact.blob_name);
 try{
  await check();await ensureSafe(absolute);const before=await lstat(absolute),canonical=await realpath(absolute);
  if(!before.isFile()||before.nlink!==1||before.size!==fact.size||canonical!==absolute)throw failure('workspace_checkpoint_blob_changed');
  handle=await open(absolute,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0));if(fileIdentity(await handle.stat())!==fileIdentity(before))throw failure('workspace_checkpoint_blob_changed');
  const digest=createHash('sha256');let bytes=0;
  for await(const chunk of handle.createReadStream({autoClose:false,highWaterMark:65536})) {await check();bytes+=chunk.length;if(bytes>fact.size)throw failure('workspace_checkpoint_blob_changed');digest.update(chunk);yield chunk;}
  if(bytes!==fact.size||digest.digest('hex')!==fact.sha256||fileIdentity(await handle.stat())!==fileIdentity(before)||fileIdentity(await lstat(absolute))!==fileIdentity(before)||await realpath(absolute)!==canonical)throw failure('workspace_checkpoint_blob_changed');
  await check();
 }finally{await handle?.close();}
}

/** Owner/project checkpoint records live beside the original Workbench version
 * ledger. File bytes are copied by SnapshotCopyWorkspaceProvider; this service
 * only binds its receipts and single-path restore journal to original SQLite. */
export class WorkspaceCheckpointService{
 private readonly db:DatabaseSync;private readonly workbench:WorkbenchService;private readonly storageRoot:string;private readonly limits:CheckpointOptions['limits'];private readonly leaseMs:number;private readonly now:()=>number;private readonly onPhase?:CheckpointOptions['onPhase'];private readonly verifyBackupProof?:CheckpointOptions['verifyBackupProof'];
 constructor(db:DatabaseSync,workbench:WorkbenchService,options:CheckpointOptions){
  if(!options||typeof options!=='object'||Object.keys(options).some(key=>!['storageRoot','limits','leaseMs','now','onPhase','verifyBackupProof'].includes(key))||typeof options.storageRoot!=='string'||!isAbsolute(options.storageRoot))throw failure('workspace_checkpoint_config_invalid');
  if(options.leaseMs!==undefined&&(!Number.isSafeInteger(options.leaseMs)||options.leaseMs<1000)||options.now!==undefined&&typeof options.now!=='function'||options.onPhase!==undefined&&(typeof options.onPhase!=='function'||options.onPhase.constructor.name==='AsyncFunction')||options.verifyBackupProof!==undefined&&typeof options.verifyBackupProof!=='function')throw failure('workspace_checkpoint_config_invalid');
  this.db=db;this.workbench=workbench;this.storageRoot=options.storageRoot;this.limits=options.limits;this.leaseMs=options.leaseMs??30_000;this.now=options.now??Date.now;if(options.onPhase)this.onPhase=options.onPhase;if(options.verifyBackupProof)this.verifyBackupProof=options.verifyBackupProof;installWorkspaceCheckpointSchema(db);
 }
 private notify(phase:string,identity?:Readonly<Record<string,string>>){this.onPhase?.(phase,identity);}
 private validateScope(owner:string,workspace:string,project:string){if(![owner,workspace,project].every(value=>typeof value==='string'&&ID.test(value)))throw failure('workspace_checkpoint_scope_invalid');this.workbench.projectSourceRoot(owner,workspace,project);}
 private guard(owner:string,workspace:string,project:string,controls:Controls):WorkspaceGuard{
  const guard=controls.guard??(()=>{});return async context=>{if(controls.signal?.aborted)throw failure('workspace_checkpoint_cancelled');this.validateScope(owner,workspace,project);await guard(context);if(controls.signal?.aborted)throw failure('workspace_checkpoint_cancelled');this.validateScope(owner,workspace,project);};
 }
 private signal(controls:Controls){const signal=controls.signal??new AbortController().signal;if(!(signal instanceof AbortSignal))throw failure('workspace_checkpoint_controls_required');return signal;}
 private sourceRevision(owner:string,workspace:string,project:string){try{return readWorkbenchSourceRevision(this.db,owner,workspace,project).revision;}catch{throw failure('workspace_checkpoint_source_revision_unavailable');}}
 private selectedRows(owner:string,workspace:string,project:string,paths:readonly string[]):readonly SourceFact[]{
  const ownsTransaction=!this.db.isTransaction;if(ownsTransaction)this.db.exec('BEGIN DEFERRED');
  try{
   const exactFile=this.db.prepare(`SELECT f.path,f.version,f.sha256,f.size,f.blob_name,v.version original_version,v.sha256 original_sha256,v.size original_size,v.blob_name original_blob_name
    FROM wb_files f LEFT JOIN wb_file_versions v ON v.owner_id=f.owner_id AND v.workspace_id=f.workspace_id AND v.project_id=f.project_id AND v.path=f.path AND v.version=f.version
    WHERE f.owner_id=? AND f.workspace_id=? AND f.project_id=? AND f.path=?`),existsPath=this.db.prepare('SELECT 1 FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=?'),descendant=this.db.prepare('SELECT 1 FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? AND substr(path,1,?)=? LIMIT 1');
   const facts:SourceFact[]=[];
   for(const path of paths){
    const parts=path.split('/');parts.pop();while(parts.length){const parent=parts.join('/');if(existsPath.get(owner,workspace,project,parent))throw failure('workspace_checkpoint_path_conflict');parts.pop();}
    const childPrefix=path+'/';if(descendant.get(owner,workspace,project,childPrefix.length,childPrefix))throw failure('workspace_checkpoint_path_is_directory');
    const row=exactFile.get(owner,workspace,project,path) as Row|undefined;if(!row){facts.push(Object.freeze({path,kind:'absent'}));continue;}
    if(row.version!==row.original_version||row.sha256!==row.original_sha256||row.size!==row.original_size||row.blob_name!==row.original_blob_name
      ||!Number.isSafeInteger(row.version)||Number(row.version)<1||!validDigest(row.sha256)||!Number.isSafeInteger(row.size)||Number(row.size)<0||typeof row.blob_name!=='string'||!/^[-a-zA-Z0-9_]+\.[a-zA-Z0-9]+$/.test(row.blob_name))throw failure('workspace_checkpoint_source_corrupt');
    facts.push(Object.freeze({path,kind:'file',version:Number(row.version),sha256:String(row.sha256),size:Number(row.size),blob_name:String(row.blob_name)}));
   }
   return Object.freeze(facts);
  }finally{if(ownsTransaction)this.db.exec('ROLLBACK');}
 }
 private manifest(paths:readonly string[],facts:readonly SourceFact[]):WorkspaceManifest{
  const entries=new Map<string,WorkspaceManifestEntry>(),byPath=new Map(facts.map(value=>[value.path,value]));
  for(const path of paths){const fact=byPath.get(path)!;if(fact.kind==='absent'){entries.set(path,{path,kind:'absent'});continue;}
   const parts=path.split('/');parts.pop();while(parts.length){const parent=parts.join('/');entries.set(parent,{path:parent,kind:'directory'});parts.pop();}
   entries.set(path,{path,kind:'file',sha256:fact.sha256,bytes:fact.size,executable:false});
  }
  return validateWorkspaceManifest({protocol:2,provider:'snapshot-copy',paths,entries:[...entries.values()]});
 }
 private async captureSource(owner:string,workspace:string,project:string,paths:readonly string[]):Promise<PinnedSource>{
  const revision=this.sourceRevision(owner,workspace,project),rootPath=this.workbench.projectSourceRoot(owner,workspace,project),root=await rootIdentity(rootPath),facts=this.selectedRows(owner,workspace,project,paths);
  if(facts.some(fact=>fact.kind==='file')&&!root)throw failure('workspace_checkpoint_root_missing');
  const afterRootPath=this.workbench.projectSourceRoot(owner,workspace,project),afterRoot=await rootIdentity(afterRootPath),afterRevision=this.sourceRevision(owner,workspace,project);
  if(rootJson(root)!==rootJson(afterRoot)||revision!==afterRevision)throw failure('workspace_checkpoint_source_changed');
  return Object.freeze({owner_id:owner,workspace_id:workspace,project_id:project,revision,root,paths,facts,manifest:this.manifest(paths,facts)});
 }
 private async assertSource(pin:PinnedSource){
  this.validateScope(pin.owner_id,pin.workspace_id,pin.project_id);const before=this.sourceRevision(pin.owner_id,pin.workspace_id,pin.project_id),rootPath=this.workbench.projectSourceRoot(pin.owner_id,pin.workspace_id,pin.project_id),root=await rootIdentity(rootPath),facts=this.selectedRows(pin.owner_id,pin.workspace_id,pin.project_id,pin.paths),afterRoot=await rootIdentity(this.workbench.projectSourceRoot(pin.owner_id,pin.workspace_id,pin.project_id)),after=this.sourceRevision(pin.owner_id,pin.workspace_id,pin.project_id);
  if(before!==pin.revision||after!==before||rootJson(root)!==rootJson(pin.root)||rootJson(afterRoot)!==rootJson(pin.root)||canonicalJson(facts)!==canonicalJson(pin.facts))throw failure('workspace_checkpoint_source_changed');
 }
 private assertIntentSource(intent:Row){
  const owner=String(intent.owner_id),workspace=String(intent.workspace_id),project=String(intent.project_id);
  this.validateScope(owner,workspace,project);
  if(this.sourceRevision(owner,workspace,project)!==intent.source_revision
   ||rootJson(syncRootIdentity(this.workbench.projectSourceRoot(owner,workspace,project)))!==intent.root_identity_json
   ||canonicalJson(this.selectedRows(owner,workspace,project,JSON.parse(String(intent.paths_json))))!==intent.source_facts_json)throw failure('workspace_checkpoint_source_changed');
 }
 private intent(checkpointId:string):Row{
  const row=this.db.prepare('SELECT * FROM wb_workspace_checkpoint_intents WHERE checkpoint_id=?').get(checkpointId) as Row|undefined;if(!row)throw failure('workspace_checkpoint_not_found');
  for(const [field,code] of [['paths_json','workspace_checkpoint_corrupt'],['source_facts_json','workspace_checkpoint_corrupt'],['manifest_json','workspace_checkpoint_corrupt'],['root_identity_json','workspace_checkpoint_corrupt']] as const)parseCanonical(String(row[field]),code);
  if(!validDigest(row.request_sha256)||!validDigest(row.manifest_sha256)||sha(String(row.manifest_json))!==row.manifest_sha256)throw failure('workspace_checkpoint_corrupt');
  try{validateWorkspaceManifest(JSON.parse(String(row.manifest_json)));}catch{throw failure('workspace_checkpoint_corrupt');}return row;
 }
 private recoveryStore(checkpointId?:string,lease?:CreateLease){
  return {
   commit:async(record:SnapshotRecoveryRecord)=>{
    if(!checkpointId)throw failure('workspace_checkpoint_store_scope_invalid');const json=canonicalJson(record),digest=sha(json);
    withImmediateTransaction(this.db,()=>{if(!lease)throw failure('workspace_checkpoint_lease_revoked');this.touchCreateLease(checkpointId,lease);const intent=this.intent(checkpointId);this.assertIntentSource(intent);if(record.receipt.manifest_sha256!==intent.manifest_sha256||canonicalJson(record.manifest)!==intent.manifest_json||record.manifest.protocol!==2)throw failure('workspace_checkpoint_artifact_conflict');
     const prior=this.db.prepare('SELECT record_json,record_sha256 FROM wb_workspace_checkpoint_artifacts WHERE snapshot_id=? OR checkpoint_id=?').get(record.snapshot_id,checkpointId) as Row|undefined;
     if(prior){if(prior.record_json!==json||prior.record_sha256!==digest)throw failure('workspace_checkpoint_artifact_conflict');return;}
     this.db.prepare('INSERT INTO wb_workspace_checkpoint_artifacts VALUES(?,?,?,?,?)').run(record.snapshot_id,checkpointId,json,digest,new Date(this.now()).toISOString());
    });this.notify('checkpoint_artifact_committed',{checkpoint_id:checkpointId,snapshot_id:record.snapshot_id});
   },
   read:async(snapshotId:string)=>this.readRecoveryRecord(snapshotId),
  };
 }
 private readRecoveryRecord(snapshotId:string):SnapshotRecoveryRecord|undefined{
  const row=this.db.prepare('SELECT record_json,record_sha256 FROM wb_workspace_checkpoint_artifacts WHERE snapshot_id=?').get(snapshotId) as Row|undefined;if(!row)return undefined;
  if(typeof row.record_json!=='string'||!validDigest(row.record_sha256)||sha(String(row.record_json))!==row.record_sha256)throw failure('workspace_checkpoint_artifact_corrupt');
  try{return validateWorkspaceRecoveryRecord(JSON.parse(row.record_json),snapshotId);}catch{throw failure('workspace_checkpoint_artifact_corrupt');}
 }
 private provider(checkpointId?:string,lease?:CreateLease){return new SnapshotCopyWorkspaceProvider({recoveryStore:this.recoveryStore(checkpointId,lease)});}
 private receipt(row:Row){const receipt=parseCanonical(String(row.receipt_json),'workspace_checkpoint_corrupt');if(!validDigest(row.receipt_sha256)||sha(String(row.receipt_json))!==row.receipt_sha256||receipt.protocol!==1||receipt.checkpoint_id!==row.checkpoint_id||receipt.snapshot_id!==row.snapshot_id||receipt.manifest_sha256!==row.manifest_sha256||receipt.execution_authorized!==false||receipt.restore_authorized!==false)throw failure('workspace_checkpoint_corrupt');return receipt as CheckpointReceipt;}
 private view(row:Row):Row{
  const manifest=validateWorkspaceManifest(JSON.parse(String(row.manifest_json))),receipt=this.receipt(row);
  const state=this.pruned(String(row.checkpoint_id))?'pruned':'ready';return Object.freeze({checkpoint_id:String(row.checkpoint_id),project_id:String(row.project_id),workspace_id:String(row.workspace_id),source_revision:Number(row.source_revision),paths:manifest.paths,manifest,manifest_sha256:String(row.manifest_sha256),receipt,state,created_at:String(row.created_at),execution_authorized:false,restore_authorized:false});
 }
 private pruned(checkpointId:string){const row=this.db.prepare('SELECT outcome_json,outcome_sha256 FROM wb_workspace_checkpoint_prune_outcomes WHERE checkpoint_id=?').get(checkpointId) as Row|undefined;if(!row)return false;if(!validDigest(row.outcome_sha256)||sha(String(row.outcome_json))!==row.outcome_sha256)throw failure('workspace_checkpoint_prune_corrupt');return true;}
 private readyRow(owner:string,workspace:string,project:string,checkpointId:string):Row{
  const row=this.db.prepare(`SELECT i.*,r.snapshot_id,r.receipt_json,r.receipt_sha256 FROM wb_workspace_checkpoint_intents i
    JOIN wb_workspace_checkpoint_ready r ON r.checkpoint_id=i.checkpoint_id
    WHERE i.checkpoint_id=? AND i.owner_id=? AND i.workspace_id=? AND i.project_id=?`).get(checkpointId,owner,workspace,project) as Row|undefined;
  if(!row)throw failure('workspace_checkpoint_not_found');this.receipt(row);return row;
 }
 private insertReady(checkpointId:string,snapshot:WorkspaceSnapshot,sourceRevision:number,lease:CreateLease){
  const intent=this.intent(checkpointId),receipt:CheckpointReceipt=Object.freeze({protocol:1,checkpoint_id:checkpointId,project_id:String(intent.project_id),workspace_id:String(intent.workspace_id),source_revision:sourceRevision,snapshot_id:snapshot.receipt.snapshot_id,manifest_sha256:snapshot.receipt.manifest_sha256,created_at:snapshot.receipt.created_at,status:'ready',execution_authorized:false,restore_authorized:false}),json=canonicalJson(receipt);
  withImmediateTransaction(this.db,()=>{this.touchCreateLease(checkpointId,lease);this.assertIntentSource(intent);const prior=this.db.prepare('SELECT receipt_json FROM wb_workspace_checkpoint_ready WHERE checkpoint_id=?').get(checkpointId);if(prior){if(prior.receipt_json!==json)throw failure('workspace_checkpoint_ready_conflict');return;}
   const artifact=this.db.prepare('SELECT snapshot_id,record_json,record_sha256 FROM wb_workspace_checkpoint_artifacts WHERE checkpoint_id=?').get(checkpointId) as Row|undefined;
   if(!artifact||artifact.snapshot_id!==snapshot.receipt.snapshot_id||!validDigest(artifact.record_sha256)||sha(String(artifact.record_json))!==artifact.record_sha256)throw failure('workspace_checkpoint_artifact_unconfirmed');
   this.db.prepare('INSERT INTO wb_workspace_checkpoint_ready VALUES(?,?,?,?,?)').run(checkpointId,snapshot.receipt.snapshot_id,json,sha(json),new Date(this.now()).toISOString());this.notify('checkpoint_ready_before_commit',{checkpoint_id:checkpointId,snapshot_id:snapshot.receipt.snapshot_id});
  });this.notify('checkpoint_ready_committed',{checkpoint_id:checkpointId,snapshot_id:snapshot.receipt.snapshot_id});
 }
 async create(owner:string,workspaceId:string,input:Record<string,unknown>&Controls){
  const allowed=['project_id','paths','command_key','guard','signal'];if(!input||typeof input!=='object'||Object.keys(input).some(key=>!allowed.includes(key)))throw failure('workspace_checkpoint_request_invalid');
  const project=String(input.project_id??''),key=input.command_key;if(typeof key!=='string'||!COMMAND.test(key))throw failure('workspace_checkpoint_command_invalid');const paths=workspaceSelection(input.paths);this.signal(input);this.validateScope(owner,workspaceId,project);
  const requestSha=sha({owner_id:owner,workspace_id:workspaceId,project_id:project,paths});
  const prior=this.db.prepare('SELECT checkpoint_id,request_sha256 FROM wb_workspace_checkpoint_intents WHERE owner_id=? AND workspace_id=? AND project_id=? AND command_key=?').get(owner,workspaceId,project,key) as Row|undefined;

  if(prior){if(prior.request_sha256!==requestSha)throw failure('idempotency_conflict');const checkpointId=String(prior.checkpoint_id),ready=this.db.prepare('SELECT 1 FROM wb_workspace_checkpoint_ready WHERE checkpoint_id=?').get(checkpointId);if(ready)return this.get(owner,workspaceId,project,checkpointId);return this.resumeCreate(owner,workspaceId,project,checkpointId,input);}
  const pin=await this.captureSource(owner,workspaceId,project,paths),storage=await rootIdentity(this.storageRoot);
  if(!storage)throw failure('workspace_checkpoint_storage_missing');if(pin.root&&rootsOverlap(pin.root.canonical,storage.canonical))throw failure('workspace_checkpoint_roots_overlap');
  let checkpointId=makeId('workspace-checkpoint');const intent={checkpoint_id:checkpointId,owner_id:owner,workspace_id:workspaceId,project_id:project,command_key:key,request_sha256:requestSha,source_revision:pin.revision,root_identity_json:rootJson(pin.root),paths_json:canonicalJson(paths),source_facts_json:canonicalJson(pin.facts),manifest_json:canonicalJson(pin.manifest),manifest_sha256:workspaceManifestHash(pin.manifest),created_at:new Date(this.now()).toISOString()};let reused=false;
  withImmediateTransaction(this.db,()=>{this.validateScope(owner,workspaceId,project);const raced=this.db.prepare('SELECT checkpoint_id,request_sha256 FROM wb_workspace_checkpoint_intents WHERE owner_id=? AND workspace_id=? AND project_id=? AND command_key=?').get(owner,workspaceId,project,key) as Row|undefined;
    if(raced){if(raced.request_sha256!==requestSha)throw failure('idempotency_conflict');checkpointId=String(raced.checkpoint_id);reused=true;return;}
    this.db.prepare(`INSERT INTO wb_workspace_checkpoint_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(intent.checkpoint_id,intent.owner_id,intent.workspace_id,intent.project_id,intent.command_key,intent.request_sha256,intent.source_revision,intent.root_identity_json,intent.paths_json,intent.source_facts_json,intent.manifest_json,intent.manifest_sha256,intent.created_at);});
  if(reused){const ready=this.db.prepare('SELECT 1 FROM wb_workspace_checkpoint_ready WHERE checkpoint_id=?').get(checkpointId);if(ready)return this.get(owner,workspaceId,project,checkpointId);return this.resumeCreate(owner,workspaceId,project,checkpointId,input);}
  this.notify('checkpoint_intent_committed',{checkpoint_id:checkpointId});
  return this.resumeCreate(owner,workspaceId,project,checkpointId,input);
 }
 private claimCreateLease(checkpointId:string):CreateLease{
  return withImmediateTransaction(this.db,()=>{
   const resource='workspace-checkpoint-create:'+checkpointId,now=this.now();
   const prior=this.db.prepare('SELECT owner,generation,expires_at FROM ga_worker_leases WHERE resource_id=?').get(resource);
   if(prior&&(!Number.isSafeInteger(Number(prior.generation))||Number(prior.generation)<1||!Number.isSafeInteger(Number(prior.expires_at))||Number(prior.expires_at)>now))throw failure('workspace_checkpoint_prepare_busy');
   const generation=Number(prior?.generation??0)+1,owner='workspace-checkpoint-create-'+randomUUID();
   if(!Number.isSafeInteger(generation))throw failure('workspace_checkpoint_prepare_busy');
   this.db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires_at=excluded.expires_at,updated_at=excluded.updated_at').run(resource,owner,generation,String(now+this.leaseMs),new Date(now).toISOString());
   return {owner,generation};
  });
 }
 private touchCreateLease(checkpointId:string,lease:CreateLease){
  const now=this.now();
  const result=this.db.prepare('UPDATE ga_worker_leases SET expires_at=?,updated_at=? WHERE resource_id=? AND owner=? AND generation=? AND CAST(expires_at AS INTEGER)>?').run(String(now+this.leaseMs),new Date(now).toISOString(),'workspace-checkpoint-create:'+checkpointId,lease.owner,lease.generation,now);
  if(result.changes!==1)throw failure('workspace_checkpoint_lease_revoked');
 }
 private releaseCreateLease(checkpointId:string,lease:CreateLease){
  // Keep the generation anchor so an expired worker cannot reacquire its epoch.
  this.db.prepare('UPDATE ga_worker_leases SET expires_at=?,updated_at=? WHERE resource_id=? AND owner=? AND generation=?').run('0',new Date(this.now()).toISOString(),'workspace-checkpoint-create:'+checkpointId,lease.owner,lease.generation);
 }

 private async resumeCreate(owner:string,workspaceId:string,project:string,checkpointId:string,controls:Controls){
  try{
   const result=await this.reconcileCreate(owner,workspaceId,project,checkpointId,controls);
   if(result.state==='unresolved')throw failure('workspace_checkpoint_prepare_unknown');
   return result;
  }catch(error){
   const artifact=this.db.prepare('SELECT 1 FROM wb_workspace_checkpoint_artifacts WHERE checkpoint_id=?').get(checkpointId);
   if(artifact)throw failure('workspace_checkpoint_prepare_unknown');
   throw failure(error instanceof Error&&/^workspace_[a-z_]+$/.test(error.message)?error.message:'workspace_checkpoint_prepare_failed');
  }
 }

 async reconcileCreate(owner:string,workspaceId:string,project:string,checkpointId:string,controls:Controls={}){
  const signal=this.signal(controls);this.validateScope(owner,workspaceId,project);const intent=this.intent(checkpointId);if(intent.owner_id!==owner||intent.workspace_id!==workspaceId||intent.project_id!==project)throw failure('workspace_checkpoint_not_found');
  const ready=this.db.prepare('SELECT 1 FROM wb_workspace_checkpoint_ready WHERE checkpoint_id=?').get(checkpointId);if(ready)return this.get(owner,workspaceId,project,checkpointId);
  const paths=JSON.parse(String(intent.paths_json)) as string[],facts=JSON.parse(String(intent.source_facts_json)) as SourceFact[],root=JSON.parse(String(intent.root_identity_json)) as RootIdentity|null,pin:PinnedSource={owner_id:owner,workspace_id:workspaceId,project_id:project,revision:Number(intent.source_revision),root,paths,facts,manifest:validateWorkspaceManifest(JSON.parse(String(intent.manifest_json)))};
  const lease=this.claimCreateLease(checkpointId);
  const ownerGuard=this.guard(owner,workspaceId,project,controls);
  const guard:WorkspaceGuard=async context=>{await ownerGuard(context);this.touchCreateLease(checkpointId,lease);};
  try{
   if(signal.aborted)throw failure('workspace_checkpoint_cancelled');
   try{await this.assertSource(pin);}catch{return Object.freeze({checkpoint_id:checkpointId,state:'unresolved',reason:'source_changed',execution_authorized:false,restore_authorized:false});}
   const artifact=this.db.prepare('SELECT snapshot_id FROM wb_workspace_checkpoint_artifacts WHERE checkpoint_id=?').get(checkpointId) as Row|undefined;
   let snapshot:WorkspaceSnapshot;
   if(artifact){
    snapshot=await this.provider().recover({snapshot_id:String(artifact.snapshot_id),storageRoot:this.storageRoot,guard,signal});
   }else{
    const storage=await rootIdentity(this.storageRoot);if(!storage)throw failure('workspace_checkpoint_storage_missing');if(pin.root&&rootsOverlap(pin.root.canonical,storage.canonical))throw failure('workspace_checkpoint_roots_overlap');
    const byPath=new Map(facts.map(fact=>[fact.path,fact]));
    snapshot=await this.provider(checkpointId,lease).materialize({storageRoot:this.storageRoot,manifest:pin.manifest,selection:paths.map(path=>({path,kind:byPath.get(path)!.kind})),...(this.limits?{limits:this.limits}:{}),guard,signal,
     assertCurrent:()=>this.assertSource(pin),read:path=>{const fact=byPath.get(path);if(!fact||fact.kind!=='file'||!pin.root)throw failure('workspace_checkpoint_source_changed');return readBlob(pin.root,fact,()=>this.assertSource(pin));}});
   }
   await this.assertSource(pin);if(signal.aborted)throw failure('workspace_checkpoint_cancelled');
   this.insertReady(checkpointId,snapshot,pin.revision,lease);return this.get(owner,workspaceId,project,checkpointId);
  }finally{this.releaseCreateLease(checkpointId,lease);}
 }

 async get(owner:string,workspaceId:string,project:string,checkpointId:string){
  this.validateScope(owner,workspaceId,project);const row=this.readyRow(owner,workspaceId,project,checkpointId);if(this.pruned(checkpointId))return this.view(row);const provider=this.provider(),snapshot=await provider.recover({snapshot_id:String(row.snapshot_id),storageRoot:this.storageRoot,guard:this.guard(owner,workspaceId,project,{}),signal:new AbortController().signal});
  if(workspaceManifestHash(snapshot.manifest)!==row.manifest_sha256)throw failure('workspace_checkpoint_artifact_corrupt');return this.view(row);
 }
 list(owner:string,workspaceId:string,project:string,options:Record<string,unknown>={}){
  if(Object.keys(options).some(key=>!['limit','before_checkpoint_id'].includes(key)))throw failure('workspace_checkpoint_list_invalid');this.validateScope(owner,workspaceId,project);
  const limit=options.limit===undefined?25:options.limit,before=options.before_checkpoint_id;if(!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>100||before!==undefined&&(typeof before!=='string'||!ID.test(before)))throw failure('workspace_checkpoint_list_invalid');
  let cursor:Row|undefined;
  if(before!==undefined){cursor=this.db.prepare('SELECT created_at,checkpoint_id FROM wb_workspace_checkpoint_intents WHERE checkpoint_id=? AND owner_id=? AND workspace_id=? AND project_id=?').get(before,owner,workspaceId,project) as Row|undefined;if(!cursor)throw failure('workspace_checkpoint_list_invalid');}
  const rows=this.db.prepare(`SELECT i.*,r.snapshot_id,r.receipt_json,r.receipt_sha256 FROM wb_workspace_checkpoint_intents i JOIN wb_workspace_checkpoint_ready r USING(checkpoint_id)
   WHERE i.owner_id=? AND i.workspace_id=? AND i.project_id=? ${cursor?'AND(i.created_at<? OR(i.created_at=? AND i.checkpoint_id<?))':''} ORDER BY i.created_at DESC,i.checkpoint_id DESC LIMIT ?`).all(owner,workspaceId,project,...(cursor?[cursor.created_at,cursor.created_at,cursor.checkpoint_id,Number(limit)+1]:[Number(limit)+1])) as Row[];
  const hasMore=rows.length>Number(limit),page=rows.slice(0,Number(limit)).map(row=>this.view(row));return Object.freeze({items:Object.freeze(page),next_before_checkpoint_id:hasMore?page.at(-1)?.checkpoint_id??null:null,execution_authorized:false,restore_authorized:false});
 }
 private checkpointTarget(row:Row,path:string):{snapshotId:string;target:SourceFact}{
  const paths=parseCanonical(String(row.paths_json),'workspace_checkpoint_corrupt') as string[],facts=parseCanonical(String(row.source_facts_json),'workspace_checkpoint_corrupt');
  if(!paths.includes(path))throw failure('workspace_checkpoint_path_not_selected');const target=(facts as SourceFact[]).find(value=>value.path===path);if(!target)throw failure('workspace_checkpoint_corrupt');
  const manifest=validateWorkspaceManifest(JSON.parse(String(row.manifest_json))),entry=manifest.entries.find(value=>value.path===path);
  if(target.kind==='absent'&&entry?.kind!=='absent'||target.kind==='file'&&(entry?.kind!=='file'||entry.sha256!==target.sha256||entry.bytes!==target.size||entry.executable!==false))throw failure('workspace_checkpoint_corrupt');
  return{snapshotId:String(row.snapshot_id),target};
 }
 private currentRevisionInTransaction(owner:string,workspace:string,project:string){const row=this.db.prepare('SELECT revision FROM wb_project_source_revisions WHERE owner_id=? AND workspace_id=? AND project_id=?').get(owner,workspace,project),revision=row?.revision??0;if(!Number.isSafeInteger(revision)||Number(revision)<0)throw failure('workspace_checkpoint_source_revision_unavailable');return Number(revision);}
 private currentRoot(owner:string,workspace:string,project:string){return syncRootIdentity(this.workbench.projectSourceRoot(owner,workspace,project));}
 private storedBefore(fact:SourceFact):StoredBefore{return fact.kind==='absent'?Object.freeze({path:fact.path,kind:'absent'}):Object.freeze({path:fact.path,kind:'file',version:fact.version,sha256:fact.sha256,size:fact.size,blob_name:fact.blob_name});}
 private publicStored(value:StoredBefore):PublicPathState{return value.kind==='absent'?Object.freeze({path:value.path,kind:'absent'}):Object.freeze({path:value.path,kind:'file',version:value.version,sha256:value.sha256,size:value.size,executable:false});}
 private reviewRow(owner:string,workspace:string,project:string,reviewId:string):Row{
  const row=this.db.prepare('SELECT * FROM wb_workspace_checkpoint_restore_reviews WHERE review_id=? AND owner_id=? AND workspace_id=? AND project_id=?').get(reviewId,owner,workspace,project) as Row|undefined;
  if(!row)throw failure('workspace_checkpoint_review_not_found');const before=parseCanonical(String(row.before_state_json),'workspace_checkpoint_review_corrupt'),target=parseCanonical(String(row.target_state_json),'workspace_checkpoint_review_corrupt'),root=parseCanonical(String(row.root_identity_json),'workspace_checkpoint_review_corrupt');
  const expected={review_id:String(row.review_id),owner_id:String(row.owner_id),workspace_id:String(row.workspace_id),project_id:String(row.project_id),checkpoint_id:String(row.checkpoint_id),path:String(row.path),expected_revision:Number(row.expected_revision),root,before,target,before_sha256:String(row.before_state_sha256),target_sha256:String(row.target_state_sha256),created_at:String(row.created_at)};
  if(!validDigest(row.review_sha256)||sha(expected)!==row.review_sha256||sha(before)!==row.before_state_sha256||sha(target)!==row.target_state_sha256)throw failure('workspace_checkpoint_review_corrupt');return{...row,before,target,root};
 }
 private reviewReceipt(owner:string,workspace:string,project:string,reviewId:string){
  const row=this.reviewRow(owner,workspace,project,reviewId);
  return Object.freeze({review_id:String(row.review_id),checkpoint_id:String(row.checkpoint_id),project_id:String(row.project_id),workspace_id:String(row.workspace_id),path:String(row.path),expected_revision:Number(row.expected_revision),before:this.publicStored(row.before),target:Object.freeze(row.target),review_sha256:String(row.review_sha256),created_at:String(row.created_at),execution_authorized:false,restore_authorized:false});
 }
 private priorReview(owner:string,workspace:string,project:string,key:string,requestSha:string,checkpointId:string,path:string){
  const prior=this.db.prepare('SELECT request_sha256,review_id FROM wb_workspace_checkpoint_restore_review_commands WHERE owner_id=? AND workspace_id=? AND project_id=? AND command_key=?').get(owner,workspace,project,key) as Row|undefined;
  if(!prior)return undefined;if(!validDigest(prior.request_sha256))throw failure('workspace_checkpoint_review_command_corrupt');if(prior.request_sha256!==requestSha)throw failure('idempotency_conflict');
  const receipt=this.reviewReceipt(owner,workspace,project,String(prior.review_id));if(receipt.checkpoint_id!==checkpointId||receipt.path!==path)throw failure('workspace_checkpoint_review_command_corrupt');return receipt;
 }
 async reviewRestore(owner:string,workspaceId:string,input:Record<string,unknown>){
  if(!exact(input,['project_id','checkpoint_id','path','command_key']))throw failure('workspace_checkpoint_review_invalid');const project=String(input.project_id??''),checkpointId=String(input.checkpoint_id??''),path=boundedPath(String(input.path??'')),key=input.command_key;if(typeof key!=='string'||!COMMAND.test(key))throw failure('workspace_checkpoint_command_invalid');this.validateScope(owner,workspaceId,project);
  const requestSha=sha({owner_id:owner,workspace_id:workspaceId,project_id:project,checkpoint_id:checkpointId,path}),prior=this.priorReview(owner,workspaceId,project,key,requestSha,checkpointId,path);if(prior)return prior;
  const checkpoint=this.readyRow(owner,workspaceId,project,checkpointId);if(this.pruned(checkpointId))throw failure('workspace_checkpoint_pruned');const {snapshotId,target}=this.checkpointTarget(checkpoint,path),currentRoot=this.currentRoot(owner,workspaceId,project),savedRoot=parseCanonical(String(checkpoint.root_identity_json),'workspace_checkpoint_corrupt');
  if(rootJson(currentRoot)!==rootJson(savedRoot))throw failure('workspace_checkpoint_root_changed');const revision=this.sourceRevision(owner,workspaceId,project),facts=this.selectedRows(owner,workspaceId,project,[path]),before=this.storedBefore(facts[0]!);
  const provider=this.provider(),snapshot=await provider.recover({snapshot_id:snapshotId,storageRoot:this.storageRoot,guard:this.guard(owner,workspaceId,project,{}),signal:new AbortController().signal});await provider.inspect({snapshot,guard:this.guard(owner,workspaceId,project,{}),signal:new AbortController().signal});
  const targetState=publicState(target),beforeState=this.publicStored(before),reviewId=makeId('workspace-checkpoint-review'),createdAt=new Date(this.now()).toISOString(),root=currentRoot,beforeJson=canonicalJson(before),targetJson=canonicalJson(targetState),rootIdentityJson=rootJson(root);
  const reviewCore={review_id:reviewId,owner_id:owner,workspace_id:workspaceId,project_id:project,checkpoint_id:checkpointId,path,expected_revision:revision,root,before,target:targetState,before_sha256:sha(before),target_sha256:sha(targetState),created_at:createdAt},reviewSha=sha(reviewCore);
  let racedReviewId:string|undefined;
  withImmediateTransaction(this.db,()=>{
   const raced=this.priorReview(owner,workspaceId,project,key,requestSha,checkpointId,path);if(raced){racedReviewId=raced.review_id;return;}
   if(this.currentRevisionInTransaction(owner,workspaceId,project)!==revision||rootJson(this.currentRoot(owner,workspaceId,project))!==rootJson(root)||canonicalJson(this.selectedRows(owner,workspaceId,project,[path])[0])!==canonicalJson(facts[0]))throw failure('workspace_checkpoint_review_changed');
   this.db.prepare('INSERT INTO wb_workspace_checkpoint_restore_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(reviewId,owner,workspaceId,project,checkpointId,path,revision,rootIdentityJson,beforeJson,sha(before),targetJson,sha(targetState),reviewSha,createdAt);
   this.db.prepare('INSERT INTO wb_workspace_checkpoint_restore_review_commands VALUES(?,?,?,?,?,?)').run(owner,workspaceId,project,key,requestSha,reviewId);
   this.addReferenceInTransaction(owner,workspaceId,project,checkpointId,'review',reviewId,path,createdAt);
  });
  if(racedReviewId)return this.reviewReceipt(owner,workspaceId,project,racedReviewId);
  return this.reviewReceipt(owner,workspaceId,project,reviewId);
 }
 private addReferenceInTransaction(owner:string,workspace:string,project:string,checkpoint:string,kind:'review'|'upload'|'unknown'|'rollback',key:string,path:string|null,createdAt:string){
  if(!this.db.isTransaction)throw failure('workspace_checkpoint_transaction_required');if(this.db.prepare('SELECT 1 FROM wb_workspace_checkpoint_prunes WHERE checkpoint_id=?').get(checkpoint))throw failure('workspace_checkpoint_pruned');
  if(this.db.prepare('SELECT 1 FROM wb_workspace_checkpoint_references WHERE checkpoint_id=? AND reference_kind=? AND reference_key=?').get(checkpoint,kind,key))return;
  this.db.prepare('INSERT INTO wb_workspace_checkpoint_references VALUES(?,?,?,?,?,?,?,?,?)').run(makeId('workspace-checkpoint-ref'),checkpoint,owner,workspace,project,kind,key,path,createdAt);
 }
 retainReference(owner:string,workspaceId:string,project:string,checkpointId:string,kind:'upload'|'unknown'|'rollback',referenceKey:string,path?:string){
  if(!['upload','unknown','rollback'].includes(kind)||typeof referenceKey!=='string'||!ID.test(referenceKey))throw failure('workspace_checkpoint_reference_invalid');const ready=this.readyRow(owner,workspaceId,project,checkpointId),selected=path===undefined?null:boundedPath(path);if(selected)this.checkpointTarget(ready,selected);
  withImmediateTransaction(this.db,()=>this.addReferenceInTransaction(owner,workspaceId,project,checkpointId,kind,referenceKey,selected,new Date(this.now()).toISOString()));return Object.freeze({checkpoint_id:checkpointId,reference_kind:kind,reference_key:referenceKey,execution_authorized:false});
 }
 private sourceForJournal(row:Row):WorkspaceOperationSource{return{owner_id:String(row.owner_id),project_id:String(row.project_id),operation_kind:'workspace_checkpoint_restore',operation_id:String(row.operation_id),binding_sha256:String(row.binding_sha256)};}
 private journal(operationId:string):Row{
  const row=this.db.prepare('SELECT * FROM wb_workspace_checkpoint_path_journal WHERE operation_id=?').get(operationId) as Row|undefined;if(!row)throw failure('workspace_checkpoint_restore_not_found');
  const before=parseCanonical(String(row.before_state_json),'workspace_checkpoint_journal_corrupt'),target=parseCanonical(String(row.target_state_json),'workspace_checkpoint_journal_corrupt');
  const core={operation_id:String(row.operation_id),owner_id:String(row.owner_id),workspace_id:String(row.workspace_id),project_id:String(row.project_id),checkpoint_id:String(row.checkpoint_id),snapshot_id:String(row.snapshot_id),path:String(row.path),review_id:String(row.review_id),review_sha256:String(row.review_sha256),reservation_id:String(row.reservation_id),binding_sha256:String(row.binding_sha256),expected_revision:Number(row.expected_revision),root_identity_json:String(row.root_identity_json),before_state_json:String(row.before_state_json),before_state_sha256:String(row.before_state_sha256),target_state_json:String(row.target_state_json),target_state_sha256:String(row.target_state_sha256),target_version:row.target_version===null?null:Number(row.target_version),blob_name:row.blob_name===null?null:String(row.blob_name),lease_owner:String(row.lease_owner),lease_generation:Number(row.lease_generation),command_key:String(row.command_key),request_sha256:String(row.request_sha256),created_at:String(row.created_at)};
  if(!['review_sha256','binding_sha256','before_state_sha256','target_state_sha256','request_sha256'].every(key=>validDigest(core[key as keyof typeof core]))||!validDigest(row.journal_sha256)||sha(core)!==row.journal_sha256||sha(before)!==core.before_state_sha256||sha(target)!==core.target_state_sha256)throw failure('workspace_checkpoint_journal_corrupt');return{...row,before,target};
 }
 private leaseResource(operationId:string){return'workspace-checkpoint-restore:'+operationId;}
 private touchLease(operationId:string,owner:string,generation:number){
  const now=this.now(),current=this.db.prepare('SELECT owner,generation,expires_at FROM ga_worker_leases WHERE resource_id=?').get(this.leaseResource(operationId));
  if(!current||current.owner!==owner||current.generation!==generation||!Number.isSafeInteger(Number(current.expires_at))||Number(current.expires_at)<=now)throw failure('workspace_checkpoint_lease_revoked');
  this.db.prepare('UPDATE ga_worker_leases SET expires_at=?,updated_at=? WHERE resource_id=? AND owner=? AND generation=? AND CAST(expires_at AS INTEGER)>?').run(String(now+this.leaseMs),new Date(now).toISOString(),this.leaseResource(operationId),owner,generation,now);
  const after=this.db.prepare('SELECT owner,generation,expires_at FROM ga_worker_leases WHERE resource_id=?').get(this.leaseResource(operationId));if(!after||after.owner!==owner||after.generation!==generation||Number(after.expires_at)<=now)throw failure('workspace_checkpoint_lease_revoked');
 }
 private claimLease(operationId:string):{owner:string;generation:number}{
  const resource=this.leaseResource(operationId),prior=this.db.prepare('SELECT owner,generation,expires_at FROM ga_worker_leases WHERE resource_id=?').get(resource),now=this.now();
  if(prior&&(!Number.isSafeInteger(Number(prior.generation))||Number(prior.generation)<1||!Number.isSafeInteger(Number(prior.expires_at))||Number(prior.expires_at)>now))throw failure('workspace_checkpoint_restore_busy');
  const max=this.db.prepare('SELECT COALESCE(max(generation),0) generation FROM wb_workspace_checkpoint_restore_lease_generations WHERE operation_id=?').get(operationId),generation=Number(max?.generation??0)+1,owner='workspace-checkpoint-'+randomUUID();if(!Number.isSafeInteger(generation))throw failure('workspace_checkpoint_restore_busy');
  this.db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires_at=excluded.expires_at,updated_at=excluded.updated_at').run(resource,owner,generation,String(now+this.leaseMs),new Date(now).toISOString());return{owner,generation};
 }
 private hasOutcome(operationId:string){const row=this.db.prepare('SELECT outcome_json,outcome_sha256 FROM wb_workspace_checkpoint_restore_outcomes WHERE operation_id=?').get(operationId) as Row|undefined;if(!row)return undefined;
  if(!validDigest(row.outcome_sha256)||sha(String(row.outcome_json))!==row.outcome_sha256)throw failure('workspace_checkpoint_outcome_corrupt');return parseCanonical(String(row.outcome_json),'workspace_checkpoint_outcome_corrupt') as Row;
 }
 private retainUnknown(row:Row){withImmediateTransaction(this.db,()=>this.addReferenceInTransaction(String(row.owner_id),String(row.workspace_id),String(row.project_id),String(row.checkpoint_id),'unknown',String(row.operation_id),String(row.path),new Date(this.now()).toISOString()));}
 private syncFileHash(root:RootIdentity,filePath:string,expectedBytes:number,expectedHash:string){
  const before=lstatSync(filePath);if(before.isSymbolicLink()||!before.isFile()||before.nlink!==1||before.size!==expectedBytes||realpathSync(filePath)!==filePath)throw failure('workspace_checkpoint_blob_changed');
  const fd=openSync(filePath,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0)),digest=createHash('sha256'),buffer=Buffer.allocUnsafe(65536);let bytes=0;
  try{for(;;){const read=readSync(fd,buffer,0,buffer.length,null);if(!read)break;bytes+=read;if(bytes>expectedBytes)throw failure('workspace_checkpoint_blob_changed');digest.update(buffer.subarray(0,read));}
   const after=lstatSync(filePath);if(bytes!==expectedBytes||digest.digest('hex')!==expectedHash||String(before.dev)!==String(after.dev)||String(before.ino)!==String(after.ino)||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||realpathSync(filePath)!==filePath)throw failure('workspace_checkpoint_blob_changed');
  }finally{closeSync(fd);}this.assertRootSync(root);return{dev:String(before.dev),ino:String(before.ino),size:before.size,mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs};
 }
 private assertRootSync(expected:RootIdentity){if(rootJson(syncRootIdentity(expected.path))!==rootJson(expected))throw failure('workspace_checkpoint_root_changed');}
 private async stageRestoreBlob(row:Row,controls:Controls,lease:{owner:string;generation:number}){
  const target=row.target as PublicPathState;if(target.kind!=='file')return;const root=JSON.parse(String(row.root_identity_json)) as RootIdentity;if(!root)throw failure('workspace_checkpoint_root_missing');this.assertRootSync(root);
  const blobName=String(row.blob_name);if(!/^[a-f0-9-]+\.bin$/.test(blobName))throw failure('workspace_checkpoint_journal_corrupt');const directory=join(root.path,'blobs'),pending=join(directory,blobName+'.pending'),final=join(directory,blobName),dirStat=lstatSync(directory);
  if(dirStat.isSymbolicLink()||!dirStat.isDirectory())throw failure('workspace_checkpoint_root_changed');const ready=this.readyRow(String(row.owner_id),String(row.workspace_id),String(row.project_id),String(row.checkpoint_id)),provider=this.provider(),snapshot=await provider.recover({snapshot_id:String(row.snapshot_id),storageRoot:this.storageRoot,guard:this.guard(String(row.owner_id),String(row.workspace_id),String(row.project_id),controls),signal:this.signal(controls)});
  if(existsSync(final)){this.syncFileHash(root,final,Number(target.size),String(target.sha256));return;}if(existsSync(pending))throw failure('workspace_checkpoint_blob_unknown');
  const handle=await open(pending,fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|(fsConstants.O_NOFOLLOW??0),0o600),digest=createHash('sha256');let bytes=0;
  try{for await(const chunk of provider.read(snapshot,String(row.path),async context=>{await this.guard(String(row.owner_id),String(row.workspace_id),String(row.project_id),controls)(context);this.touchLease(String(row.operation_id),lease.owner,lease.generation);},this.signal(controls))){this.touchLease(String(row.operation_id),lease.owner,lease.generation);bytes+=chunk.byteLength;if(bytes>Number(target.size))throw failure('workspace_checkpoint_blob_changed');digest.update(chunk);let offset=0;while(offset<chunk.byteLength){const result=await handle.write(chunk,offset,Math.min(65536,chunk.byteLength-offset));if(!result.bytesWritten)throw failure('workspace_checkpoint_blob_write_failed');offset+=result.bytesWritten;}}
   await handle.sync();if(bytes!==Number(target.size)||digest.digest('hex')!==target.sha256)throw failure('workspace_checkpoint_blob_changed');
  }finally{await handle.close();}
  this.touchLease(String(row.operation_id),lease.owner,lease.generation);this.assertRootSync(root);if(existsSync(final))throw failure('workspace_checkpoint_blob_conflict');renameSync(pending,final);this.syncFileHash(root,final,Number(target.size),String(target.sha256));this.notify('restore_blob_renamed',{operation_id:String(row.operation_id)});
 }
 private finalizeRestore(row:Row,lease:{owner:string;generation:number}){
  const operationId=String(row.operation_id),owner=String(row.owner_id),workspace=String(row.workspace_id),project=String(row.project_id),path=String(row.path),checkpoint=String(row.checkpoint_id),target=row.target as PublicPathState,root=JSON.parse(String(row.root_identity_json)) as RootIdentity|null,source=this.sourceForJournal(row);
  const outcome=withImmediateTransaction(this.db,()=>{
   this.touchLease(operationId,lease.owner,lease.generation);this.validateScope(owner,workspace,project);
   if(rootJson(this.currentRoot(owner,workspace,project))!==rootJson(root)||this.currentRevisionInTransaction(owner,workspace,project)!==Number(row.expected_revision))throw failure('workspace_checkpoint_current_changed');
   const current=this.selectedRows(owner,workspace,project,[path])[0]!,stored=this.storedBefore(current);if(canonicalJson(stored)!==String(row.before_state_json))throw failure('workspace_checkpoint_current_changed');
   if(target.kind==='file'){
    const fact=JSON.parse(String(row.target_state_json)) as PublicFileState;if(!root||typeof row.blob_name!=='string')throw failure('workspace_checkpoint_root_missing');this.syncFileHash(root,join(root.path,'blobs',String(row.blob_name)),target.size,target.sha256);
    const version=Number(row.target_version),now=new Date(this.now()).toISOString();if(!Number.isSafeInteger(version)||version<1)throw failure('workspace_checkpoint_journal_corrupt');
    this.db.prepare('INSERT INTO wb_file_versions VALUES(?,?,?,?,?,?,?,?,?)').run(owner,workspace,project,path,version,fact.sha256,fact.size,String(row.blob_name),now);
    this.db.prepare(`INSERT INTO wb_files VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,workspace_id,project_id,path) DO UPDATE SET version=excluded.version,sha256=excluded.sha256,size=excluded.size,blob_name=excluded.blob_name,updated_at=excluded.updated_at`).run(owner,workspace,project,path,version,fact.sha256,fact.size,String(row.blob_name),now);
   }else if(current.kind==='file'){
    const removed=this.db.prepare('DELETE FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=? AND version=? AND sha256=? AND size=? AND blob_name=?').run(owner,workspace,project,path,current.version,current.sha256,current.size,current.blob_name);if(removed.changes!==1)throw failure('workspace_checkpoint_current_changed');
   }
   const afterRevision=this.currentRevisionInTransaction(owner,workspace,project),receipt=Object.freeze({protocol:1,operation_id:operationId,checkpoint_id:checkpoint,path,outcome:'applied',target_state_sha256:String(row.target_state_sha256),result_version:target.kind==='file'?Number(row.target_version):null,source_revision:afterRevision,execution_authorized:false,restore_authorized:false}),json=canonicalJson(receipt);
   this.db.prepare('INSERT INTO wb_workspace_checkpoint_restore_outcomes VALUES(?,?,?,?)').run(operationId,json,sha(json),new Date(this.now()).toISOString());
   const released=this.db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=? AND owner=? AND generation=?').run(this.leaseResource(operationId),lease.owner,lease.generation);if(released.changes!==1)throw failure('workspace_checkpoint_lease_revoked');settleWorkspaceOperation(this.db,source);
   this.notify('restore_before_commit',{operation_id:operationId});return receipt;
  });this.notify('restore_committed',{operation_id:operationId});return outcome;
 }
 private async executeRestore(row:Row,controls:Controls,lease:{owner:string;generation:number}){
  try{
   this.touchLease(String(row.operation_id),lease.owner,lease.generation);this.validateScope(String(row.owner_id),String(row.workspace_id),String(row.project_id));
   const root=JSON.parse(String(row.root_identity_json)) as RootIdentity|null;
   if(rootJson(this.currentRoot(String(row.owner_id),String(row.workspace_id),String(row.project_id)))!==rootJson(root)||this.sourceRevision(String(row.owner_id),String(row.workspace_id),String(row.project_id))!==Number(row.expected_revision))throw failure('workspace_checkpoint_current_changed');
   const current=this.selectedRows(String(row.owner_id),String(row.workspace_id),String(row.project_id),[String(row.path)])[0]!;if(canonicalJson(this.storedBefore(current))!==String(row.before_state_json))throw failure('workspace_checkpoint_current_changed');
   await this.stageRestoreBlob(row,controls,lease);this.touchLease(String(row.operation_id),lease.owner,lease.generation);this.notify('restore_before_transaction',{operation_id:String(row.operation_id)});return this.finalizeRestore(row,lease);
  }catch(error){try{this.retainUnknown(row);}catch{}throw error;}
 }
 async restore(owner:string,workspaceId:string,input:Record<string,unknown>&Controls){
  // The outer writer transaction serializes durable no-effect rejection with
  // journal creation. The inner savepoint removes any failed preparation.
  const prepared=withImmediateTransaction(this.db,()=>{
   try{return {operation:withImmediateTransaction(this.db,()=>this.prepareRestore(owner,workspaceId,input))};}
   catch(error){
    if(!(error instanceof Error)||error.message!=='workspace_checkpoint_review_changed')throw error;
    const project=String(input.project_id),key=String(input.command_key),request={owner_id:owner,workspace_id:workspaceId,project_id:project,checkpoint_id:String(input.checkpoint_id),path:boundedPath(String(input.path)),review_id:String(input.review_id),review_sha256:String(input.review_sha256)},digest=sha(request);
    if(this.db.prepare('SELECT 1 FROM wb_workspace_checkpoint_path_journal WHERE owner_id=? AND workspace_id=? AND project_id=? AND command_key=?').get(owner,workspaceId,project,key))throw error;
    const prior=this.db.prepare('SELECT request_sha256 FROM wb_workspace_checkpoint_restore_rejections WHERE owner_id=? AND workspace_id=? AND project_id=? AND command_key=?').get(owner,workspaceId,project,key) as Row|undefined;
    if(prior&&prior.request_sha256!==digest)throw failure('idempotency_conflict');
    if(!prior)this.db.prepare('INSERT INTO wb_workspace_checkpoint_restore_rejections VALUES(?,?,?,?,?,?,?,?,?)').run(owner,workspaceId,project,key,request.checkpoint_id,canonicalJson(request),digest,error.message,new Date(this.now()).toISOString());
    return {error};
   }
  });
  if('error' in prepared)throw prepared.error;
  return prepared.operation();
 }
 private prepareRestore(owner:string,workspaceId:string,input:Record<string,unknown>&Controls){
  const allowed=['project_id','checkpoint_id','path','review_id','review_sha256','command_key','guard','signal'];if(!input||typeof input!=='object'||Object.keys(input).some(key=>!allowed.includes(key)))throw failure('workspace_checkpoint_restore_invalid');
  if(workspaceCheckpointCoordinationSchema(this.db)!=='checkpoint')throw failure('workspace_checkpoint_upgrade_required');const project=String(input.project_id??''),checkpointId=String(input.checkpoint_id??''),path=boundedPath(String(input.path??'')),reviewId=String(input.review_id??''),reviewSha=String(input.review_sha256??''),commandKey=input.command_key;
  if(!ID.test(reviewId)||!validDigest(reviewSha)||typeof commandKey!=='string'||!COMMAND.test(commandKey))throw failure('workspace_checkpoint_restore_invalid');this.signal(input);this.validateScope(owner,workspaceId,project);
  const request={owner_id:owner,workspace_id:workspaceId,project_id:project,checkpoint_id:checkpointId,path,review_id:reviewId,review_sha256:reviewSha},requestSha=sha(request),prior=this.db.prepare('SELECT operation_id,request_sha256 FROM wb_workspace_checkpoint_path_journal WHERE owner_id=? AND workspace_id=? AND project_id=? AND command_key=?').get(owner,workspaceId,project,commandKey) as Row|undefined;
  const rejection=this.db.prepare('SELECT request_sha256 FROM wb_workspace_checkpoint_restore_rejections WHERE owner_id=? AND workspace_id=? AND project_id=? AND command_key=?').get(owner,workspaceId,project,commandKey) as Row|undefined;
  if(rejection){if(rejection.request_sha256!==requestSha)throw failure('idempotency_conflict');throw failure('workspace_checkpoint_review_changed');}
  if(prior){if(prior.request_sha256!==requestSha)throw failure('idempotency_conflict');const operationId=String(prior.operation_id),outcome=this.hasOutcome(operationId);if(outcome)return ()=>outcome;const current=this.db.prepare('SELECT expires_at FROM ga_worker_leases WHERE resource_id=?').get(this.leaseResource(operationId));if(current&&Number(current.expires_at)>this.now())throw failure('workspace_checkpoint_restore_busy');return ()=>this.reconcileRestore(owner,workspaceId,project,operationId,input);}
  const review=this.reviewRow(owner,workspaceId,project,reviewId);if(review.checkpoint_id!==checkpointId||review.path!==path||review.review_sha256!==reviewSha)throw failure('workspace_checkpoint_review_changed');
  const checkpoint=this.readyRow(owner,workspaceId,project,checkpointId),{snapshotId,target}=this.checkpointTarget(checkpoint,path),facts=this.selectedRows(owner,workspaceId,project,[path]),current=facts[0]!,root=this.currentRoot(owner,workspaceId,project),revision=this.currentRevisionInTransaction(owner,workspaceId,project);
  if(rootJson(root)!==String(review.root_identity_json)||revision!==Number(review.expected_revision)||canonicalJson(this.storedBefore(current))!==String(review.before_state_json))throw failure('workspace_checkpoint_review_changed');
  const targetState=publicState(target);if(sha(targetState)!==review.target_state_sha256)throw failure('workspace_checkpoint_review_corrupt');
  const history=this.db.prepare('SELECT COALESCE(max(version),0) version FROM wb_file_versions WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=?').get(owner,workspaceId,project,path) as Row,targetVersion=target.kind==='file'?Number(history.version)+1:null,blobName=target.kind==='file'?`${randomUUID()}.bin`:null,operationId=makeId('workspace-checkpoint-restore'),binding=sha({request_sha256:requestSha,operation_id:operationId}),createdAt=new Date(this.now()).toISOString();let lease:{owner:string;generation:number}|undefined;
  const beforeStored=this.storedBefore(current),beforeJson=canonicalJson(beforeStored),targetJson=canonicalJson(targetState),rootIdentityJson=rootJson(root),beforeHash=sha(beforeStored),targetHash=sha(targetState),journalBase={operation_id:operationId,owner_id:owner,workspace_id:workspaceId,project_id:project,checkpoint_id:checkpointId,snapshot_id:snapshotId,path,review_id:reviewId,review_sha256:reviewSha,binding_sha256:binding,expected_revision:revision,root_identity_json:rootIdentityJson,before_state_json:beforeJson,before_state_sha256:beforeHash,target_state_json:targetJson,target_state_sha256:targetHash,target_version:targetVersion,blob_name:blobName,command_key:commandKey,request_sha256:requestSha,created_at:createdAt};
  withImmediateTransaction(this.db,()=>{
   if(this.currentRevisionInTransaction(owner,workspaceId,project)!==revision||rootJson(this.currentRoot(owner,workspaceId,project))!==rootIdentityJson||canonicalJson(this.storedBefore(this.selectedRows(owner,workspaceId,project,[path])[0]!))!==beforeJson)throw failure('workspace_checkpoint_review_changed');
   lease=this.claimLease(operationId);const reservation=reserveWorkspaceOperation(this.db,{owner_id:owner,project_id:project,operation_kind:'workspace_checkpoint_restore',operation_id:operationId,binding_sha256:binding}),reservationId=reservation.reservation_id;
   const core={...journalBase,reservation_id:reservationId,lease_owner:lease.owner,lease_generation:lease.generation},journalSha=sha(core);
   this.db.prepare(`INSERT INTO wb_workspace_checkpoint_path_journal(operation_id,owner_id,workspace_id,project_id,checkpoint_id,snapshot_id,path,review_id,review_sha256,reservation_id,binding_sha256,expected_revision,root_identity_json,before_state_json,before_state_sha256,target_state_json,target_state_sha256,target_version,blob_name,lease_owner,lease_generation,command_key,request_sha256,created_at,journal_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(operationId,owner,workspaceId,project,checkpointId,snapshotId,path,reviewId,reviewSha,reservationId,binding,revision,rootIdentityJson,beforeJson,beforeHash,targetJson,targetHash,targetVersion,blobName,lease.owner,lease.generation,commandKey,requestSha,createdAt,journalSha);
   this.db.prepare('INSERT INTO wb_workspace_checkpoint_restore_lease_generations VALUES(?,?,?,?,?)').run(operationId,lease.generation,lease.owner,'initial',createdAt);
   this.notify('restore_journal_committed',{operation_id:operationId,reservation_id:reservationId});
  });
  return ()=>this.executeRestore(this.journal(operationId),input,lease!);
 }
 private finalizeNotApplied(row:Row,lease:{owner:string;generation:number}){
  const operationId=String(row.operation_id),source=this.sourceForJournal(row),owner=String(row.owner_id),workspace=String(row.workspace_id),project=String(row.project_id),path=String(row.path);
  return withImmediateTransaction(this.db,()=>{
   this.touchLease(operationId,lease.owner,lease.generation);this.validateScope(owner,workspace,project);const root=JSON.parse(String(row.root_identity_json)) as RootIdentity|null;
   if(rootJson(this.currentRoot(owner,workspace,project))!==rootJson(root)||this.currentRevisionInTransaction(owner,workspace,project)!==Number(row.expected_revision)||canonicalJson(this.storedBefore(this.selectedRows(owner,workspace,project,[path])[0]!))!==String(row.before_state_json))throw failure('workspace_checkpoint_current_changed');
   const receipt=Object.freeze({protocol:1,operation_id:operationId,checkpoint_id:String(row.checkpoint_id),path,outcome:'not_applied',target_state_sha256:String(row.target_state_sha256),result_version:null,source_revision:Number(row.expected_revision),execution_authorized:false,restore_authorized:false}),json=canonicalJson(receipt);
   this.db.prepare('INSERT INTO wb_workspace_checkpoint_restore_outcomes VALUES(?,?,?,?)').run(operationId,json,sha(json),new Date(this.now()).toISOString());
   const released=this.db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=? AND owner=? AND generation=?').run(this.leaseResource(operationId),lease.owner,lease.generation);if(released.changes!==1)throw failure('workspace_checkpoint_lease_revoked');settleWorkspaceOperation(this.db,source);return receipt;
  });
 }
 async reconcileRestore(owner:string,workspaceId:string,project:string,operationId:string,controls:Controls={}){
  this.signal(controls);this.validateScope(owner,workspaceId,project);const row=this.journal(operationId);if(row.owner_id!==owner||row.workspace_id!==workspaceId||row.project_id!==project)throw failure('workspace_checkpoint_restore_not_found');const prior=this.hasOutcome(operationId);if(prior)return prior;
  let lease:{owner:string;generation:number}|undefined;withImmediateTransaction(this.db,()=>{
   const current=this.db.prepare('SELECT owner,generation,expires_at FROM ga_worker_leases WHERE resource_id=?').get(this.leaseResource(operationId));if(!current||!Number.isSafeInteger(Number(current.expires_at))||Number(current.expires_at)>this.now())throw failure('workspace_checkpoint_restore_busy');lease=this.claimLease(operationId);this.db.prepare('INSERT INTO wb_workspace_checkpoint_restore_lease_generations VALUES(?,?,?,?,?)').run(operationId,lease.generation,lease.owner,'reconcile',new Date(this.now()).toISOString());
  });
  const source=this.sourceForJournal(row);if(readWorkspaceOperation(this.db,source)?.state!=='reserved')throw failure('workspace_checkpoint_restore_closed');
  try{
   this.touchLease(operationId,lease!.owner,lease!.generation);this.validateScope(owner,workspaceId,project);const root=JSON.parse(String(row.root_identity_json)) as RootIdentity|null;
   if(rootJson(this.currentRoot(owner,workspaceId,project))!==rootJson(root)||this.sourceRevision(owner,workspaceId,project)!==Number(row.expected_revision)||canonicalJson(this.storedBefore(this.selectedRows(owner,workspaceId,project,[String(row.path)])[0]!))!==String(row.before_state_json))throw failure('workspace_checkpoint_current_changed');
   if((row.target as PublicPathState).kind==='file'){
    const final=root?join(root.path,'blobs',String(row.blob_name)):'';if(!final||!existsSync(final))return this.finalizeNotApplied(row,lease!);
    this.syncFileHash(root!,final,Number(row.target.size),String(row.target.sha256));
   }
   return this.finalizeRestore(row,lease!);
  }catch(error){try{this.retainUnknown(row);}catch{}throw error;}
 }
 restoreRequestStatus(owner:string,workspaceId:string,checkpointId:string,commandKey:string,input:Record<string,unknown>){
  if(!exact(input,['project_id','path','review_id','review_sha256'])||!ID.test(String(input.review_id))||!validDigest(input.review_sha256)||!COMMAND.test(commandKey)||!ID.test(checkpointId))throw failure('workspace_checkpoint_restore_status_invalid');
  const project=String(input.project_id),request={owner_id:owner,workspace_id:workspaceId,project_id:project,checkpoint_id:checkpointId,path:boundedPath(String(input.path)),review_id:String(input.review_id),review_sha256:String(input.review_sha256)},digest=sha(request),commandDigest=sha({workspace_id:workspaceId,checkpoint_id:checkpointId,command_key:commandKey,project_id:project,path:request.path,review_id:request.review_id,review_sha256:request.review_sha256});
  this.validateScope(owner,workspaceId,project);
  return withImmediateTransaction(this.db,()=>{
   const rejected=this.db.prepare('SELECT * FROM wb_workspace_checkpoint_restore_rejections WHERE owner_id=? AND workspace_id=? AND project_id=? AND command_key=?').get(owner,workspaceId,project,commandKey) as Row|undefined;
   const journal=this.db.prepare('SELECT operation_id,request_sha256,checkpoint_id FROM wb_workspace_checkpoint_path_journal WHERE owner_id=? AND workspace_id=? AND project_id=? AND command_key=?').get(owner,workspaceId,project,commandKey) as Row|undefined;
   if(rejected&&journal)throw failure('workspace_checkpoint_journal_corrupt');
   if((rejected??journal)?.request_sha256!==undefined&&(rejected??journal)!.request_sha256!==digest)throw failure('idempotency_conflict');
   if(rejected){if(sha(String(rejected.request_json))!==digest||rejected.request_json!==canonicalJson(request)||rejected.checkpoint_id!==checkpointId||rejected.reason!=='workspace_checkpoint_review_changed')throw failure('workspace_checkpoint_journal_corrupt');return Object.freeze({state:'terminal_rejected',command_key:commandKey,request_sha256:digest,command_sha256:commandDigest,no_effect:true,reason:rejected.reason,execution_authorized:false,restore_authorized:false});}
   if(journal){const stored=this.journal(String(journal.operation_id));if(stored.checkpoint_id!==checkpointId||stored.path!==request.path||stored.review_id!==request.review_id||stored.review_sha256!==request.review_sha256)throw failure('workspace_checkpoint_journal_corrupt');const receipt=this.hasOutcome(String(journal.operation_id));if(receipt&&(receipt.protocol!==1||receipt.operation_id!==stored.operation_id||receipt.checkpoint_id!==checkpointId||receipt.path!==request.path||receipt.target_state_sha256!==stored.target_state_sha256||!['applied','not_applied'].includes(receipt.outcome)))throw failure('workspace_checkpoint_outcome_corrupt');return Object.freeze({state:receipt?'settled':'recorded_pending',command_key:commandKey,request_sha256:digest,command_sha256:commandDigest,operation_id:String(journal.operation_id),...(receipt?{receipt}:{}),execution_authorized:false,restore_authorized:false});}
   return Object.freeze({state:'unobserved',command_key:commandKey,request_sha256:digest,command_sha256:commandDigest,execution_authorized:false,restore_authorized:false});
  });
 }
 restoreStatus(owner:string,workspaceId:string,project:string,operationId:string){
  this.validateScope(owner,workspaceId,project);const row=this.journal(operationId);if(row.owner_id!==owner||row.workspace_id!==workspaceId||row.project_id!==project)throw failure('workspace_checkpoint_restore_not_found');
  return this.hasOutcome(operationId)??Object.freeze({operation_id:operationId,checkpoint_id:String(row.checkpoint_id),path:String(row.path),state:'unresolved',execution_authorized:false,restore_authorized:false});
 }
 private assertNoRetentionReferences(owner:string,workspace:string,project:string,checkpoint:string){
  if(this.db.prepare('SELECT 1 FROM wb_workspace_checkpoint_references WHERE checkpoint_id=? LIMIT 1').get(checkpoint)
   ||this.db.prepare('SELECT 1 FROM wb_workspace_checkpoint_restore_reviews WHERE checkpoint_id=? LIMIT 1').get(checkpoint)
   ||this.db.prepare(`SELECT 1 FROM wb_workspace_checkpoint_path_journal j WHERE j.checkpoint_id=? AND NOT EXISTS(SELECT 1 FROM wb_workspace_checkpoint_restore_outcomes o WHERE o.operation_id=j.operation_id) LIMIT 1`).get(checkpoint)
   ||this.db.prepare(`SELECT 1 FROM wb_workspace_reservations r LEFT JOIN wb_workspace_reservation_releases x ON x.reservation_id=r.reservation_id
     WHERE r.owner_id=? AND r.project_id=? AND r.operation_kind='workspace_checkpoint_restore' AND x.reservation_id IS NULL
      AND EXISTS(SELECT 1 FROM wb_workspace_checkpoint_path_journal j WHERE j.reservation_id=r.reservation_id AND j.checkpoint_id=?) LIMIT 1`).get(owner,project,checkpoint))throw failure('workspace_checkpoint_retained_reference');
  if(this.db.prepare('SELECT 1 FROM wb_workspace_checkpoint_prune_outcomes WHERE checkpoint_id=?').get(checkpoint))return;
  if(!this.db.prepare('SELECT 1 FROM wb_workspace_checkpoint_intents WHERE checkpoint_id=? AND owner_id=? AND workspace_id=? AND project_id=?').get(checkpoint,owner,workspace,project))throw failure('workspace_checkpoint_not_found');
  const ready=this.readyRow(owner,workspace,project,checkpoint);
  const artifact=this.readRecoveryRecord(String(ready.snapshot_id));
  if(!artifact)throw failure('workspace_checkpoint_artifact_unconfirmed');
  const root=snapshotRoot(artifact);
  const contains=(base:string,path:string)=>{
   const child=relative(base,path);
   return child===''||child!=='..'&&!child.startsWith(`..${sep}`)&&!isAbsolute(child);
  };
  // Legacy rows can reference checkpoint bytes without a checkpoint reference row.
  for(const table of ['ga_uploads','ga_artifact_versions','ga_artifact_parts']){
   if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
   for(const row of this.db.prepare(`SELECT server_path FROM ${table}`).iterate()){
    const path=row.server_path;
    if(typeof path!=='string'||!isAbsolute(path))throw failure('workspace_checkpoint_reference_inventory_invalid');
    if(contains(root.path,path))throw failure('workspace_checkpoint_retained_reference');
    let canonical:string;
    try{canonical=realpathSync.native(path);}catch(error){
     if((error as NodeJS.ErrnoException).code==='ENOENT')continue;
     throw failure('workspace_checkpoint_reference_inventory_invalid');
    }
    if(contains(root.canonical,canonical))throw failure('workspace_checkpoint_retained_reference');
   }
  }
 }
 private deleteSnapshotTree(expected: RootIdentity, entries: ReadonlyMap<string, WorkspaceManifestEntry>) {
  const current = syncRootIdentity(expected.path);
  if (rootJson(current) !== rootJson(expected)) throw failure('workspace_checkpoint_root_changed');
  const remove = (path: string) => {
   const stat = lstatSync(path);
   if (stat.isSymbolicLink()) throw failure('workspace_checkpoint_path_unsafe');
   const selectedPath = relative(expected.path, path).split(sep).join('/');
   const entry = entries.get(selectedPath);
   if (stat.isDirectory()) {
    if (selectedPath && entry?.kind !== 'directory') throw failure('workspace_checkpoint_prune_manifest_changed');
    for (const name of readdirSync(path).sort()) remove(join(path, name));
    rmdirSync(path);
    return;
   }
   if (!stat.isFile() || stat.nlink !== 1) throw failure('workspace_checkpoint_path_unsafe');
   if (entry?.kind !== 'file' || Boolean(stat.mode & 0o100) !== entry.executable) throw failure('workspace_checkpoint_prune_manifest_changed');
   this.syncFileHash(expected, path, entry.bytes, entry.sha256);
   unlinkSync(path);
   this.notify('prune_file_deleted',{path:selectedPath});
  };
  remove(expected.path);
 }
 private readPruneOutcome(checkpointId: string) {
  const done = this.db.prepare('SELECT outcome_json,outcome_sha256 FROM wb_workspace_checkpoint_prune_outcomes WHERE checkpoint_id=?').get(checkpointId) as Row | undefined;
  if (!done) return undefined;
  if (!validDigest(done.outcome_sha256) || sha(String(done.outcome_json)) !== done.outcome_sha256) throw failure('workspace_checkpoint_prune_corrupt');
  return parseCanonical(String(done.outcome_json), 'workspace_checkpoint_prune_corrupt');
 }
 private async finishPrune(owner: string, workspace: string, project: string, checkpointId: string) {
  const intent = this.db.prepare('SELECT snapshot_id,backup_proof_json,backup_proof_sha256,root_identity_json FROM wb_workspace_checkpoint_prunes WHERE checkpoint_id=?').get(checkpointId) as Row | undefined;
  if (!intent) throw failure('workspace_checkpoint_prune_not_found');
  this.readyRow(owner, workspace, project, checkpointId);
  const done = this.readPruneOutcome(checkpointId);
  if (done) return done;
  const checkpoint = this.readyRow(owner, workspace, project, checkpointId);
  const manifestHash = String(checkpoint.manifest_sha256);
  const proof = parseCanonical(String(intent.backup_proof_json), 'workspace_checkpoint_prune_corrupt');
  if (!validDigest(intent.backup_proof_sha256) || sha(proof) !== intent.backup_proof_sha256 || !this.verifyBackupProof
   || !await this.verifyBackupProof(proof, {checkpoint_id: checkpointId, manifest_sha256: manifestHash, snapshot_id: String(intent.snapshot_id)})) {
   throw failure('workspace_checkpoint_backup_proof_invalid');
  }
  const root = parseCanonical(String(intent.root_identity_json), 'workspace_checkpoint_prune_corrupt') as RootIdentity;
  try {
   this.assertNoRetentionReferences(owner, workspace, project, checkpointId);
   if (existsSync(root.path)) {
    const artifact = this.readRecoveryRecord(String(intent.snapshot_id));
    if (!artifact) throw failure('workspace_checkpoint_artifact_unconfirmed');
    const provider = this.provider();
    const snapshot = await provider.recover({snapshot_id: String(intent.snapshot_id), storageRoot: this.storageRoot,
     guard: this.guard(owner, workspace, project, {}), signal: new AbortController().signal});
    const inspected = await provider.inspect({snapshot, guard: this.guard(owner, workspace, project, {}), signal: new AbortController().signal});
    const entries = new Map(artifact.manifest.entries.map(entry => [entry.path, entry]));
    for (const entry of inspected.manifest.entries) {
     const original = entries.get(entry.path);
     if (!original || entry.kind !== 'absent' && canonicalJson(entry) !== canonicalJson(original)) throw failure('workspace_checkpoint_prune_manifest_changed');
    }
    if (rootJson(snapshotRoot(artifact)) !== rootJson(root)) throw failure('workspace_checkpoint_root_changed');
    const completed = this.readPruneOutcome(checkpointId);
    if (completed) return completed;
    this.assertNoRetentionReferences(owner, workspace, project, checkpointId);
    this.deleteSnapshotTree(root, entries);
    this.notify('prune_tree_deleted',{checkpoint_id:checkpointId});
   }
   const outcome = Object.freeze({protocol: 1, checkpoint_id: checkpointId, snapshot_id: String(intent.snapshot_id),
    backup_proof_sha256: String(intent.backup_proof_sha256), state: 'pruned', execution_authorized: false, restore_authorized: false});
   const json = canonicalJson(outcome);
   return withImmediateTransaction(this.db, () => {
    this.assertNoRetentionReferences(owner, workspace, project, checkpointId);
    const completed = this.readPruneOutcome(checkpointId);
    if (completed) return completed;
    this.notify('prune_before_commit',{checkpoint_id:checkpointId});
    this.db.prepare('INSERT INTO wb_workspace_checkpoint_prune_outcomes VALUES(?,?,?,?)')
     .run(checkpointId, json, sha(json), new Date(this.now()).toISOString());
    return outcome;
   });
  } catch (error) {
   const completed = this.readPruneOutcome(checkpointId);
   if (completed) return completed;
   throw error;
  }
 }
 async prune(owner:string,workspaceId:string,project:string,checkpointId:string,backupProof:unknown){
  this.validateScope(owner,workspaceId,project);const checkpoint=this.readyRow(owner,workspaceId,project,checkpointId);this.assertNoRetentionReferences(owner,workspaceId,project,checkpointId);
  if(!this.verifyBackupProof)throw failure('workspace_checkpoint_backup_verifier_unavailable');let proofJson:string;try{proofJson=canonicalJson(backupProof);}catch{throw failure('workspace_checkpoint_backup_proof_invalid');}
  const proof=parseCanonical(proofJson,'workspace_checkpoint_backup_proof_invalid'),expected={checkpoint_id:checkpointId,manifest_sha256:String(checkpoint.manifest_sha256),snapshot_id:String(checkpoint.snapshot_id)};
  if(!await this.verifyBackupProof(proof,expected))throw failure('workspace_checkpoint_backup_proof_invalid');
  const artifact=this.readRecoveryRecord(String(checkpoint.snapshot_id));if(!artifact)throw failure('workspace_checkpoint_artifact_unconfirmed');const root=snapshotRoot(artifact);
  withImmediateTransaction(this.db,()=>{
   this.assertNoRetentionReferences(owner,workspaceId,project,checkpointId);
   const prior=this.db.prepare('SELECT snapshot_id,backup_proof_json,backup_proof_sha256,root_identity_json FROM wb_workspace_checkpoint_prunes WHERE checkpoint_id=?').get(checkpointId) as Row|undefined;
   if(prior){
    if(prior.snapshot_id!==checkpoint.snapshot_id||prior.backup_proof_json!==proofJson||prior.backup_proof_sha256!==sha(proof)||prior.root_identity_json!==rootJson(root))throw failure('idempotency_conflict');
    return;
   }
   this.db.prepare('INSERT INTO wb_workspace_checkpoint_prunes VALUES(?,?,?,?,?,?)').run(checkpointId,String(checkpoint.snapshot_id),proofJson,sha(proof),rootJson(root),new Date(this.now()).toISOString());
  });
  this.notify('prune_intent_committed',{checkpoint_id:checkpointId});
  return this.finishPrune(owner,workspaceId,project,checkpointId);
 }
 async reconcilePrune(owner:string,workspaceId:string,project:string,checkpointId:string){
  this.validateScope(owner,workspaceId,project);if(!this.verifyBackupProof)throw failure('workspace_checkpoint_backup_verifier_unavailable');return this.finishPrune(owner,workspaceId,project,checkpointId);
 }
}

function snapshotRoot(record:SnapshotRecoveryRecord):RootIdentity{return{path:record.isolated_root.path,canonical:record.isolated_root.canonical,dev:record.isolated_root.dev,ino:record.isolated_root.ino};}
