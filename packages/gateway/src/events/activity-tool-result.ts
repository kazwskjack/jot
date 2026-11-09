import {readRetainedArtifactTextPage,createTextPageCollector} from '../artifacts/text-content.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {readIsolatedTaskFileVersion,readIsolatedTaskFileDeletion,isolatedBaselineSource} from '../persistent-tasks/isolated-output-source.ts';
import type {TaskFileSource} from '../persistent-tasks/task-file-source.ts';
import {formatTextDiff} from '../artifacts/text-diff.ts';
import type {WorkbenchService} from '../workbench/service.ts';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {readActivityHistory} from './activity-history.ts';
import type {ActivityToolResultPage,ActivityToolResultSearchPage,ActivityToolResultMatch,ActivityToolResultFile,ActivityToolFilePage,ActivityToolFileBytes} from '../../contracts/types.js';

const ID=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const SHA=/^[a-f0-9]{64}$/;
const PAGE_SIZE=16384;
const MAX_MCP_RESULT_BYTES=524288;
// A 1 MiB file can expand sixfold inside its saved JSON envelope.
const MAX_WORKSPACE_RESULT_BYTES=8*1024*1024;
const MAX_TEXT_CHARS=1048576;
const MAX_RESULT_TEXT_CHARS=6*1048576;
type IsolatedFileSource=Extract<TaskFileSource,{source:'isolated'}>;
type IsolatedMutationSource=Omit<IsolatedFileSource,'source'|'native'|'sha256'>&{sha256:string|null};
type WorkspaceFileReader=Pick<WorkbenchService,'readBinaryFile'>;
type TextSource=Pick<ActivityToolResultPage,'source'|'text'|'result_sha256'|'has_other_content'|'operation'|'source_truncated'|'file_diff_state'|'file_links'>;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function object(value:unknown):Record<string,unknown>|undefined{
 return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}
function parsedObject(text:string){
 try{return object(JSON.parse(text));}catch{throw Error('activity_tool_result_source_invalid');}
}

function readMcpText(db:DatabaseSync,owner:string,runId:string,name:string,callId:string):TextSource{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_mcp_operations'").get())throw Error('activity_tool_result_not_found');
 // Match the shared public ID normalization, and reject colliding original calls.
 const rows=db.prepare(`SELECT o.state,o.result_hash,
  CASE WHEN length(CAST(o.response_json AS BLOB))<=? THEN o.response_json END response_json,
  e.result_hash receipt_hash FROM wb_mcp_operations o
  LEFT JOIN wb_task_execution_receipts e ON e.run_id=o.run_id AND e.call_id=o.call_id AND e.operation=o.public_name
  WHERE o.owner_id=? AND o.run_id=? AND o.public_name=? AND substr(replace(o.call_id,'.','-'),1,128)=? LIMIT 2`)
  .all(MAX_MCP_RESULT_BYTES,owner,runId,name,callId) as Array<{state:string;result_hash:string|null;response_json:string|null;receipt_hash:string|null}>;
 if(rows.length===0)throw Error('activity_tool_result_not_found');
 if(rows.length!==1)throw Error('activity_tool_result_source_invalid');
 const source=rows[0]!;
 if(source.state!=='settled')throw Error('activity_tool_result_pending');
 if(!source.response_json||!source.result_hash||!SHA.test(source.result_hash)
  ||source.receipt_hash!==source.result_hash||hash(source.response_json)!==source.result_hash)throw Error('activity_tool_result_source_invalid');
 const result=parsedObject(source.response_json);
 if(!result||!Array.isArray(result.content))throw Error('activity_tool_result_source_invalid');
 const parts:string[]=[];
 let otherContent=false;
 for(const block of result.content){
  const value=object(block);
  if(value?.type==='text'&&typeof value.text==='string')parts.push(value.text);
  else otherContent=true;
 }
 return {source:'mcp',text:parts.join('\n'),result_sha256:source.result_hash,has_other_content:otherContent};
}

