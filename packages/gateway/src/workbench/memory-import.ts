import {MemoryImportItems,importItemsManifest,importReplacementDigest,type ImportItemsBatch} from './memory-import-items.ts';
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
type Snapshot={target:Target;source_bundle?:PilotdeckMemoryImportSource;mode?:'replace_scope';source_file?:WorkbenchMemoryImportFileSource}
 &({document:ReturnType<typeof normalizeDocument>;document_source?:never}|{document?:never;document_source:'pilotdeck-v4-notes-v1'});

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
 const document=object(value);exact(document,['schema_version','workspace_id','exported_at','items']);
 const rawItems=document.items;if(document.schema_version!==1||!Array.isArray(rawItems)||rawItems.length>maxItems)invalid();
 const workspace_id=label(document.workspace_id),exported_at=label(document.exported_at,64);
 if(!Number.isFinite(Date.parse(exported_at)))invalid();
 // Count the exact original JSON size without forming one aggregate derived-document string.
 let characters:number;try{characters=JSON.stringify({...document,items:[]}).length;}catch{invalid();}
 if(characters>maxCharacters)invalid();
 const items:Source[]=[],ids=new Set<string>();
 for(const item of rawItems){
  const source=normalizeSource(item,workspace_id);if(ids.has(source.memory_id))invalid();
  let encoded:string|undefined;try{encoded=JSON.stringify(item);}catch{invalid();}
  if(typeof encoded!=='string')invalid();characters+=encoded.length+(items.length?1:0);
  if(characters>maxCharacters)invalid();ids.add(source.memory_id);items.push(source);
 }
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
 return {...receipt,...pageItems(receipt.items as Input[],page),...(receipt.replacement?{replacement:{...receipt.replacement,...pageItems(receipt.replacement.items,page)}}:{}),totals:{total:receipt.items.length,created:receipt.items.filter((item:Input)=>item.status==='created').length,skipped:receipt.items.filter((item:Input)=>item.status==='skipped').length}};
}
function viewPage(view:any,page?:ImportPage){
 if(!page)return view;
 return {...view,...pageItems(view.items as Input[],page),...(view.replacement?{replacement:{...view.replacement,...pageItems(view.replacement.items,page)}}:{}),...(view.receipt?{receipt:receiptPage(view.receipt,page)}:{})};
}
function samePreview(preview:{items:PreviewItem[]},encoded:string){
 // The original preview shape ends with items. Compare its exact JSON without a second aggregate string.
 const {items,...header}=preview,prefix=JSON.stringify(header).slice(0,-1)+',"items":[';
 if(!encoded.startsWith(prefix))return false;
 let offset=prefix.length;
 for(let index=0;index<items.length;index++){
  const part=(index?',':'')+JSON.stringify(items[index]);
  if(!encoded.startsWith(part,offset))return false;offset+=part.length;
 }
 return encoded.length===offset+2&&encoded.startsWith(']}',offset);
}

