import {pilotdeckMemoryImport,pilotdeckMemoryImportHistory,type PilotdeckMemoryImportSource} from './pilotdeck-memory-import.ts';
import {createHash} from 'node:crypto';
import type {WorkbenchMemoryImportFileSelection,WorkbenchMemoryImportFileSource,WorkbenchMemoryImportHistorySection} from '../../contracts/types.ts';
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
type Ports={authorizeTarget(owner:string,workspace:string,target:Target):Target;save(owner:string,workspace:string,input:Input):MemoryValue;remove?(owner:string,workspace:string,memoryId:string,version:number):{memory_id:string;status:string};readFile?(owner:string,workspace:string,project:string,path:string,version:number,sha256:string):{path:string;version:number;sha256:string;size:number;content:Buffer}};
type Batch=Record<string,string|number|null>;
type Snapshot={document:ReturnType<typeof normalizeDocument>;target:Target;source_bundle?:PilotdeckMemoryImportSource;mode?:'replace_scope';source_file?:WorkbenchMemoryImportFileSource};

const digest=(value:unknown)=>{const encoded=JSON.stringify(value);if(typeof encoded!=='string')invalid();return createHash('sha256').update(encoded).digest('hex');};
function invalid():never{throw new Error('invalid_memory_import');}
function exact(value:unknown,keys:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))invalid();}
function label(value:unknown,max=128){if(typeof value!=='string'||!value.trim()||value.length>max)invalid();return value.trim();}
function nullableText(value:unknown,max=128){if(value===null)return null;if(typeof value!=='string'||value.length>max)invalid();return value;}
function object(value:unknown):Input{if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value as Input;}
function fileSelection(value:unknown):WorkbenchMemoryImportFileSelection|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const input=value as Input;if(input.formatVersion!==undefined||input.kind!=='workspace_file')return null;
 exact(input,['kind','path','version','sha256','size']);
 if(typeof input.path!=='string'||!input.path||input.path.length>400||!Number.isSafeInteger(input.version)||Number(input.version)<1
  ||typeof input.sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.sha256)||!Number.isSafeInteger(input.size)||Number(input.size)<0||Number(input.size)>104_857_600)invalid();
 return {kind:'workspace_file',path:input.path,version:Number(input.version),sha256:input.sha256,size:Number(input.size)};
}
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
function normalizeDocument(value:unknown,maxCharacters=5_000_000,maxItems=200):{schema_version:1;workspace_id:string;exported_at:string;items:Source[]}{
 let encoded:string|undefined;try{encoded=JSON.stringify(value);}catch{invalid();}
 if(typeof encoded!=='string'||encoded.length>maxCharacters)invalid();
 const document=object(value);exact(document,['schema_version','workspace_id','exported_at','items']);
 const rawItems=document.items;if(document.schema_version!==1||!Array.isArray(rawItems)||rawItems.length>maxItems)invalid();
 const workspace_id=label(document.workspace_id),exported_at=label(document.exported_at,64);
 if(!Number.isFinite(Date.parse(exported_at)))invalid();
 const items=rawItems.map((item:unknown)=>normalizeSource(item,workspace_id));
 if(new Set(items.map(item=>item.memory_id)).size!==items.length)invalid();
 return {schema_version:1 as const,workspace_id,exported_at,items};
}
type ImportPage={offset:number;limit:number};
function pageItems<T>(items:T[],page:ImportPage){
 if(!Number.isSafeInteger(page.offset)||page.offset<0||!Number.isSafeInteger(page.limit)||page.limit<1||page.limit>100)invalid();
 const selected=items.slice(page.offset,page.offset+page.limit),next=page.offset+selected.length;
 return {items:selected,page:{offset:page.offset,limit:page.limit,total:items.length,next_offset:next<items.length?next:null}};
}
function receiptPage(receipt:any,page?:ImportPage){
 if(!page)return receipt;
 return {...receipt,...pageItems(receipt.items as Input[],page),totals:{total:receipt.items.length,created:receipt.items.filter((item:Input)=>item.status==='created').length,skipped:receipt.items.filter((item:Input)=>item.status==='skipped').length}};
}
function viewPage(view:any,page?:ImportPage){
 if(!page)return view;
 return {...view,...pageItems(view.items as Input[],page),...(view.receipt?{receipt:receiptPage(view.receipt,page)}:{})};
}
function previewView(row:Batch){return {...JSON.parse(String(row.preview_json)),import_id:String(row.import_id),input_sha256:String(row.input_sha256),version:Number(row.version),status:String(row.status),created_at:String(row.created_at),updated_at:String(row.updated_at),
  ...(row.receipt_json===null?{}:{receipt:JSON.parse(String(row.receipt_json))})};}