/** The immutable journal supplies an actual preimage only for a prior retained write. */
function isolatedMutationSummary(db:DatabaseSync,owner:string,runId:string,receiptId:string,result:Record<string,unknown>,kind:'files.write'|'files.delete'){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_isolated_file_execution_receipts'").get())throw Error('activity_tool_result_not_found');
 const read=(source:IsolatedFileSource)=>{
  try{return readIsolatedTaskFileVersion(db,{...source,source:'isolated',native:Boolean(source.native)});}
  catch{throw Error('activity_tool_result_source_invalid');}
 };
 const readDeletion=(isolatedId:string)=>{
  try{return readIsolatedTaskFileDeletion(db,owner,isolatedId);}
  catch{throw Error('activity_tool_result_source_invalid');}
 };
 let file:IsolatedMutationSource,afterText:string;
 if(kind==='files.delete'){
  if(typeof result.receipt_id!=='string')throw Error('activity_tool_result_source_invalid');
  const deletion=readDeletion(result.receipt_id);
  if(deletion.receipt_id!==receiptId||deletion.run_id!==runId)throw Error('activity_tool_result_source_invalid');
  file={...deletion,sha256:null,size:0};afterText='';
 }else{
  const source=db.prepare(`SELECT e.*,r.conversation_id,b.kind='native_team' AS native FROM wb_task_isolated_file_execution_receipts e
   JOIN wb_run_bindings b ON b.run_id=e.run_id AND b.owner_id=e.owner_id
   JOIN ga_runs r ON r.id=e.run_id JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=e.owner_id
   WHERE e.receipt_id=? AND e.run_id=? AND e.owner_id=?`).get(receiptId,runId,owner) as IsolatedFileSource|undefined;
  if(!source||result.receipt_id!==source.isolated_receipt_id
   ||result.path!==source.path||result.version!==source.version||result.sha256!==source.sha256||result.size!==source.size
   ||!Number.isSafeInteger(source.size)||source.size<0||source.size>MAX_TEXT_CHARS)throw Error('activity_tool_result_source_invalid');
  file=source;afterText=read(source).content;
 }
 const intent=db.prepare(`SELECT i.before_json,i.operation_json FROM wb_isolated_file_intents i
  JOIN wb_isolated_file_results r ON r.call_key=i.call_key WHERE r.receipt_id=?`).get(result.receipt_id as string) as {before_json:string;operation_json:string}|undefined;
 if(!intent)throw Error('activity_tool_result_source_invalid');
 let inventory:unknown,operation:Record<string,unknown>|undefined;
 try{inventory=JSON.parse(intent.before_json);operation=object(JSON.parse(intent.operation_json));}catch{throw Error('activity_tool_result_source_invalid');}
 if(!Array.isArray(inventory)||canonicalJson(inventory)!==intent.before_json||!operation
  ||!Number.isSafeInteger(operation.expected_version)||Number(operation.expected_version)<0
  ||Number(operation.expected_version)+1!==file.version)throw Error('activity_tool_result_source_invalid');
 const entries=inventory as unknown[];
 if(entries.some(entry=>!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||!object(entry[1]))
  ||new Set(entries.map(entry=>(entry as unknown[])[0])).size!==entries.length)throw Error('activity_tool_result_source_invalid');
 const initial=object((entries.find(entry=>(entry as unknown[])[0]===file.path) as unknown[]|undefined)?.[1]);
 const beforeVersion=Number(operation.expected_version);
 const previous=db.prepare(`SELECT version,sha256,receipt_id FROM wb_isolated_file_results
  WHERE cycle_id=? AND snapshot_id=? AND path=? AND version<? ORDER BY version DESC LIMIT 1`)
  .get(result.cycle_id as string,result.snapshot_id as string,file.path,file.version) as {version:number;sha256:string|null;receipt_id:string}|undefined;
 if((previous?.version??0)!==beforeVersion)throw Error('activity_tool_result_source_invalid');
 const lines=[kind==='files.delete'?'已记录的隔离文件删除':'已记录的隔离文件写入',`逻辑路径 ${file.path}`,`操作版本 ${file.version}`,
  ...(file.sha256?[`写入摘要 ${file.sha256}`,`字节数 ${file.size}`]:['操作后状态 文件不存在'])];
 let beforeText='',beforeLabel='absent';
 if(initial){
  if(initial.kind!=='file'||typeof initial.identity!=='string'||!initial.identity||typeof initial.sha256!=='string'||!SHA.test(initial.sha256)||!Number.isSafeInteger(initial.size)||Number(initial.size)<0)throw Error('activity_tool_result_source_invalid');
  if(!previous){lines.push(`写入前摘要 ${initial.sha256}`,'写入前原文 快照日志未留存');return {text:lines.join('\n'),file_diff_state:'base_unrecorded' as const};}
  if(previous.sha256!==initial.sha256)throw Error('activity_tool_result_source_invalid');
  const prior=db.prepare(`SELECT e.*,r.conversation_id,b.kind='native_team' AS native FROM wb_task_isolated_file_execution_receipts e
   JOIN wb_run_bindings b ON b.run_id=e.run_id AND b.owner_id=e.owner_id
   JOIN ga_runs r ON r.id=e.run_id JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=e.owner_id
   WHERE e.owner_id=? AND e.workspace_id=? AND e.project_id=? AND e.task_id=? AND e.occurrence_id=?
    AND e.cycle_id=? AND e.snapshot_id=? AND e.path=? AND e.version=? AND e.sha256=? AND e.size=?`)
   .get(owner,file.workspace_id,file.project_id,file.task_id,file.occurrence_id,result.cycle_id as string,result.snapshot_id as string,file.path,beforeVersion,initial.sha256,Number(initial.size)) as IsolatedFileSource|undefined;
  if(!prior||prior.size>MAX_TEXT_CHARS)throw Error('activity_tool_result_source_invalid');
  beforeText=read(prior).content;beforeLabel=`version-${beforeVersion}`;
  lines.push(`写入前版本 ${beforeVersion}`,`写入前摘要 ${initial.sha256}`);
 }else{
  if(previous?.sha256!==undefined&&previous.sha256!==null)throw Error('activity_tool_result_source_invalid');
  if(kind==='files.delete')throw Error('activity_tool_result_source_invalid');
  if(previous){
   const deletion=readDeletion(previous.receipt_id);
   for(const key of ['owner_id','workspace_id','project_id','task_id','occurrence_id','cycle_id','snapshot_id','path'] as const){
    if(deletion[key]!==file[key])throw Error('activity_tool_result_source_invalid');
   }
   if(deletion.version!==beforeVersion)throw Error('activity_tool_result_source_invalid');
   lines.push(`写入前版本 ${beforeVersion}`,`原删除回执 ${deletion.receipt_id}`);
  }
  lines.push('写入前状态 隔离逻辑路径不存在');
 }
 const diff=formatTextDiff(beforeText,afterText,beforeLabel,kind==='files.delete'?'absent':`version-${file.version}`);
 return {text:lines.join('\n')+'\n\n原始文件差异\n'+diff,file_diff_state:'available' as const};
}

