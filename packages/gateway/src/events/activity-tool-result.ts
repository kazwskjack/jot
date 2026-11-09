import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ActivityToolResultPage} from '../../contracts/types.js';

const ID=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const SHA=/^[a-f0-9]{64}$/;
const PAGE_SIZE=16384;
const MAX_RESULT_BYTES=524288;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function object(value:unknown):Record<string,unknown>|undefined{
 return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}
function parsedObject(text:string){
 try{return object(JSON.parse(text));}catch{throw Error('activity_tool_result_source_invalid');}
}

/** The caller authorizes the conversation and holds the original read transaction. */
export function readActivityToolResult(db:DatabaseSync,owner:string,conversationId:string,activityId:string,query:Record<string,unknown>):ActivityToolResultPage{
 if(!db.isTransaction)throw Error('activity_tool_result_read_transaction_required');
 const runId=query.run_id,offsetValue=query.offset_chars??'0',expected=query.result_sha256;
 if(!ID.test(activityId)||typeof runId!=='string'||!ID.test(runId)
  ||Object.keys(query).some(key=>!['run_id','offset_chars','result_sha256'].includes(key))
  ||typeof offsetValue!=='string'||!/^(0|[1-9]\d{0,5})$/.test(offsetValue)
  ||expected!==undefined&&(typeof expected!=='string'||!SHA.test(expected)))throw Error('invalid_activity_tool_result_query');
 const offset=Number(offsetValue);
 if(offset>MAX_RESULT_BYTES||offset>0&&expected===undefined)throw Error('invalid_activity_tool_result_query');
 const event=db.prepare(`SELECT e.payload_json FROM ga_events e
  JOIN ga_runs r ON r.id=e.run_id AND r.conversation_id=e.conversation_id
  JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=?
  WHERE e.conversation_id=? AND e.run_id=? AND e.type='activity.upsert'
   AND json_extract(e.payload_json,'$.activity_id')=? ORDER BY e.seq DESC LIMIT 1`)
  .get(owner,conversationId,runId,activityId) as {payload_json:string}|undefined;
 if(!event)throw Error('activity_tool_result_not_found');
 const activity=parsedObject(event.payload_json),detail=object(activity?.detail);
 const name=detail?.tool_name,callId=activity?.tool_call_id;
 if(!activity||activity.activity_id!==activityId||activity.run_id!==runId||typeof callId!=='string'||!ID.test(callId)
  ||typeof name!=='string'||!/^jot_mcp_[a-z0-9_]{1,50}$/.test(name))throw Error('activity_tool_result_not_found');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_mcp_operations'").get())throw Error('activity_tool_result_not_found');
 // Match the shared public ID normalization, and reject colliding original calls.
 const rows=db.prepare(`SELECT o.state,o.result_hash,
  CASE WHEN length(CAST(o.response_json AS BLOB))<=? THEN o.response_json END response_json,
  e.result_hash receipt_hash FROM wb_mcp_operations o
  LEFT JOIN wb_task_execution_receipts e ON e.run_id=o.run_id AND e.call_id=o.call_id AND e.operation=o.public_name
  WHERE o.owner_id=? AND o.run_id=? AND o.public_name=? AND substr(replace(o.call_id,'.','-'),1,128)=? LIMIT 2`)
  .all(MAX_RESULT_BYTES,owner,runId,name,callId) as Array<{state:string;result_hash:string|null;response_json:string|null;receipt_hash:string|null}>;
 if(rows.length===0)throw Error('activity_tool_result_not_found');
 if(rows.length!==1)throw Error('activity_tool_result_source_invalid');
 const source=rows[0]!;
 if(source.state!=='settled')throw Error('activity_tool_result_pending');
 if(!source.response_json||!source.result_hash||!SHA.test(source.result_hash)
  ||source.receipt_hash!==source.result_hash||hash(source.response_json)!==source.result_hash)throw Error('activity_tool_result_source_invalid');
 if(expected!==undefined&&expected!==source.result_hash)throw Error('activity_tool_result_source_changed');
 const result=parsedObject(source.response_json);
 if(!result||!Array.isArray(result.content))throw Error('activity_tool_result_source_invalid');
 const parts:string[]=[];
 let otherContent=false;
 for(const block of result.content){
  const value=object(block);
  if(value?.type==='text'&&typeof value.text==='string')parts.push(value.text);
  else otherContent=true;
 }
 const text=parts.join('\n');
 if(offset>text.length||offset>0&&/[\uD800-\uDBFF]/.test(text[offset-1]!)&&/[\uDC00-\uDFFF]/.test(text[offset]!))throw Error('invalid_activity_tool_result_query');
 let end=Math.min(offset+PAGE_SIZE,text.length);
 if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!)&&/[\uDC00-\uDFFF]/.test(text[end]!))end--;
 return {conversation_id:conversationId,run_id:runId,activity_id:activityId,tool_name:name,source:'mcp',
  result_sha256:source.result_hash,text_sha256:hash(text),offset_chars:offset,total_chars:text.length,text:text.slice(offset,end),
  has_other_content:otherContent,execution_authorized:false,...(end<text.length?{next_offset_chars:end}:{})};
}