/** Durable import previews and idempotent writes over the existing Jot memory authority. */
export class MemoryImportService{
 private readonly db:DatabaseSync;private readonly ports:Ports;
 constructor(db:DatabaseSync,ports:Ports){this.db=db;this.ports=ports;
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_memory_import_batches'").get())throw new Error('memory_import_schema_required');
 }
 private readFileSource(owner:string,workspace:string,target:Target,source:WorkbenchMemoryImportFileSource){
  if(source.workspace_id!==workspace||source.project_id!==target.project_id)throw Error('memory_scope_forbidden');
  const selection=fileSelection({kind:source.kind,path:source.path,version:source.version,sha256:source.sha256,size:source.size});
  if(!selection)invalid();if(!this.ports.readFile)throw Error('memory_import_file_source_unavailable');
  const row=this.db.prepare('SELECT sha256,size FROM wb_file_versions WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=? AND version=?')
   .get(owner,workspace,target.project_id,selection.path,selection.version) as {sha256:string;size:number}|undefined;
  if(!row||row.sha256!==selection.sha256||Number(row.size)!==selection.size)throw Error('memory_import_file_source_changed');
  const file=this.ports.readFile(owner,workspace,target.project_id,selection.path,selection.version,selection.sha256);
  if(file.path!==selection.path||file.version!==selection.version||file.sha256!==selection.sha256||file.size!==selection.size
   ||file.content.byteLength!==selection.size||createHash('sha256').update(file.content).digest('hex')!==selection.sha256)throw Error('memory_import_digest_conflict');
  return file.content;
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
 private replacement(owner:string,workspace:string,target:Target){
  const rows=this.db.prepare(`SELECT memory_id,version,content,verified,expires_at FROM wb_memories
   WHERE owner_id=? AND workspace_id=? AND project_id=? AND scope=? AND agent_id IS ? AND status='active' ORDER BY memory_id`)
   .iterate(owner,workspace,target.project_id,target.scope,target.agent_id) as Iterable<MemoryRow>;
  const items:Array<{memory_id:string;version:number;content_sha256:string;content_chars:number;verified:boolean;expires_at:string|null}>=[];
  for(const row of rows)items.push({memory_id:String(row.memory_id),version:Number(row.version),
   content_sha256:createHash('sha256').update(String(row.content),'utf8').digest('hex'),content_chars:String(row.content).length,
   verified:Boolean(row.verified),expires_at:row.expires_at===null?null:String(row.expires_at)});
  return {scope_sha256:digest({target,items}),count:items.length,items};
 }
 private targetStates(owner:string,workspace:string,target:Target){
  const retirements=this.db.prepare(`SELECT json_extract(item.value,'$.memory_id') AS memory_id,json_extract(item.value,'$.result_version') AS version
   FROM wb_memory_import_batches b JOIN json_each(b.receipt_json,'$.replacement.items') item
   WHERE b.owner_id=? AND b.workspace_id=? AND b.status='applied' AND json_extract(b.receipt_json,'$.mode')='replace_scope'
   AND json_extract(b.receipt_json,'$.target.project_id')=? AND json_extract(b.receipt_json,'$.target.scope')=? AND json_extract(b.receipt_json,'$.target.agent_id') IS ?
   AND json_extract(item.value,'$.status')='deleted'`).iterate(owner,workspace,target.project_id,target.scope,target.agent_id) as Iterable<MemoryRow>;
  const retired=new Set<string>();
  for(const row of retirements)retired.add(JSON.stringify([row.memory_id,Number(row.version)]));

  const rows=this.db.prepare('SELECT memory_id,version,status,provenance_json FROM wb_memories WHERE owner_id=? AND workspace_id=? AND project_id=? AND scope=? AND agent_id IS ?')
   .iterate(owner,workspace,target.project_id,target.scope,target.agent_id) as Iterable<MemoryRow>;
  const states=new Map<string,{expected:number;reason:'target_exists'|'target_tombstone'}>();
  for(const row of rows){
   if(row.status==='deleted'&&retired.has(JSON.stringify([row.memory_id,Number(row.version)])))continue;
   const provenance=JSON.parse(String(row.provenance_json??'[]')) as Array<{kind?:string;reference?:string}>;
   for(const source of provenance){
    if(source.kind!=='import'||typeof source.reference!=='string')continue;
    const prefix=source.reference.slice(0,source.reference.lastIndexOf('@')+1);
    if(!prefix||!/^(?:[1-9][0-9]*|[a-f0-9]{64})$/.test(source.reference.slice(prefix.length)))continue;
    const state={expected:Number(row.version),reason:row.status==='active'?'target_exists' as const:'target_tombstone' as const};
    if(!states.has(source.reference))states.set(source.reference,state);
    if(row.status!=='active'&&!states.has(prefix))states.set(prefix,state);
   }
  }
  return states;
 }
 private inspect(owner:string,workspace:string,target:Target,document:ReturnType<typeof normalizeDocument>,sourceBundle?:PilotdeckMemoryImportSource,mode?:'replace_scope',sourceFile?:WorkbenchMemoryImportFileSource){
  const targets=this.targetStates(owner,workspace,target);
  const items:PreviewItem[]=document.items.map(source=>{
   const targetKey=`${sourceBundle?'jot-import-v2':'jot-import-v1'}:${digest([target.scope,target.project_id,target.agent_id]).slice(0,16)}:${source.workspace_id}/${source.memory_id}@${sourceBundle?source.source_revision:source.version}`;
   const local=this.sourceState(owner,source),targetState=targets.get(targetKey.slice(0,targetKey.lastIndexOf('@')+1))??targets.get(targetKey)??{expected:0,reason:null};
   let reason=local.reason??(mode==='replace_scope'&&targetState.reason==='target_exists'?null:targetState.reason),status:PreviewItem['status']=reason?(reason==='source_expired'||reason==='source_superseded'?'skipped':'conflict'):'ready';
   if(source.provenance.length>=20&&status==='ready'){reason='provenance_limit';status='conflict';}
   return {source_memory_id:source.memory_id,source_version:source.version,source_history_versions:source.history.map(row=>Number(row.version)),source_content:source.content,
    source_provenance:source.provenance,source_revision:source.source_revision,source_expires_at:source.expires_at,target_key:targetKey,target_expected_version:targetState.expected,status,reason,source_local:local.local};
  });
  return {schema_version:1,document_workspace_id:document.workspace_id,target,...(sourceBundle?{source_bundle:sourceBundle.summary}:{}),...(sourceFile?{source_file:sourceFile}:{}),
   ...(mode==='replace_scope'?{mode,replacement:this.replacement(owner,workspace,target)}:{}),counts:{total:items.length,ready:items.filter(item=>item.status==='ready').length,
   skipped:items.filter(item=>item.status==='skipped').length,conflict:items.filter(item=>item.status==='conflict').length},items};
 }
 preview(owner:string,workspace:string,input:Input,page?:ImportPage){return withImmediateTransaction(this.db,()=>{
  exact(input,['import_id','document','target','mode']);const importId=label(input.import_id,128);
  const requestedTarget=normalizeTarget(input.target),target=this.ports.authorizeTarget(owner,workspace,requestedTarget);
  if(JSON.stringify(target)!==JSON.stringify(requestedTarget))throw new Error('memory_scope_forbidden');
  if(input.mode!==undefined&&input.mode!=='append'&&input.mode!=='replace_scope')invalid();
  const mode=input.mode==='replace_scope'?'replace_scope' as const:undefined;
  const selected=fileSelection(input.document),sourceFile=selected?{...selected,workspace_id:workspace,project_id:target.project_id}:undefined;
  let material=input.document;
  if(sourceFile){
   const bytes=this.readFileSource(owner,workspace,target,sourceFile);
   try{material=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('invalid_memory_import_file_source');}
  }
  const imported=pilotdeckMemoryImport(material,JSON.stringify([workspace,target.project_id]),sourceFile?104_857_600:5_000_000,sourceFile?.sha256);
  if(mode&&!imported)invalid();
  if(mode&&!this.ports.remove)throw Error('memory_import_replace_unavailable');
  const document=normalizeDocument(imported?.document??material,imported?(sourceFile?400_000_000:160_000_000):5_000_000,imported?Number.MAX_SAFE_INTEGER:200);
  const sourceBundle:PilotdeckMemoryImportSource|undefined=imported?(sourceFile?{source_file:sourceFile,summary:imported.source.summary}:imported.source):undefined;
  const inputValue:Snapshot={document,target,...(sourceBundle?{source_bundle:sourceBundle}:{}),...(mode?{mode}:{}),...(sourceFile?{source_file:sourceFile}:{})};
  const inputJson=JSON.stringify(inputValue),inputHash=digest(inputValue),now=new Date().toISOString();
  const old=this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch|undefined;
  if(old){
   if(old.input_sha256!==inputHash||old.input_json!==inputJson)throw new Error('memory_import_id_conflict');
   if(old.status==='applied')return viewPage(previewView(old),page);
   const fresh=this.inspect(owner,workspace,target,document,inputValue.source_bundle,mode,sourceFile),freshJson=JSON.stringify(fresh);
   if(freshJson!==old.preview_json){this.db.prepare('UPDATE wb_memory_import_batches SET preview_json=?,version=version+1,updated_at=? WHERE owner_id=? AND workspace_id=? AND import_id=? AND status=\'previewed\'')
    .run(freshJson,now,owner,workspace,importId);}
   return viewPage(previewView(this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch),page);
  }
  const preview=this.inspect(owner,workspace,target,document,inputValue.source_bundle,mode,sourceFile);
  this.db.prepare(`INSERT INTO wb_memory_import_batches(owner_id,workspace_id,import_id,input_sha256,input_json,preview_json,version,status,receipt_json,created_at,updated_at)
   VALUES(?,?,?,?,?,?,1,'previewed',NULL,?,?)`).run(owner,workspace,importId,inputHash,inputJson,JSON.stringify(preview),now,now);
  return viewPage(previewView(this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch),page);
 });}
 get(owner:string,workspace:string,importId:string,page?:ImportPage){
  const row=this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch|undefined;
  if(!row)throw new Error('memory_import_not_found');const snapshot=JSON.parse(String(row.input_json)) as Snapshot;
  if(digest(snapshot)!==row.input_sha256)throw Error('memory_import_digest_conflict');
  const target=this.ports.authorizeTarget(owner,workspace,snapshot.target);if(JSON.stringify(target)!==JSON.stringify(snapshot.target))throw new Error('memory_scope_forbidden');
  const view=previewView(row);
  if(JSON.stringify(view.target)!==JSON.stringify(target)||view.mode!==snapshot.mode||JSON.stringify(view.source_file)!==JSON.stringify(snapshot.source_file))throw Error('memory_import_digest_conflict');
  if(view.replacement&&(view.replacement.count!==view.replacement.items.length||digest({target,items:view.replacement.items})!==view.replacement.scope_sha256))throw Error('memory_import_digest_conflict');
  return viewPage(view,page);
 }
 replacementSource(owner:string,workspace:string,importId:string,memoryId:string,expectedVersion:number){
  const view=this.get(owner,workspace,importId);
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)invalid();
  if(view.version!==expectedVersion)throw Error('memory_import_conflict');
  const item=(view.replacement?.items as Array<{memory_id:string;version:number;content_sha256:string;content_chars:number;verified:boolean;expires_at:string|null}>|undefined)
   ?.find(value=>value.memory_id===memoryId);
  if(!item)throw Error('memory_import_source_not_found');
  const row=this.db.prepare('SELECT snapshot_json FROM wb_memory_revisions WHERE owner_id=? AND memory_id=? AND version=?')
   .get(owner,memoryId,item.version) as {snapshot_json:string}|undefined;
  if(!row)throw Error('memory_import_digest_conflict');
  const memory=JSON.parse(row.snapshot_json) as Record<string,unknown>,target=view.target as Target;
  const content=memory.content;
  if(typeof content!=='string'||memory.memory_id!==memoryId||memory.version!==item.version||memory.workspace_id!==workspace
   ||memory.project_id!==target.project_id||memory.scope!==target.scope||memory.agent_id!==target.agent_id||memory.status!=='active'
   ||memory.verified!==item.verified||memory.expires_at!==item.expires_at||content.length!==item.content_chars
   ||createHash('sha256').update(content,'utf8').digest('hex')!==item.content_sha256)throw Error('memory_import_digest_conflict');
  return {import_id:importId,preview_version:expectedVersion,memory_id:memoryId,version:item.version,sha256:item.content_sha256,memory,execution_authorized:false as const};
 }
 source(owner:string,workspace:string,importId:string,history?:{section:WorkbenchMemoryImportHistorySection;offset:number;limit:number}){
  this.get(owner,workspace,importId);
  const row=this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch;
  const snapshot=JSON.parse(String(row.input_json)) as Snapshot;
  if(digest(snapshot)!==row.input_sha256)throw Error('memory_import_digest_conflict');
  const source=snapshot.source_bundle;
  if(snapshot.source_file){
   const bytes=this.readFileSource(owner,workspace,snapshot.target,snapshot.source_file);
   if(history){
    if(!source)throw Error('memory_import_bundle_not_found');
    let bundle:unknown;try{bundle=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('invalid_memory_import_file_source');}
    return {import_id:importId,input_sha256:String(row.input_sha256),sha256:source.summary.sha256,
     ...pilotdeckMemoryImportHistory(bundle,history.section,history.offset,history.limit),execution_authorized:false as const};
   }
   return {import_id:importId,input_sha256:String(row.input_sha256),sha256:source?.summary.sha256??snapshot.source_file.sha256,source_file:snapshot.source_file,execution_authorized:false as const};
  }
  if(!source||!('bundle' in source))throw Error('memory_import_bundle_not_found');
  if(digest(source.bundle)!==source.summary.sha256)throw Error('memory_import_digest_conflict');
  if(history)return {import_id:importId,input_sha256:String(row.input_sha256),sha256:source.summary.sha256,
   ...pilotdeckMemoryImportHistory(source.bundle,history.section,history.offset,history.limit),execution_authorized:false as const};
  return {import_id:importId,input_sha256:String(row.input_sha256),sha256:source.summary.sha256,bundle:source.bundle,execution_authorized:false as const};
 }
 apply(owner:string,workspace:string,input:Input,page?:ImportPage){return withImmediateTransaction(this.db,()=>{
  exact(input,['import_id','expected_version']);const importId=label(input.import_id,128);
  if(!Number.isSafeInteger(input.expected_version)||Number(input.expected_version)<1)invalid();
  const row=this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch|undefined;
  if(!row)throw new Error('memory_import_not_found');if(row.status==='applied')return receiptPage(JSON.parse(String(row.receipt_json)),page);
  if(Number(input.expected_version)!==Number(row.version))throw new Error('version_conflict');
  const snapshot=JSON.parse(String(row.input_json)) as Snapshot;
  if(digest(snapshot)!==row.input_sha256)throw new Error('memory_import_digest_conflict');
  const target=this.ports.authorizeTarget(owner,workspace,snapshot.target);if(JSON.stringify(target)!==JSON.stringify(snapshot.target))throw new Error('memory_scope_forbidden');
  if(snapshot.source_file)this.readFileSource(owner,workspace,target,snapshot.source_file);
  const fresh=this.inspect(owner,workspace,target,snapshot.document,snapshot.source_bundle,snapshot.mode,snapshot.source_file);
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
  const retired:Array<{memory_id:string;from_version:number;result_version:number;status:'deleted'}>=[];
  if(fresh.replacement){
   if(!this.ports.remove)throw Error('memory_import_replace_unavailable');
   for(const item of fresh.replacement.items){
    const removed=this.ports.remove(owner,workspace,item.memory_id,item.version);
    if(removed.memory_id!==item.memory_id||removed.status!=='deleted')throw Error('memory_import_write_conflict');
    const current=this.db.prepare(`SELECT m.version,m.status FROM wb_memories m JOIN wb_memory_revisions r ON r.memory_id=m.memory_id AND r.owner_id=m.owner_id AND r.version=m.version
     WHERE m.owner_id=? AND m.workspace_id=? AND m.memory_id=? AND json_extract(r.snapshot_json,'$.status')='deleted'`)
     .get(owner,workspace,item.memory_id) as MemoryRow|undefined;
    if(!current||current.status!=='deleted'||Number(current.version)!==item.version+1)throw Error('memory_import_write_conflict');
    retired.push({memory_id:item.memory_id,from_version:item.version,result_version:Number(current.version),status:'deleted'});
   }
  }
  const receipt={import_id:importId,status:'applied',version:Number(row.version),target,items:results,
   ...(snapshot.source_bundle?{source_bundle:snapshot.source_bundle.summary}:{}),...(snapshot.source_file?{source_file:snapshot.source_file}:{}),
   ...(fresh.replacement?{mode:'replace_scope',replacement:{scope_sha256:fresh.replacement.scope_sha256,count:retired.length,items:retired}}:{}),applied_at:new Date().toISOString()};
  const applied=this.db.prepare("UPDATE wb_memory_import_batches SET status='applied',receipt_json=?,updated_at=? WHERE owner_id=? AND workspace_id=? AND import_id=? AND status='previewed' AND version=?")
   .run(JSON.stringify(receipt),receipt.applied_at,owner,workspace,importId,Number(row.version));
  if(applied.changes!==1)throw Error('memory_import_conflict');
  return receiptPage(receipt,page);
 });}
}