function writeSummary(db:DatabaseSync,owner:string,runId:string,receiptId:string,result:Record<string,unknown>,reader?:WorkspaceFileReader){
 if(result.source==='isolated')return isolatedMutationSummary(db,owner,runId,receiptId,result,'files.write');
 if(result.source!==undefined&&result.source!=='workspace')throw Error('activity_tool_result_not_found');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_file_execution_receipts'").get())throw Error('activity_tool_result_not_found');
 const file=db.prepare(`SELECT f.workspace_id,f.project_id,f.path,f.version,f.sha256,f.size FROM wb_task_file_execution_receipts f
  JOIN wb_file_write_runs w ON w.run_id=f.run_id AND w.owner_id=f.owner_id AND w.workspace_id=f.workspace_id AND w.project_id=f.project_id
   AND w.path=f.path AND w.version=f.version AND w.sha256=f.sha256 AND w.size=f.size
  JOIN wb_file_versions v ON v.owner_id=f.owner_id AND v.workspace_id=f.workspace_id AND v.project_id=f.project_id
   AND v.path=f.path AND v.version=f.version AND v.sha256=f.sha256 AND v.size=f.size
  WHERE f.receipt_id=? AND f.run_id=? AND f.owner_id=?`).get(receiptId,runId,owner) as
  {workspace_id:string;project_id:string;path:string;version:number;sha256:string;size:number}|undefined;
 if(!file||result.path!==file.path||result.version!==file.version||result.sha256!==file.sha256||result.size!==file.size||!Number.isSafeInteger(file.size)||file.size<0)throw Error('activity_tool_result_source_invalid');
 const lines=['已记录的文件写入',`逻辑路径 ${file.path}`,`写入版本 ${file.version}`,`写入摘要 ${file.sha256}`,`字节数 ${file.size}`];
 if(result.before_version===undefined){lines.push('写入前版本 尚无原始回执');return {text:lines.join('\n'),file_diff_state:'base_unrecorded' as const};}
 const before=result.before_version;
 let beforeSize=0;
 if(!Number.isSafeInteger(before)||Number(before)<0||Number(before)>=file.version)throw Error('activity_tool_result_source_invalid');
 if(before===0){
  if(result.before_sha256!==undefined)throw Error('activity_tool_result_source_invalid');
  lines.push('写入前状态 逻辑路径不存在');
 }else{
  const source=db.prepare(`SELECT sha256,size FROM wb_file_versions WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=? AND version=?`)
   .get(owner,file.workspace_id,file.project_id,file.path,Number(before)) as {sha256:string;size:number}|undefined;
  if(!source||typeof result.before_sha256!=='string'||!SHA.test(result.before_sha256)||source.sha256!==result.before_sha256)throw Error('activity_tool_result_source_invalid');
  beforeSize=source.size;
  lines.push(`写入前版本 ${before}`,`写入前摘要 ${source.sha256}`);
 }
 if(!reader)return {text:lines.join('\n'),file_diff_state:'content_unavailable' as const};
 // shortcut: compare at most 1 MiB per original file, extend alongside large-file difference support.
 if(!Number.isSafeInteger(beforeSize)||beforeSize<0||beforeSize>MAX_TEXT_CHARS||file.size>MAX_TEXT_CHARS){
  lines.push('原始差异 两个来源需在 1 MiB 文本差异范围内');
  return {text:lines.join('\n'),file_diff_state:'preview_limit' as const};
 }
 let left:Buffer,right:Buffer;
 try{
  left=before===0?Buffer.alloc(0):reader.readBinaryFile(owner,file.workspace_id,file.project_id,file.path,Number(before),String(result.before_sha256)).content;
  right=reader.readBinaryFile(owner,file.workspace_id,file.project_id,file.path,file.version,file.sha256).content;
 }catch(error){
  if(!(error instanceof Error)||!['file_not_found','file_integrity_failed','file_source_stale'].includes(error.message))throw error;
  lines.push('原始差异 固定版本内容暂不可用或校验失败');
  return {text:lines.join('\n'),file_diff_state:'content_unavailable' as const};
 }
 try{new TextDecoder('utf-8',{fatal:true}).decode(left);new TextDecoder('utf-8',{fatal:true}).decode(right);}catch{
  lines.push('原始差异 来源包含非 UTF-8 文本内容');
  return {text:lines.join('\n'),file_diff_state:'non_text' as const};
 }
 const diff=formatTextDiff(left.toString('utf8'),right.toString('utf8'),before===0?'absent':`version-${before}`,`version-${file.version}`);
 return {text:lines.join('\n')+'\n\n原始写入差异\n'+diff,file_diff_state:'available' as const};
}