/** Durable import previews and idempotent writes over the existing Jot memory authority. */
export class MemoryImportService{
 private readonly db:DatabaseSync;private readonly ports:Ports;private readonly storedItems:MemoryImportItems;
 constructor(db:DatabaseSync,ports:Ports){this.db=db;this.ports=ports;
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_memory_import_batches'").get())throw new Error('memory_import_schema_required');
  this.storedItems=new MemoryImportItems(db);
 }
 private batch(owner:string,workspace:string,row:Batch):ImportItemsBatch{return {owner,workspace,importId:String(row.import_id),version:Number(row.version)};}
 private packItems(value:any,receipt=false,splitReplacement=true){
  let created=0,skipped=0;
  if(receipt)for(const item of value.items){if(item.status==='created')created++;if(item.status==='skipped')skipped++;}
  return {...value,items:[],items_storage:{...importItemsManifest(value.items),...(receipt?{totals:{total:value.items.length,created,skipped}}:{})},
   ...(splitReplacement&&value.replacement?{replacement:{...value.replacement,items:[],items_storage:importItemsManifest(value.replacement.items)}}:{})};
 }
 private writeItems(batch:ImportItemsBatch,receipt:boolean,value:any,stored:any){
  const phase=receipt?'receipt':'preview';
  this.storedItems.write(batch,phase,value.items,stored.items_storage);
  if(stored.replacement?.items_storage)this.storedItems.write(batch,phase,value.replacement.items,stored.replacement.items_storage,true);
 }
 private payload(owner:string,workspace:string,row:Batch,receipt:boolean,page?:ImportPage){
  const value=JSON.parse(String(receipt?row.receipt_json:row.preview_json));
  if(!receipt&&value.replacement&&!value.replacement.items_storage
   &&(value.replacement.count!==value.replacement.items.length||importReplacementDigest(value.target,value.replacement.items)!==value.replacement.scope_sha256))throw Error('memory_import_digest_conflict');
  if(!value.items_storage)return receipt?receiptPage(value,page):viewPage(value,page);
  if(page)pageItems([],page);
  const {items_storage:storage,...result}=value,range=page??{offset:0,limit:storage.count};
  if(!Array.isArray(value.items)||value.items.length||!receipt&&value.counts?.total!==storage.count)throw Error('memory_import_digest_conflict');
  const items=this.storedItems.read(this.batch(owner,workspace,row),receipt?'receipt':'preview',storage,range);
  const next=range.offset+items.length;
  if(result.replacement?.items_storage){
   const {items_storage:replacementStorage,...replacement}=result.replacement;
   if(!Array.isArray(replacement.items)||replacement.items.length||replacement.count!==replacementStorage.count)throw Error('memory_import_digest_conflict');
   const replacementItems=this.storedItems.read(this.batch(owner,workspace,row),receipt?'receipt':'preview',replacementStorage,
    page??{offset:0,limit:replacementStorage.count},true,receipt?undefined:{target:value.target,sha256:replacement.scope_sha256});
   const end=(page?.offset??0)+replacementItems.length;
   result.replacement={...replacement,items:replacementItems,...(page?{page:{offset:page.offset,limit:page.limit,total:replacementStorage.count,next_offset:end<replacementStorage.count?end:null}}:{})};
  }
  else if(result.replacement&&page)result.replacement={...result.replacement,...pageItems(result.replacement.items,page)};
  if(receipt&&(!storage.totals||storage.totals.total!==storage.count||!Number.isSafeInteger(storage.totals.created)
   ||storage.totals.created<0||!Number.isSafeInteger(storage.totals.skipped)||storage.totals.skipped<0
   ||storage.totals.created+storage.totals.skipped!==storage.count))throw Error('memory_import_digest_conflict');
  return {...result,items,...(page?{page:{offset:page.offset,limit:page.limit,total:storage.count,next_offset:next<storage.count?next:null},
   ...(receipt?{totals:storage.totals}:{})}:{})};
 }
 private view(owner:string,workspace:string,row:Batch,page?:ImportPage){
  return {...this.payload(owner,workspace,row,false,page),import_id:String(row.import_id),input_sha256:String(row.input_sha256),version:Number(row.version),
   status:String(row.status),created_at:String(row.created_at),updated_at:String(row.updated_at),
   ...(row.receipt_json===null?{}:{receipt:this.payload(owner,workspace,row,true,page)})};
 }
 private matchesPreview(owner:string,workspace:string,row:Batch,fresh:any){
  const projected=this.db.prepare("SELECT json_extract(preview_json,'$.items_storage') AS storage,json_extract(preview_json,'$.replacement.items_storage') AS replacement_storage FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=? AND version=?")
   .get(owner,workspace,String(row.import_id),Number(row.version)) as {storage:string|null;replacement_storage:string|null}|undefined;
  if(!projected)throw Error('memory_import_conflict');
  if(projected.storage===null)return samePreview(fresh,String(row.preview_json));
  if(JSON.stringify(this.packItems(fresh,false,projected.replacement_storage!==null))!==row.preview_json)return false;
  this.storedItems.read(this.batch(owner,workspace,row),'preview',JSON.parse(projected.storage));
  if(projected.replacement_storage!==null)this.storedItems.read(this.batch(owner,workspace,row),'preview',JSON.parse(projected.replacement_storage),undefined,true);
  return true;
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
 private readDocument(owner:string,workspace:string,snapshot:Snapshot){
  const bytes=snapshot.source_file?this.readFileSource(owner,workspace,snapshot.target,snapshot.source_file):undefined;
  if(snapshot.document_source===undefined){if(!snapshot.document)throw Error('memory_import_digest_conflict');return snapshot.document;}
  if(snapshot.document_source!=='pilotdeck-v4-notes-v1'||snapshot.document||!snapshot.source_bundle)throw Error('memory_import_digest_conflict');
  let material:unknown;
  if(bytes){
   try{material=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('invalid_memory_import_file_source');}
  }else{
   const source=snapshot.source_bundle;
   if(!('bundle' in source)||digest(source.bundle)!==source.summary.sha256)throw Error('memory_import_digest_conflict');
   material=source.bundle;
  }
  const imported=pilotdeckMemoryImport(material,JSON.stringify([workspace,snapshot.target.project_id]),snapshot.source_file?104_857_600:5_000_000,snapshot.source_file?.sha256);
  if(!imported||JSON.stringify(imported.source.summary)!==JSON.stringify(snapshot.source_bundle.summary))throw Error('memory_import_digest_conflict');
  return normalizeDocument(imported.document,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);
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
  return {scope_sha256:importReplacementDigest(target,items),count:items.length,items};
 }
 private targetStates(owner:string,workspace:string,target:Target){
  const scope=[owner,workspace,target.project_id,target.scope,target.agent_id];
  const stored=this.db.prepare(`SELECT import_id,version,json_extract(receipt_json,'$.replacement.items_storage') AS storage
   FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND status='applied' AND json_extract(receipt_json,'$.mode')='replace_scope'
   AND json_extract(receipt_json,'$.target.project_id')=? AND json_extract(receipt_json,'$.target.scope')=? AND json_extract(receipt_json,'$.target.agent_id') IS ?
   AND json_type(receipt_json,'$.replacement.items_storage') IS NOT NULL`).iterate(...scope) as Iterable<{import_id:string;version:number;storage:string}>;
  for(const batch of stored)this.storedItems.read({owner,workspace,importId:batch.import_id,version:batch.version},'receipt',JSON.parse(batch.storage),undefined,true);
  const retirements=this.db.prepare(`SELECT json_extract(item.value,'$.memory_id') AS memory_id,json_extract(item.value,'$.result_version') AS version
   FROM wb_memory_import_batches b JOIN json_each(b.receipt_json,'$.replacement.items') item
   WHERE b.owner_id=? AND b.workspace_id=? AND b.status='applied' AND json_extract(b.receipt_json,'$.mode')='replace_scope'
   AND json_extract(b.receipt_json,'$.target.project_id')=? AND json_extract(b.receipt_json,'$.target.scope')=? AND json_extract(b.receipt_json,'$.target.agent_id') IS ?
   AND json_extract(item.value,'$.status')='deleted'
   UNION ALL
   SELECT json_extract(i.item_json,'$.memory_id'),json_extract(i.item_json,'$.result_version')
   FROM wb_memory_import_batches b JOIN wb_memory_import_replacement_items i
    ON i.owner_id=b.owner_id AND i.workspace_id=b.workspace_id AND i.import_id=b.import_id AND i.preview_version=b.version AND i.phase='receipt'
   WHERE b.owner_id=? AND b.workspace_id=? AND b.status='applied' AND json_extract(b.receipt_json,'$.mode')='replace_scope'
   AND json_extract(b.receipt_json,'$.target.project_id')=? AND json_extract(b.receipt_json,'$.target.scope')=? AND json_extract(b.receipt_json,'$.target.agent_id') IS ?
   AND json_extract(b.receipt_json,'$.replacement.items_storage.kind')='original-memory-import-items-v1'
   AND json_extract(i.item_json,'$.status')='deleted'`).iterate(...scope,...scope) as Iterable<MemoryRow>;
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
  const old=this.db.prepare("SELECT *,json_extract(input_json,'$.document_source') AS document_source FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?").get(owner,workspace,importId) as Batch|undefined;
  const selected=fileSelection(input.document),sourceFile=selected?{...selected,workspace_id:workspace,project_id:target.project_id}:undefined;
  let material=input.document;
  if(sourceFile){
   const bytes=this.readFileSource(owner,workspace,target,sourceFile);
   try{material=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('invalid_memory_import_file_source');}
  }
  const imported=pilotdeckMemoryImport(material,JSON.stringify([workspace,target.project_id]),sourceFile?104_857_600:5_000_000,sourceFile?.sha256);
  if(mode&&!imported)invalid();
  if(mode&&!this.ports.remove)throw Error('memory_import_replace_unavailable');
  // Preserve old immutable document captures and their original hashes on refresh/retry.
  const compact=!!imported&&(!old||old.document_source==='pilotdeck-v4-notes-v1');
  const document=normalizeDocument(imported?.document??material,imported?(compact?Number.MAX_SAFE_INTEGER:sourceFile?400_000_000:160_000_000):5_000_000,imported?Number.MAX_SAFE_INTEGER:200);
  const sourceBundle:PilotdeckMemoryImportSource|undefined=imported?(sourceFile?{source_file:sourceFile,summary:imported.source.summary}:imported.source):undefined;
  const inputValue:Snapshot={...(compact?{document_source:'pilotdeck-v4-notes-v1' as const}:{document}),target,...(sourceBundle?{source_bundle:sourceBundle}:{}),...(mode?{mode}:{}),...(sourceFile?{source_file:sourceFile}:{})};
  const inputJson=JSON.stringify(inputValue),inputHash=createHash('sha256').update(inputJson,'utf8').digest('hex'),now=new Date().toISOString();
  if(old){
   if(old.input_sha256!==inputHash||old.input_json!==inputJson)throw new Error('memory_import_id_conflict');
   if(old.status==='applied')return this.view(owner,workspace,old,page);
   const fresh=this.inspect(owner,workspace,target,document,inputValue.source_bundle,mode,sourceFile);
   if(!this.matchesPreview(owner,workspace,old,fresh)){
    const stored=compact?this.packItems(fresh):fresh;
    const changed=this.db.prepare("UPDATE wb_memory_import_batches SET preview_json=?,version=version+1,updated_at=? WHERE owner_id=? AND workspace_id=? AND import_id=? AND status='previewed' AND version=?")
     .run(JSON.stringify(stored),now,owner,workspace,importId,Number(old.version));
    if(changed.changes!==1)throw Error('memory_import_conflict');
    if(compact)this.writeItems({owner,workspace,importId,version:Number(old.version)+1},false,fresh,stored);
   }
   return this.view(owner,workspace,this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch,page);
  }
  const preview=this.inspect(owner,workspace,target,document,inputValue.source_bundle,mode,sourceFile),stored=compact?this.packItems(preview):preview;
  this.db.prepare(`INSERT INTO wb_memory_import_batches(owner_id,workspace_id,import_id,input_sha256,input_json,preview_json,version,status,receipt_json,created_at,updated_at)
   VALUES(?,?,?,?,?,?,1,'previewed',NULL,?,?)`).run(owner,workspace,importId,inputHash,inputJson,JSON.stringify(stored),now,now);
  if(compact)this.writeItems({owner,workspace,importId,version:1},false,preview,stored);
  return this.view(owner,workspace,this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch,page);
 });}
 get(owner:string,workspace:string,importId:string,page?:ImportPage){
  const row=this.db.prepare('SELECT * FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=?').get(owner,workspace,importId) as Batch|undefined;
  if(!row)throw new Error('memory_import_not_found');const snapshot=JSON.parse(String(row.input_json)) as Snapshot;
  if(digest(snapshot)!==row.input_sha256)throw Error('memory_import_digest_conflict');
  const target=this.ports.authorizeTarget(owner,workspace,snapshot.target);if(JSON.stringify(target)!==JSON.stringify(snapshot.target))throw new Error('memory_scope_forbidden');
  const view=this.view(owner,workspace,row,page);
  if(JSON.stringify(view.target)!==JSON.stringify(target)||view.mode!==snapshot.mode||JSON.stringify(view.source_file)!==JSON.stringify(snapshot.source_file))throw Error('memory_import_digest_conflict');
  return view;
 }
 replacementSource(owner:string,workspace:string,importId:string,memoryId:string,expectedVersion:number){
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)invalid();
  const captured=this.db.prepare("SELECT json_type(preview_json,'$.replacement.items_storage') IS NOT NULL AS split FROM wb_memory_import_batches WHERE owner_id=? AND workspace_id=? AND import_id=? AND version=?")
   .get(owner,workspace,importId,expectedVersion) as {split:number}|undefined;
  let page:ImportPage|undefined;
  if(captured?.split){
   const item=this.db.prepare("SELECT position FROM wb_memory_import_replacement_items WHERE owner_id=? AND workspace_id=? AND import_id=? AND preview_version=? AND phase='preview' AND json_extract(item_json,'$.memory_id')=? LIMIT 1")
    .get(owner,workspace,importId,expectedVersion,memoryId) as {position:number}|undefined;
   page={offset:item?.position??0,limit:1};
  }
  const view=this.get(owner,workspace,importId,page);
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
  this.get(owner,workspace,importId,{offset:0,limit:1});
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
  if(!row)throw new Error('memory_import_not_found');if(row.status==='applied')return this.payload(owner,workspace,row,true,page);
  if(Number(input.expected_version)!==Number(row.version))throw new Error('version_conflict');
  const snapshot=JSON.parse(String(row.input_json)) as Snapshot;
  if(digest(snapshot)!==row.input_sha256)throw new Error('memory_import_digest_conflict');
  const target=this.ports.authorizeTarget(owner,workspace,snapshot.target);if(JSON.stringify(target)!==JSON.stringify(snapshot.target))throw new Error('memory_scope_forbidden');
  const document=this.readDocument(owner,workspace,snapshot);
  const fresh=this.inspect(owner,workspace,target,document,snapshot.source_bundle,snapshot.mode,snapshot.source_file);
  if(fresh.counts.conflict||!this.matchesPreview(owner,workspace,row,fresh))throw new Error('memory_import_conflict');
  const results:Input[]=[];
  for(const [index,item] of fresh.items.entries()){
   if(item.status==='skipped'){results.push({...item});continue;}
   const source=document.items[index];
   if(!source||source.memory_id!==item.source_memory_id)throw Error('memory_import_digest_conflict');
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
  const stored=snapshot.document_source?this.packItems(receipt,true):receipt;
  if(snapshot.document_source)this.writeItems(this.batch(owner,workspace,row),true,receipt,stored);
  const applied=this.db.prepare("UPDATE wb_memory_import_batches SET status='applied',receipt_json=?,updated_at=? WHERE owner_id=? AND workspace_id=? AND import_id=? AND status='previewed' AND version=?")
   .run(JSON.stringify(stored),receipt.applied_at,owner,workspace,importId,Number(row.version));
  if(applied.changes!==1)throw Error('memory_import_conflict');
  return receiptPage(receipt,page);
 });}
}
