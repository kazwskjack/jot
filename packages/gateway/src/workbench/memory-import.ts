import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {memoryExpired,type MemoryRow,type MemoryValue} from './memory-lifecycle.ts';

type Input=Record<string,unknown>;
type Target={scope:'project'|'private';project_id:string;agent_id:string|null};
type Source=MemoryValue & {
 memory_id:string;workspace_id:string;project_id:string;scope:'project'|'private';agent_id:string|null;content:string;
 version:number;status:string;verified:boolean;provenance:Array<{kind:string;reference:string}>;source_revision:string|null;
 expires_at:string|null;supersedes:string|null;history:Array<Record<string,unknown>>;
};
type PreviewItem={source_memory_id:string;source_version:number;source_history_versions:number[];source_content:string;source_provenance:Array<{kind:string;reference:string}>;source_revision:string|null;source_expires_at:string|null;target_key:string;target_expected_version:number;status:'ready'|'skipped'|'conflict';reason:string|null;source_local:boolean};
type Ports={authorizeTarget(owner:string,workspace:string,target:Target):Target;save(owner:string,workspace:string,input:Input):MemoryValue};
type Batch=Record<string,string|number|null>;

const digest=(value:unknown)=>{const encoded=JSON.stringify(value);if(typeof encoded!=='string')invalid();return createHash('sha256').update(encoded).digest('hex');};
function invalid():never{throw new Error('invalid_memory_import');}
function exact(value:unknown,keys:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))invalid();}
function label(value:unknown,max=128){if(typeof value!=='string'||!value.trim()||value.length>max)invalid();return value.trim();}
function nullableText(value:unknown,max=128){if(value===null)return null;if(typeof value!=='string'||value.length>max)invalid();return value;}
function object(value:unknown):Input{if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value as Input;}
function normalizeTarget(value:unknown):Target{
 const input=object(value);exact(input,['scope','project_id','agent_id']);const scope=input.scope;
 if(scope!=='project'&&scope!=='private')invalid();
 const project_id=label(input.project_id),agent_id=input.agent_id===undefined||input.agent_id===null?null:label(input.agent_id);
 if((scope==='project'&&agent_id!==null)||(scope==='private'&&agent_id===null))invalid();
 return {scope:scope as Target['scope'],project_id,agent_id};
}
function normalizeSource(value:unknown,workspaceId:string):Source{
 const row=object(value);exact(row,['memory_id','workspace_id','project_id','scope','agent_id','content','verified','version','status','provenance','source_revision','expires_at','supersedes','verified_at','expired','created_at','updated_at','history']);
 const memory_id=label(row.memory_id),workspace_id=label(row.workspace_id),project_id=label(row.project_id),scope=row.scope,content=row.content,verified=row.verified,version=row.version,status=row.status;
 if(workspace_id!==workspaceId||(scope!=='project'&&scope!=='private')||typeof content!=='string'||!content.trim()||content.length>20_000
   ||typeof verified!=='boolean'||typeof version!=='number'||!Number.isSafeInteger(version)||version<1||!['active','deleted','superseded'].includes(String(status))
   ||(scope==='private'&&typeof row.agent_id!=='string')||(scope==='project'&&row.agent_id!==null))invalid();
 const agent_id=row.agent_id===null?null:label(row.agent_id),source_revision=nullableText(row.source_revision),expires_at=nullableText(row.expires_at,64),supersedes=nullableText(row.supersedes);
 if(row.expired!==undefined&&typeof row.expired!=='boolean')invalid();
 if(row.verified_at!==undefined)nullableText(row.verified_at,64);
 if(row.created_at!==undefined)label(row.created_at,64);if(row.updated_at!==undefined)label(row.updated_at,64);
 if(expires_at!==null&&!Number.isFinite(Date.parse(expires_at)))invalid();
 const rawProvenance=row.provenance;if(!Array.isArray(rawProvenance)||rawProvenance.length>20)invalid();
 const provenance=rawProvenance.map((entry:unknown)=>{const source=object(entry);exact(source,['kind','reference']);return {kind:label(source.kind,60),reference:label(source.reference,2048)};});
 const rawHistory=row.history;if(!Array.isArray(rawHistory)||rawHistory.length<1||rawHistory.length>500)invalid();
 let previous=0;const history:Record<string,unknown>[]=rawHistory.map((entry:unknown)=>{
  const revision=object(entry);exact(revision,['version','content','verified','provenance','source_revision','expires_at','supersedes','verified_at','status','created_at','updated_at','restored_from_version','restored_over_version']);
  if(!Number.isSafeInteger(revision.version)||Number(revision.version)<=previous||typeof revision.content!=='string'||revision.content.length>20_000
    ||typeof revision.verified!=='boolean'||!['active','deleted','superseded'].includes(String(revision.status)))invalid();
  previous=Number(revision.version);return {...revision};
 });
 const current=history.at(-1);
 if(!current||current.version!==version||current.content!==content||current.status!==status)invalid();
 return {...row,memory_id,workspace_id,project_id,scope:scope as Target['scope'],agent_id,content:content as string,verified:verified as boolean,version:Number(version),status:String(status),
  provenance,source_revision,expires_at,supersedes,history} as Source;
}
function normalizeDocument(value:unknown):{schema_version:1;workspace_id:string;exported_at:string;items:Source[]}{
 let encoded:string|undefined;try{encoded=JSON.stringify(value);}catch{invalid();}
 if(typeof encoded!=='string'||encoded.length>5_000_000)invalid();
 const document=object(value);exact(document,['schema_version','workspace_id','exported_at','items']);
 const rawItems=document.items;if(document.schema_version!==1||!Array.isArray(rawItems)||rawItems.length>200)invalid();
 const workspace_id=label(document.workspace_id),exported_at=label(document.exported_at,64);
 if(!Number.isFinite(Date.parse(exported_at)))invalid();
 const items=rawItems.map((item:unknown)=>normalizeSource(item,workspace_id));
 if(new Set(items.map(item=>item.memory_id)).size!==items.length)invalid();
 return {schema_version:1 as const,workspace_id,exported_at,items};
}
function previewView(row:Batch){return {...JSON.parse(String(row.preview_json)),import_id:String(row.import_id),input_sha256:String(row.input_sha256),version:Number(row.version),status:String(row.status),created_at:String(row.created_at),updated_at:String(row.updated_at),
  ...(row.receipt_json===null?{}:{receipt:JSON.parse(String(row.receipt_json))})};}