/** Select only the declared logical file facts from the original saved page. */
function fileListFacts(result:Record<string,unknown>){
 const isolated=result.source==='isolated';
 if(result.source!==undefined&&result.source!=='workspace'&&!isolated)throw Error('activity_tool_result_not_found');
 const files=isolated?result.files:result.items,deleted=isolated?(result.deleted_files??[]):[];
 if(!Array.isArray(files)||files.length>100000||!Array.isArray(deleted)||deleted.length>100000
  ||!isolated&&result.next_cursor!==undefined&&result.next_cursor!==null&&(typeof result.next_cursor!=='string'||!result.next_cursor||result.next_cursor.length>2048))throw Error('activity_tool_result_source_invalid');
 const paths=new Set<string>();
 const path=(value:unknown)=>{
  if(typeof value!=='string'||!value||value.length>(isolated?4096:400)||value.startsWith('/')||/[\\:\x00-\x1f\x7f]/.test(value)
   ||value.split('/').some(part=>!part||part==='.'||part==='..')||paths.has(value))throw Error('activity_tool_result_source_invalid');
  paths.add(value);return value;
 };
 const items=files.map(item=>{
  const file=object(item);
  if(!file||!Number.isSafeInteger(file.version)||Number(file.version)<(isolated?0:1)||!Number.isSafeInteger(file.size)||Number(file.size)<0
   ||typeof file.sha256!=='string'||!SHA.test(file.sha256))throw Error('activity_tool_result_source_invalid');
  return {path:path(file.path),version:Number(file.version),size:Number(file.size),sha256:file.sha256};
 });
 const removed=deleted.map(item=>{
  const file=object(item);
  if(!file||!Number.isSafeInteger(file.version)||Number(file.version)<1)throw Error('activity_tool_result_source_invalid');
  return {path:path(file.path),version:Number(file.version)};
 });
 return {isolated,items,removed,more:!isolated&&typeof result.next_cursor==='string'};
}
function fileListSummary(result:Record<string,unknown>){
 const facts=fileListFacts(result);
 const lines=[facts.isolated?'原隔离工作区文件列表':'原工作区文件列表',`已留存文件数 ${facts.items.length}`,`已留存删除记录数 ${facts.removed.length}`];
 const links:ActivityToolResultFile[]=[];let length=lines.join('\n').length,clipped=false;
 // shortcut: list text uses the existing 6 MiB range, extend source paging for larger original receipts.
 const append=(text:string)=>{
  if(clipped)return;
  if(length+text.length+1>MAX_RESULT_TEXT_CHARS){clipped=true;return;}
  const offset=length+1;lines.push(text);length+=text.length+1;
  return {offset_chars:offset,end_offset_chars:length};
 };
 for(const file of facts.items){
  const range=append(`${file.path}\n版本 ${file.version}${facts.isolated&&file.version===0?'（原快照内容）':''} · 字节数 ${file.size}\nSHA-256 ${file.sha256}`);
  if(range)links.push({...file,...range});
 }
 for(const file of facts.removed)append(`${file.path}\n删除版本 ${file.version}`);
 const truncated=clipped||facts.more;
 if(truncated)append('原列表含后续页面或超出当前显示范围。');
 return {text:lines.join('\n'),truncated,links};
}

