import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance} from 'fastify';
import type {ActivityToolResultPage} from '../../contracts/types.ts';
import {withReadTransaction} from '../db/database.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {readOriginalActivity} from './activity-tool-result.ts';
import {readNativeMemberExecution} from '../workbench/native-member-owner-controls.ts';
import {sessionProjectionId} from '../harness/session-event-projector.ts';
import {SessionAdapterError} from '../harness/session-controller-client.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_CHARS = 32 * 1024 * 1024;
const hash = (value:unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
type Input = Record<string,unknown>;
export type NativeSearchSourceRequest = {call_seq:number;tool_name:'glob'|'grep';offset_chars:number;source_sha256?:string};
export interface NativeSearchSourceClient {
  readNativeSearchSource(ownerId:string,sessionId:string,input:NativeSearchSourceRequest,signal?:AbortSignal):Promise<unknown>;
}

/** Original activity, native run binding and child receipts form one owned snapshot. */
function source(db:DatabaseSync,owner:string,conversationId:string,runId:string,activityId:string) {
  return withReadTransaction(db,()=>{
    const activity = readOriginalActivity(db,owner,conversationId,activityId,runId);
    const detail = activity.detail as Input|undefined;
    const tool = detail?.tool_name, callSeq = detail?.native_search_call_seq, resultSeq = detail?.native_search_result_seq;
    if (!['search','subagent'].includes(String(activity.kind)) || activity.status !== 'succeeded'
      || typeof activity.ended_at !== 'string' || !['glob','grep'].includes(String(tool))
      || !Number.isSafeInteger(callSeq) || Number(callSeq) < 0 || !Number.isSafeInteger(resultSeq)
      || Number(resultSeq) <= Number(callSeq)) throw Error('activity_tool_result_not_found');
    let sessionId:string|undefined, callSha:string|undefined, resultSha:string|undefined;
    const childTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_native_execution_runs'").get();
    const child = childTable ? db.prepare(`SELECT n.root_run_id,n.child_session_ref,n.snapshot_json,parent.session_id AS parent_session_ref,root.id AS parent_run_binding
      FROM wb_native_execution_runs n
      LEFT JOIN ga_run_native_sessions parent ON parent.run_id=n.root_run_id AND parent.owner_id=n.owner_id
      LEFT JOIN ga_runs root ON root.id=n.root_run_id AND root.conversation_id=parent.conversation_id
      WHERE n.run_id=? AND n.owner_id=?`).get(runId,owner) as
      {root_run_id:string;child_session_ref:string;snapshot_json:string;parent_session_ref:string|null;parent_run_binding:string|null}|undefined : undefined;
    if (child) {
      const saved = JSON.parse(child.snapshot_json) as Input;
      if(!child.parent_session_ref||child.parent_run_binding!==child.root_run_id||saved.parent_session_ref!==child.parent_session_ref)throw Error('activity_tool_result_source_changed');
      const execution = readNativeMemberExecution(db,owner,child.root_run_id,child.child_session_ref,child.parent_session_ref,runId);
      if (execution.child_conversation_id !== conversationId) throw Error('activity_tool_result_source_changed');
      sessionId = child.child_session_ref;
      const receipts = db.prepare(`SELECT source_seq,event_type,source_sha256,projection_json FROM wb_native_activity_receipts
        WHERE run_id=? AND source_seq IN (?,?) ORDER BY source_seq`).all(runId,Number(callSeq),Number(resultSeq)) as
        Array<{source_seq:number;event_type:string;source_sha256:string;projection_json:string|null}>;
      if (receipts.length !== 2 || receipts[0]?.event_type !== 'tool/call' || receipts[1]?.event_type !== 'tool/result')
        throw Error('activity_tool_result_source_invalid');
      for (const receipt of receipts) {
        const projection = receipt.projection_json ? JSON.parse(receipt.projection_json) as Input : undefined;
        if (!projection || !SHA.test(receipt.source_sha256) || projection.activity_id !== activityId
          || projection.tool_call_id !== activity.tool_call_id || (projection.detail as Input)?.tool_name !== tool)
          throw Error('activity_tool_result_source_invalid');
      }
      callSha = receipts[0]!.source_sha256;
      resultSha = receipts[1]!.source_sha256;
    } else {
      const binding = db.prepare(`SELECT s.session_id FROM ga_run_native_sessions s
        JOIN ga_runs r ON r.id=s.run_id AND r.conversation_id=s.conversation_id
        JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=s.owner_id
        WHERE s.run_id=? AND c.id=? AND c.owner_id=?`).get(runId,conversationId,owner) as {session_id:string}|undefined;
      sessionId = binding?.session_id;
    }
    if (!sessionId) throw Error('activity_tool_result_not_found');
    return {sessionId,activity,tool:tool as 'glob'|'grep',callSeq:Number(callSeq),resultSeq:Number(resultSeq),callSha,resultSha,
      identity:hash({owner,conversationId,runId,sessionId,activity,callSha:callSha??null,resultSha:resultSha??null})};
  });
}

function page(value:unknown,expected:ReturnType<typeof source>,offset:number) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('activity_tool_result_source_invalid');
  const row = value as Input;
  const fields = ['protocol','session_id','call_seq','tool_call_id','tool_name','call_sha256','result_seq','result_sha256',
    'source_sha256','source_bytes','scope','text','offset_chars','total_chars','execution_authorized'];
  if (row.next_offset_chars !== undefined) fields.push('next_offset_chars');
  if (Object.keys(row).sort().join(',') !== fields.sort().join(',') || row.protocol !== 1 || row.execution_authorized !== false
    || row.session_id !== expected.sessionId || row.call_seq !== expected.callSeq || row.result_seq !== expected.resultSeq
    || row.tool_name !== expected.tool || typeof row.tool_call_id !== 'string' || !row.tool_call_id || row.tool_call_id.length > 8192
    || sessionProjectionId(row.tool_call_id,'') !== expected.activity.tool_call_id
    || !['call_sha256','result_sha256','source_sha256'].every(key=>typeof row[key] === 'string' && SHA.test(row[key] as string))
    || expected.callSha !== undefined && row.call_sha256 !== expected.callSha
    || expected.resultSha !== undefined && row.result_sha256 !== expected.resultSha
    || !Number.isSafeInteger(row.source_bytes) || Number(row.source_bytes) < 0 || Number(row.source_bytes) > MAX_CHARS
    || row.scope !== (expected.tool === 'glob' ? 'all_paths' : 'all_entries_with_native_line_previews')
    || row.offset_chars !== offset || !Number.isSafeInteger(row.total_chars) || Number(row.total_chars) < offset
    || Number(row.total_chars) > Number(row.source_bytes) || typeof row.text !== 'string' || row.text.length > 16384
    || offset + row.text.length > Number(row.total_chars)
    || /^[\uDC00-\uDFFF]/.test(row.text) || /[\uD800-\uDBFF]$/.test(row.text)
    || (row.next_offset_chars === undefined ? offset + row.text.length !== row.total_chars
      : !row.text.length || row.next_offset_chars !== offset + row.text.length || Number(row.next_offset_chars) >= Number(row.total_chars)))
    throw Error('activity_tool_result_source_invalid');
  return row as Input & {text:string;source_sha256:string;source_bytes:number;total_chars:number;scope:'all_paths'|'all_entries_with_native_line_previews';next_offset_chars?:number};
}

