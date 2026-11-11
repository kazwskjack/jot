import {request,taskDraftScope} from './client';
import type {ActivityToolResultPage} from './types';

export type McpResultSource={conversationId:string;runId:string;activityId:string;toolName:string;resultSha:string};
export type McpResultContent={json:string;value:Record<string,unknown>&{content:unknown[]}};
const limit=512*1024;
const fail=()=>Error('原MCP结果内容、分页或摘要尚未确认');
/** The caller owns the complete read deadline; every page retains the exact original receipt. */
export async function readMcpResultContent(source:McpResultSource,owner:string,signal:AbortSignal):Promise<McpResultContent>{
 const check=()=>{signal.throwIfAborted();if(taskDraftScope()!==owner)throw Error('文件所属账户已变化');};
 check();if(!/^jot_mcp_[a-z0-9_]{1,50}$/.test(source.toolName)||source.resultSha.length!==64||!/^[a-f0-9]{64}$/.test(source.resultSha))throw fail();
 const parts:string[]=[];let offset=0,total:number|undefined;
 for(let pageIndex=0;pageIndex<33;pageIndex++){
  const query=new URLSearchParams({run_id:source.runId,representation:'json',result_sha256:source.resultSha,text_sha256:source.resultSha,offset_chars:String(offset)});
  const page=await request<ActivityToolResultPage>(`/conversations/${encodeURIComponent(source.conversationId)}/activities/${encodeURIComponent(source.activityId)}/tool-result?${query}`,'GET',undefined,undefined,signal);check();
  if(!page||page.conversation_id!==source.conversationId||page.run_id!==source.runId||page.activity_id!==source.activityId||page.tool_name!==source.toolName
    ||page.source!=='mcp'||page.representation!=='json'||page.result_sha256!==source.resultSha||page.text_sha256!==source.resultSha||page.execution_authorized!==false
    ||page.offset_chars!==offset||!Number.isSafeInteger(page.total_chars)||page.total_chars<offset||page.total_chars>limit||total!==undefined&&page.total_chars!==total
    ||typeof page.text!=='string'||page.text.length>16384||offset+page.text.length>page.total_chars||typeof page.has_other_content!=='boolean'
    ||page.operation!==undefined||page.file_links!==undefined||page.as_of_seq!==undefined||page.native_source_scope!==undefined||page.source_bytes!==undefined
    ||page.source_truncated!==undefined||page.file_diff_state!==undefined
    ||(page.next_offset_chars===undefined?offset+page.text.length!==page.total_chars:!page.text.length||page.next_offset_chars!==offset+page.text.length||page.next_offset_chars>=page.total_chars))throw fail();
  total=page.total_chars;parts.push(page.text);offset+=page.text.length;
  if(page.next_offset_chars===undefined){
   const json=parts.join(''),bytes=new TextEncoder().encode(json);if(bytes.byteLength>limit)throw fail();
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');check();if(digest!==source.resultSha)throw fail();
   const value:unknown=JSON.parse(json);check();
   if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray((value as Record<string,unknown>).content))throw fail();
   return {json,value:value as McpResultContent['value']};
  }
 }
 throw fail();
}

export function mcpInlinePayload(block:unknown):{bytes:Uint8Array<ArrayBuffer>;mime:string}|undefined{
 if(!block||typeof block!=='object'||Array.isArray(block))return;
 const value=block as Record<string,unknown>,resource=value.type==='resource'&&value.resource&&typeof value.resource==='object'&&!Array.isArray(value.resource)?value.resource as Record<string,unknown>:undefined;
 const data=value.type==='image'||value.type==='audio'?value.data:resource?.blob,mime=resource?.mimeType??value.mimeType;
 if(data===undefined)return;
 if(typeof data!=='string'||data.length>limit||data.length%4!==0||/[^A-Za-z0-9+/=]/.test(data))throw Error('内嵌文件编码尚未确认');
 const binary=atob(data);if(btoa(binary)!==data||binary.length>limit)throw Error('内嵌文件编码尚未确认');
 const bytes=Uint8Array.from(binary,value=>value.charCodeAt(0));
 return {bytes,mime:typeof mime==='string'&&mime.length<=127&&/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime)?mime.toLowerCase():'application/octet-stream'};
}