function readWorkspaceReceipt(db:DatabaseSync,owner:string,runId:string,callId:string):{operation:NonNullable<ActivityToolResultPage['operation']>;receiptId:string;resultSha:string;result:Record<string,unknown>}{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_tool_receipts'").get())throw Error('activity_tool_result_not_found');
 const rows=db.prepare(`SELECT e.operation,e.receipt_id,e.result_hash,
  CASE WHEN length(CAST(w.response_json AS BLOB))<=? THEN w.response_json END response_json
  FROM wb_tool_receipts w JOIN wb_run_bindings b ON b.run_id=w.run_id AND b.owner_id=?
  LEFT JOIN wb_task_execution_receipts e ON e.run_id=w.run_id AND e.call_id=w.call_id
  WHERE w.run_id=? AND substr(replace(w.call_id,'.','-'),1,128)=? LIMIT 2`)
  .all(MAX_WORKSPACE_RESULT_BYTES,owner,runId,callId) as Array<{operation:string|null;receipt_id:string|null;result_hash:string|null;response_json:string|null}>;
 if(rows.length===0)throw Error('activity_tool_result_not_found');
 if(rows.length!==1)throw Error('activity_tool_result_source_invalid');
 const source=rows[0]!;
 if(source.operation!=='files.read'&&source.operation!=='web.read'&&source.operation!=='files.write'&&source.operation!=='files.delete'&&source.operation!=='files.list')throw Error('activity_tool_result_not_found');
 if(!source.response_json||!source.result_hash||!SHA.test(source.result_hash))throw Error('activity_tool_result_source_invalid');
 const response=parsedObject(source.response_json);
 if(!response)throw Error('activity_tool_result_source_invalid');
 const {execution_receipt,...result}=response,receipt=object(execution_receipt);
 if(!receipt||Object.keys(receipt).some(key=>!['kind','reference','hash'].includes(key))
  ||receipt.kind!=='tool_receipt'||receipt.reference!==source.receipt_id||receipt.hash!==source.result_hash
  ||hash(JSON.stringify(result))!==source.result_hash)throw Error('activity_tool_result_source_invalid');
 return {operation:source.operation,receiptId:source.receipt_id!,resultSha:source.result_hash,result};
}
function readWorkspaceText(db:DatabaseSync,owner:string,runId:string,callId:string,reader?:WorkspaceFileReader):TextSource{
 const {operation,receiptId,resultSha,result}=readWorkspaceReceipt(db,owner,runId,callId);
 if(operation==='files.delete'&&result.source!=='isolated')throw Error('activity_tool_result_not_found');
 const write=operation==='files.delete'?isolatedMutationSummary(db,owner,runId,receiptId,result,'files.delete')
  :operation==='files.write'?writeSummary(db,owner,runId,receiptId,result,reader):undefined;
 const listing=operation==='files.list'?fileListSummary(result):undefined;
 const text=write?.text??listing?.text??(operation==='files.read'?result.content:result.text);
 if(typeof text!=='string'||text.length>(write||listing?MAX_RESULT_TEXT_CHARS:MAX_TEXT_CHARS)
  ||operation==='web.read'&&(result.mode!=='public_http'||result.trusted!==false||typeof result.truncated!=='boolean'))throw Error('activity_tool_result_source_invalid');
 return {source:'workspace',operation:operation,result_sha256:resultSha,text,has_other_content:false,
  source_truncated:listing?listing.truncated:operation==='web.read'&&result.truncated===true,...(write?{file_diff_state:write.file_diff_state}:{}),...(listing?{file_links:listing.links}:{})};
}

function activityCall(activity:Record<string,unknown>){
 const detail=object(activity.detail),name=detail?.tool_name,callId=activity.tool_call_id,runId=activity.run_id;
 if(typeof runId!=='string'||!ID.test(runId)||typeof callId!=='string'||!ID.test(callId)
  ||typeof name!=='string'||(name!=='jot_workspace'&&!/^jot_mcp_[a-z0-9_]{1,50}$/.test(name)))throw Error('activity_tool_result_not_found');
 return {name,runId,callId};
}
function activityText(db:DatabaseSync,owner:string,activity:Record<string,unknown>,reader?:WorkspaceFileReader){
 const {name,runId,callId}=activityCall(activity);
 return {name,...(name==='jot_workspace'?readWorkspaceText(db,owner,runId,callId,reader):readMcpText(db,owner,runId,name,callId))};
}

function textBoundary(text:string,offset:number){
 return offset>0&&/[\uD800-\uDBFF]/.test(text[offset-1]!)&&/[\uDC00-\uDFFF]/.test(text[offset]!)?offset-1:offset;
}

function originalActivity(db:DatabaseSync,owner:string,conversationId:string,activityId:string,runId:string){
 const event=db.prepare(`SELECT e.payload_json FROM ga_events e
  JOIN ga_runs r ON r.id=e.run_id AND r.conversation_id=e.conversation_id
  JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=?
  WHERE e.conversation_id=? AND e.run_id=? AND e.type='activity.upsert'
   AND json_extract(e.payload_json,'$.activity_id')=? ORDER BY e.seq DESC LIMIT 1`)
  .get(owner,conversationId,runId,activityId) as {payload_json:string}|undefined;
 if(!event)throw Error('activity_tool_result_not_found');
 const activity=parsedObject(event.payload_json);
 if(!activity||activity.activity_id!==activityId||activity.run_id!==runId)throw Error('activity_tool_result_not_found');
 return activity;
}