export function registerNativeSearchSourceRoutes(app:FastifyInstance,{db,actor,client}:{
  db:DatabaseSync;actor(request:{headers:Record<string,unknown>}):string;client?:NativeSearchSourceClient|undefined;
}) {
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result/source',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const abort = new AbortController(), disconnected = () => abort.abort();
    request.raw.once('aborted',disconnected);
    reply.raw.once('close',disconnected);
    if (request.raw.aborted || reply.raw.destroyed) disconnected();
    try {
      const owner = actor(request), {conversationId,activityId} = request.params as {conversationId:string;activityId:string};
      const query = request.query as Input, runId = query.run_id, offsetValue = query.offset_chars ?? '0';
      if (!ID.test(conversationId) || !ID.test(activityId) || typeof runId !== 'string' || !ID.test(runId)
        || Object.keys(query).some(key=>!['run_id','offset_chars','result_sha256','text_sha256'].includes(key))
        || typeof offsetValue !== 'string' || !/^(0|[1-9]\d{0,7})$/.test(offsetValue)
        || ['result_sha256','text_sha256'].some(key=>query[key] !== undefined && (typeof query[key] !== 'string' || !SHA.test(query[key] as string))))
        throw Error('invalid_activity_tool_result_query');
      const offset = Number(offsetValue);
      if (offset > MAX_CHARS || offset > 0 && (query.result_sha256 === undefined || query.text_sha256 === undefined))
        throw Error('invalid_activity_tool_result_query');
      const original = source(db,owner,conversationId,runId,activityId);
      if (!client) throw Error('activity_tool_result_source_invalid');
      const signal = AbortSignal.any([abort.signal,AbortSignal.timeout(20000)]);
      const response = page(await client.readNativeSearchSource(owner,original.sessionId,{call_seq:original.callSeq,
        tool_name:original.tool,offset_chars:offset,...(query.text_sha256 ? {source_sha256:query.text_sha256 as string} : {})},signal),original,offset);
      signal.throwIfAborted();
      if (source(db,owner,conversationId,runId,activityId).identity !== original.identity) throw Error('activity_tool_result_source_changed');
      const resultSha = hash({activity:original.identity,call:response.call_sha256,result:response.result_sha256,
        source:response.source_sha256,bytes:response.source_bytes,scope:response.scope});
      if (query.result_sha256 !== undefined && query.result_sha256 !== resultSha
        || query.text_sha256 !== undefined && query.text_sha256 !== response.source_sha256) throw Error('activity_tool_result_source_changed');
      const result:ActivityToolResultPage = {conversation_id:conversationId,run_id:runId,activity_id:activityId,
        tool_name:original.tool,source:'native',operation:original.tool,source_truncated:original.tool === 'grep',
        native_source_scope:response.scope,source_bytes:response.source_bytes,result_sha256:resultSha,text_sha256:response.source_sha256,
        text:response.text,offset_chars:offset,total_chars:response.total_chars,has_other_content:false,execution_authorized:false,
        ...(response.next_offset_chars !== undefined ? {next_offset_chars:response.next_offset_chars} : {})};
      return result;
    } catch (error) {
      if (error instanceof SessionAdapterError) return reply.code(error.status === 404 ? 404 : error.status === 429 ? 429 : error.status === 409 ? 409 : 503)
        .send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_UNAVAILABLE'}});
      if(error instanceof Error&&['AbortError','TimeoutError'].includes(error.name))
        return reply.code(503).send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_UNAVAILABLE'}});
      throw error;
    } finally {
      request.raw.off('aborted',disconnected);
      reply.raw.off('close',disconnected);
    }
  });
}