/** Durable import previews and idempotent writes over the existing Jot memory authority. */
export class MemoryImportService{
 private readonly db:DatabaseSync;private readonly ports:Ports;
 constructor(db:DatabaseSync,ports:Ports){this.db=db;this.ports=ports;
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_memory_import_batches'").get())throw new Error('memory_import_schema_required');
 }
 private sourceState(owner:string,source:Source){
  const row=this.db.prepare('SELECT * FROM wb_memories WHERE owner_id=? AND workspace_id=? AND memory_id=?').get(owner,source.workspace_id,source.memory_id) as MemoryRow|undefined;
  if(!row){
   const reason=source.status==='superseded'?'source_superseded':source.status==='deleted'?'source_tombstone':source.expires_at&&Date.parse(source.expires_at)<=Date.now()?'source_expired':null;
   return {local:false,reason};
  }
  if(row.status==='superseded'){
   if(source.status==='superseded'&&Number(row.version)===source.version&&String(row.content)===source.content&&row.scope===source.scope&&row.project_id===source.project_id&&row.agent_id===source.agent_id)return {local:true,reason:'source_superseded'};
   return {local:true,reason:'source_tombstone'};
  }
  if(row.status==='deleted')return {local:true,reason:'source_tombstone'};
  if(row.status!=='active'||source.status!=='active'||Number(row.version)!==source.version||String(row.content)!==source.content||row.scope!==source.scope||row.project_id!==source.project_id||row.agent_id!==source.agent_id)return {local:true,reason:'source_changed'};
  if(memoryExpired(row))return {local:true,reason:'source_expired'};
  return {local:true,reason:null};
 }
 private targetState(owner:string,workspace:string,target:Target,targetKey:string){
  const rows=this.db.prepare('SELECT * FROM wb_memories WHERE owner_id=? AND workspace_id=? AND project_id=? AND scope=? AND agent_id IS ?')
   .all(owner,workspace,target.project_id,target.scope,target.agent_id) as MemoryRow[];
  const row=rows.find(value=>{
   try{return (JSON.parse(String(value.provenance_json??'[]')) as Array<{kind?:string;reference?:string}>).some(source=>source.kind==='import'&&source.reference===targetKey);}
   catch{return false;}
  });
  if(!row)return {expected:0 as const,reason:null};
  return {expected:Number(row.version),reason:row.status==='active'?'target_exists':'target_tombstone'};
 }
 private inspect(owner:string,workspace:string,target:Target,document:ReturnType<typeof normalizeDocument>){
  const items:PreviewItem[]=document.items.map(source=>{
   const targetKey=`jot-import-v1:${digest([target.scope,target.project_id,target.agent_id]).slice(0,16)}:${source.workspace_id}/${source.memory_id}@${source.version}`;
   const local=this.sourceState(owner,source),targetState=this.targetState(owner,workspace,target,targetKey);
   let reason=local.reason??targetState.reason,status:PreviewItem['status']=reason?(reason==='source_expired'||reason==='source_superseded'?'skipped':'conflict'):'ready';
   if(source.provenance.length>=20&&status==='ready'){reason='provenance_limit';status='conflict';}
   return {source_memory_id:source.memory_id,source_version:source.version,source_history_versions:source.history.map(row=>Number(row.version)),source_content:source.content,
    source_provenance:source.provenance,source_revision:source.source_revision,source_expires_at:source.expires_at,target_key:targetKey,target_expected_version:targetState.expected,status,reason,source_local:local.local};
  });
  return {schema_version:1,document_workspace_id:document.workspace_id,target,counts:{total:items.length,ready:items.filter(item=>item.status==='ready').length,
   skipped:items.filter(item=>item.status==='skipped').length,conflict:items.filter(item=>item.status==='conflict').length},items};
 }
 preview(owner:string,workspace:string,input:Input){return withImmediateTransaction(this.db,()=>{
  exact(input,['import_id','document','target']);const importId=label(input.import_id,128),document=normalizeDocument(input.document);
  const requestedTarget=normalizeTarget(input.target),target=this.ports.authorizeTarget(owner,workspace,requestedTarget);
  if(JSON.stringify(target)!==JSON.stringify(requestedTarget))throw new Error('memory_scope_forbidden');
  const inputValue={document,target},inputJson=JSON.stringify(inputValue),inputHash=digest(inputValue),now=new Date().toISOString();
  const old=this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch|undefined;
  if(old){
   if(old.input_sha256!==inputHash||old.input_json!==inputJson)throw new Error('memory_import_id_conflict');
   if(old.status==='applied')return previewView(old);
   const fresh=this.inspect(owner,workspace,target,document),freshJson=JSON.stringify(fresh);
   if(freshJson!==old.preview_json){this.db.prepare('UPDATE wb_memory_import_batches SET preview_json=?,version=version+1,updated_at=? WHERE owner_id=? AND workspace_id=? AND import_id=? AND status=\'previewed\'')
    .run(freshJson,now,owner,workspace,importId);}
   return previewView(this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch);
  }
  const preview=this.inspect(owner,workspace,target,document);
  this.db.prepare(`INSERT INTO wb_memory_import_batches(owner_id,workspace_id,import_id,input_sha256,input_json,preview_json,version,status,receipt_json,created_at,updated_at)
   VALUES(?,?,?,?,?,?,1,'previewed',NULL,?,?)`).run(owner,workspace,importId,inputHash,inputJson,JSON.stringify(preview),now,now);
  return previewView(this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch);
 });}
 get(owner:string,workspace:string,importId:string){
  const row=this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch|undefined;
  if(!row)throw new Error('memory_import_not_found');const snapshot=JSON.parse(String(row.input_json)) as {document:ReturnType<typeof normalizeDocument>;target:Target};
  const target=this.ports.authorizeTarget(owner,workspace,snapshot.target);if(JSON.stringify(target)!==JSON.stringify(snapshot.target))throw new Error('memory_scope_forbidden');
  return previewView(row);
 }
 apply(owner:string,workspace:string,input:Input){return withImmediateTransaction(this.db,()=>{
  exact(input,['import_id','expected_version']);const importId=label(input.import_id,128);
  if(!Number.isSafeInteger(input.expected_version)||Number(input.expected_version)<1)invalid();
  const row=this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch|undefined;
  if(!row)throw new Error('memory_import_not_found');if(row.status==='applied')return JSON.parse(String(row.receipt_json));
  if(Number(input.expected_version)!==Number(row.version))throw new Error('version_conflict');
  const snapshot=JSON.parse(String(row.input_json)) as {document:ReturnType<typeof normalizeDocument>;target:Target};
  if(digest(snapshot)!==row.input_sha256)throw new Error('memory_import_digest_conflict');
  const target=this.ports.authorizeTarget(owner,workspace,snapshot.target);if(JSON.stringify(target)!==JSON.stringify(snapshot.target))throw new Error('memory_scope_forbidden');
  const fresh=this.inspect(owner,workspace,target,snapshot.document);
  if(fresh.counts.conflict||JSON.stringify(fresh)!==row.preview_json)throw new Error('memory_import_conflict');
  const sourceById=new Map(snapshot.document.items.map(source=>[source.memory_id,source]));
  const results:Input[]=[];
  for(const item of fresh.items){
   if(item.status==='skipped'){results.push({...item});continue;}
   const source=sourceById.get(item.source_memory_id)!;
   const provenance=[...source.provenance,{kind:'import',reference:item.target_key}];
   const saved=this.ports.save(owner,workspace,{scope:target.scope,project_id:target.project_id,agent_id:target.agent_id,
    content:source.content,verified:false,provenance,source_revision:source.source_revision,expires_at:source.expires_at,supersedes:null});
   if(typeof saved.memory_id!=='string'||saved.version!==1||saved.verified!==false||saved.status!=='active')throw new Error('memory_import_write_conflict');
   results.push({source_memory_id:item.source_memory_id,source_version:item.source_version,memory_id:String(saved.memory_id),version:Number(saved.version),status:'created'});
  }
  const receipt={import_id:importId,status:'applied',version:Number(row.version),target,items:results,applied_at:new Date().toISOString()};
  this.db.prepare("UPDATE wb_memory_import_batches SET status='applied',receipt_json=?,updated_at=? WHERE owner_id=? AND workspace_id=? AND import_id=? AND status='previewed' AND version=?")
   .run(JSON.stringify(receipt),receipt.applied_at,owner,workspace,importId,Number(row.version));
  return receipt;
 });}
}