/** The caller authorizes the conversation and holds the original read transaction. */
export function readActivityToolResult(db:DatabaseSync,owner:string,conversationId:string,activityId:string,query:Record<string,unknown>,reader?:WorkspaceFileReader):ActivityToolResultPage{
 if(!db.isTransaction)throw Error('activity_tool_result_read_transaction_required');
 const runId=query.run_id,offsetValue=query.offset_chars??'0',expected=query.result_sha256,expectedText=query.text_sha256;
 if(!ID.test(activityId)||typeof runId!=='string'||!ID.test(runId)
  ||Object.keys(query).some(key=>!['run_id','offset_chars','result_sha256','text_sha256'].includes(key))
  ||typeof offsetValue!=='string'||!/^(0|[1-9]\d{0,6})$/.test(offsetValue)
  ||expected!==undefined&&(typeof expected!=='string'||!SHA.test(expected))
  ||expectedText!==undefined&&(typeof expectedText!=='string'||!SHA.test(expectedText)))throw Error('invalid_activity_tool_result_query');
 const offset=Number(offsetValue);
 if(offset>MAX_RESULT_TEXT_CHARS||offset>0&&expected===undefined)throw Error('invalid_activity_tool_result_query');
 const activity=originalActivity(db,owner,conversationId,activityId,runId);
 const {name,...source}=activityText(db,owner,activity,reader);
 if(expected!==undefined&&expected!==source.result_sha256)throw Error('activity_tool_result_source_changed');
 const {text,file_links,...metadata}=source,textSha=hash(source.text);
 if(expectedText!==undefined&&expectedText!==textSha)throw Error('activity_tool_result_source_changed');
 if(['files.write','files.delete','files.list'].includes(source.operation??'')&&offset>0&&expectedText===undefined)throw Error('invalid_activity_tool_result_query');
 if(offset>text.length||offset>0&&/[\uD800-\uDBFF]/.test(text[offset-1]!)&&/[\uDC00-\uDFFF]/.test(text[offset]!))throw Error('invalid_activity_tool_result_query');
 let end=Math.min(offset+PAGE_SIZE,text.length);
 if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!)&&/[\uDC00-\uDFFF]/.test(text[end]!))end--;
 return {conversation_id:conversationId,run_id:runId,activity_id:activityId,tool_name:name,...metadata,
  text_sha256:textSha,offset_chars:offset,total_chars:text.length,text:text.slice(offset,end),
  ...(file_links?{file_links:file_links.filter(file=>file.end_offset_chars>offset&&file.offset_chars<end)}:{}),
  execution_authorized:false,...(end<text.length?{next_offset_chars:end}:{})};
}

/** Search retained original results through the same public history boundary and source checks. */
export function searchActivityToolResults(db:DatabaseSync,owner:string,conversationId:string,query:Record<string,unknown>,reader?:WorkspaceFileReader):ActivityToolResultSearchPage{
 if(!db.isTransaction)throw Error('activity_tool_result_read_transaction_required');
 const q=typeof query.q==='string'?query.q.trim():'';
 if(!q||q.length>200||Object.keys(query).some(key=>!['q','as_of_seq','before_seq','run_id'].includes(key)))throw Error('invalid_activity_tool_result_query');
 const page=readActivityHistory(db,conversationId,{as_of_seq:query.as_of_seq,before_seq:query.before_seq,run_id:query.run_id,limit:reader?1:8});
 const pattern=new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'iu');
 const items:ActivityToolResultMatch[]=[];
 let unavailable=0,unsearched=0;
 for(const entry of page.items){
  const activity=entry.activity;
  const newer=db.prepare(`SELECT 1 FROM ga_events WHERE conversation_id=? AND run_id=? AND type='activity.upsert'
   AND seq>? AND seq<=? AND json_extract(payload_json,'$.activity_id')=? LIMIT 1`)
   .get(conversationId,String(activity.run_id),entry.seq,page.as_of_seq,String(activity.activity_id));
  if(newer||activity.kind==='compaction')continue;
  if(!ID.test(String(activity.activity_id))){unavailable++;continue;}
  const name=object(activity.detail)?.tool_name;
  if(typeof name!=='string'||(name!=='jot_workspace'&&!/^jot_mcp_[a-z0-9_]{1,50}$/.test(name)))continue;
  if(typeof activity.ended_at!=='string'||!['succeeded','failed','cancelled','unknown'].includes(String(activity.status))){unavailable++;continue;}
  let source:ReturnType<typeof activityText>;
  try{source=activityText(db,owner,activity,reader);}catch(error){
   if(!(error instanceof Error)||!['activity_tool_result_not_found','activity_tool_result_pending','activity_tool_result_source_invalid'].includes(error.message))throw error;
   unavailable++;continue;
  }
  if(source.file_diff_state!==undefined&&source.file_diff_state!=='available'||source.operation==='files.list'&&source.source_truncated)unsearched++;
  const match=pattern.exec(source.text);
  if(!match)continue;
  const offset=textBoundary(source.text,Math.max(0,match.index-60));
  const end=textBoundary(source.text,Math.min(source.text.length,match.index+match[0].length+60));
  items.push({run_id:String(activity.run_id),activity_id:String(activity.activity_id),tool_name:source.name,
   title:typeof activity.title==='string'?activity.title.slice(0,256):source.name,result_sha256:source.result_sha256,text_sha256:hash(source.text),
   offset_chars:offset,match_offset_chars:match.index,match_text:match[0],excerpt:source.text.slice(offset,end)});
 }
 return {conversation_id:conversationId,as_of_seq:page.as_of_seq,q,items,scanned_upserts:page.items.length,
  unavailable_results:unavailable,unsearched_results:unsearched,coverage:page.coverage,execution_authorized:false,
  ...(page.run_id?{run_id:page.run_id}:{}),...(page.next_before_seq?{next_before_seq:page.next_before_seq}:{})};
}

function createListedTextPage(offset:number){
 const page=createTextPageCollector(offset),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),digest=createHash('sha256');
 let received=0;
 const decode=(bytes?:Uint8Array)=>{
  let text:string;
  try{text=decoder.decode(bytes,{stream:bytes!==undefined});}catch{throw Error('activity_tool_result_file_unsupported');}
  digest.update(text);page.write(text);
 };
 return {
  write(bytes:Buffer){received+=bytes.length;decode(bytes);},
  finish(size:number,expected:string){
   decode();const textSha=digest.digest('hex');
   if(received!==size||textSha!==expected)throw Error('activity_tool_result_source_invalid');
   return {...page.finish(),text_sha256:textSha};
  },
 };
}

/** Keep original list membership and source attribution identical for text and byte readers. */
function readOriginalListedFile(db:DatabaseSync,owner:string,conversationId:string,activityId:string,query:{runId:string;resultSha:string;path:string;version:number;fileSha:string},reader:WorkspaceFileReader,consume?: (chunk:Buffer)=>void,maxSize?:number){
 const {runId,resultSha,path,version,fileSha}=query;
 const activity=originalActivity(db,owner,conversationId,activityId,runId),call=activityCall(activity);
 if(call.name!=='jot_workspace')throw Error('activity_tool_result_not_found');
 const receipt=readWorkspaceReceipt(db,owner,runId,call.callId);
 if(receipt.operation!=='files.list')throw Error('activity_tool_result_not_found');
 if(receipt.resultSha!==resultSha)throw Error('activity_tool_result_source_changed');
 const facts=fileListFacts(receipt.result),file=facts.items.find(item=>item.path===path&&item.version===version&&item.sha256===fileSha);
 if(!file)throw Error('activity_tool_result_not_found');
 if(maxSize!==undefined&&file.size>maxSize)throw Error('activity_tool_result_file_unsupported');
 const binding=db.prepare(`SELECT json_extract(context_json,'$.workspace_id') workspace_id,json_extract(context_json,'$.project_id') project_id
  FROM wb_run_bindings WHERE run_id=? AND owner_id=?`).get(runId,owner) as {workspace_id:unknown;project_id:unknown}|undefined;
 if(!binding||typeof binding.workspace_id!=='string'||!binding.workspace_id||typeof binding.project_id!=='string'||!binding.project_id)throw Error('activity_tool_result_source_invalid');
 let content:Buffer;
 if(facts.isolated){
  const original=receipt.result;
  if(original.owner_id!==owner||original.workspace_id!==binding.workspace_id||original.project_id!==binding.project_id
   ||['occurrence_id','cycle_id','snapshot_id'].some(key=>typeof original[key]!=='string'||!original[key]))throw Error('activity_tool_result_source_invalid');
  if(version===0){
   const source=isolatedBaselineSource(db,owner,runId,original,path,fileSha,file.size);
   if(!source)throw Error('activity_tool_result_not_found');
   const baseline=reader.readBinaryFile(owner,source.workspace_id,source.project_id,source.path,source.version,source.sha256,undefined,consume);
   if(baseline.size!==file.size)throw Error('activity_tool_result_source_invalid');
   content=baseline.content;
  }else{
   const source=db.prepare(`SELECT e.*,r.conversation_id,b.kind='native_team' AS native FROM wb_task_isolated_file_execution_receipts e
    JOIN wb_run_bindings b ON b.run_id=e.run_id AND b.owner_id=e.owner_id
    JOIN ga_runs r ON r.id=e.run_id JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=e.owner_id
    WHERE e.owner_id=? AND e.workspace_id=? AND e.project_id=? AND e.occurrence_id=? AND e.cycle_id=? AND e.snapshot_id=?
     AND e.path=? AND e.version=? AND e.sha256=? AND e.size=?`)
    .get(owner,binding.workspace_id,binding.project_id,String(original.occurrence_id),String(original.cycle_id),String(original.snapshot_id),path,version,fileSha,file.size) as IsolatedFileSource|undefined;
   if(!source)throw Error('activity_tool_result_not_found');
   content=Buffer.from(readIsolatedTaskFileVersion(db,{...source,source:'isolated',native:Boolean(source.native)}).content,'utf8');
   consume?.(content);
  }
 }else{
  const original=reader.readBinaryFile(owner,binding.workspace_id,binding.project_id,path,version,fileSha,undefined,consume);
  if(original.size!==file.size)throw Error('activity_tool_result_source_invalid');
  content=original.content;
 }
 return {conversation_id:conversationId,run_id:runId,activity_id:activityId,result_sha256:resultSha,path,version,sha256:fileSha,size:file.size,
  source:facts.isolated?'isolated' as const:'workspace' as const,content};
}

/** Read exactly an original list member. No current head or unrecorded snapshot fallback. */
export function readActivityToolResultFile(db:DatabaseSync,owner:string,conversationId:string,activityId:string,query:Record<string,unknown>,reader:WorkspaceFileReader):ActivityToolFilePage{
 if(!db.isTransaction)throw Error('activity_tool_result_read_transaction_required');
 const runId=query.run_id,resultSha=query.result_sha256,path=query.path,fileSha=query.sha256,version=Number(query.version),offset=Number(query.offset_chars??0),textSha=query.text_sha256;
 const paged=query.text_protocol===2||query.text_protocol==='2';
 if(!ID.test(activityId)||typeof runId!=='string'||!ID.test(runId)||typeof resultSha!=='string'||!SHA.test(resultSha)
  ||typeof path!=='string'||!path||path.length>4096||typeof fileSha!=='string'||!SHA.test(fileSha)||!Number.isSafeInteger(version)||version<0
  ||!Number.isSafeInteger(offset)||offset<0||offset>(paged?Number.MAX_SAFE_INTEGER:MAX_TEXT_CHARS)||query.text_protocol!==undefined&&!paged||textSha!==undefined&&(typeof textSha!=='string'||!SHA.test(textSha))
  ||offset>0&&textSha===undefined||Object.keys(query).some(key=>!['run_id','result_sha256','path','version','sha256','offset_chars','text_sha256','text_protocol'].includes(key)))throw Error('invalid_activity_tool_result_query');
 const streaming=paged?createListedTextPage(offset):undefined;
 const file=readOriginalListedFile(db,owner,conversationId,activityId,{runId,resultSha,path,version,fileSha},reader,streaming?.write,paged?undefined:MAX_TEXT_CHARS);
 if(offset>file.size)throw Error('invalid_activity_tool_result_query');
 const content=file.content;
 if(streaming){
  const page=streaming.finish(file.size,fileSha);
  if(textSha!==undefined&&textSha!==page.text_sha256)throw Error('activity_tool_result_source_changed');
  return {conversation_id:conversationId,run_id:runId,activity_id:activityId,result_sha256:resultSha,path,version,sha256:fileSha,size:file.size,
   source:file.source,text_protocol:2,...page,execution_authorized:false};
 }
 if(content.length!==file.size||createHash('sha256').update(content).digest('hex')!==fileSha)throw Error('activity_tool_result_source_invalid');
 try{new TextDecoder('utf-8',{fatal:true}).decode(content);}catch{throw Error('activity_tool_result_file_unsupported');}
 const text=content.toString('utf8'),digest=hash(text);
 if(textSha!==undefined&&textSha!==digest)throw Error('activity_tool_result_source_changed');
 const page=readRetainedArtifactTextPage(text,offset);
 return {conversation_id:conversationId,run_id:runId,activity_id:activityId,result_sha256:resultSha,path,version,sha256:fileSha,size:file.size,
  source:file.source,text_sha256:digest,...page,execution_authorized:false};
}

/** Bounded selected bytes are published only after the complete original source is proven. */
// shortcut: each segment rescans the full source, use a verified retained download session for large files.
export function readActivityToolResultFileBytes(db:DatabaseSync,owner:string,conversationId:string,activityId:string,query:Record<string,unknown>,reader:WorkspaceFileReader):ActivityToolFileBytes{
 if(!db.isTransaction)throw Error('activity_tool_result_read_transaction_required');
 const runId=query.run_id,resultSha=query.result_sha256,path=query.path,fileSha=query.sha256,version=Number(query.version);
 const offset=Number(query.offset_bytes??0),limit=Number(query.limit_bytes??256);
 if(!ID.test(activityId)||typeof runId!=='string'||!ID.test(runId)||typeof resultSha!=='string'||!SHA.test(resultSha)
  ||typeof path!=='string'||!path||path.length>4096||typeof fileSha!=='string'||!SHA.test(fileSha)||!Number.isSafeInteger(version)||version<0
  ||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>65536
  ||Object.keys(query).some(key=>!['run_id','result_sha256','path','version','sha256','offset_bytes','limit_bytes'].includes(key)))throw Error('invalid_activity_tool_result_query');
 const selected=Buffer.alloc(limit),digest=createHash('sha256');let total=0,length=0;
 const consume=(bytes:Buffer)=>{
  digest.update(bytes);
  const start=Math.max(0,offset-total),end=Math.min(bytes.length,offset-total+limit);
  if(end>start){bytes.copy(selected,length,start,end);length+=end-start;}
  total+=bytes.length;
 };
 const file=readOriginalListedFile(db,owner,conversationId,activityId,{runId,resultSha,path,version,fileSha},reader,consume);
 if(total!==file.size||digest.digest('hex')!==fileSha)throw Error('activity_tool_result_source_invalid');
 if(offset>file.size)throw Error('invalid_activity_tool_result_query');
 const bytes=selected.subarray(0,length),{content,...metadata}=file;
 return {...metadata,offset_bytes:offset,length_bytes:length,content_base64:bytes.toString('base64'),chunk_sha256:createHash('sha256').update(bytes).digest('hex'),
  ...(offset+length<total?{next_offset_bytes:offset+length}:{}),execution_authorized:false};
}
