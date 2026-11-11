import {listRetainedNativeFiles,readRetainedNativeFile,loadRetainedNativeFile,retainNativeFile} from '../artifacts/native-file-store.ts';
import type {NativeFileProofSource,NativeFileProofPdf} from '../messages/native-file-proof.ts';
import {OFFICE_SOURCE_MAX_BYTES,officePreviewFormat} from '../artifacts/office-preview-format.js';
import type {PinnedByteSource} from '../artifacts/pinned-byte-source.ts';
import type {OfficeDocumentPreview} from '../artifacts/document-preview-content.ts';
import {validateNativeFileRange,type NativeFileRangeRequest} from '../harness/native-file-range.js';
import {createPinnedByteStore} from '../artifacts/pinned-byte-source.ts';
import {Readable} from 'node:stream';
import {validateNativeSearchMembers,validateNativeSearchMemberRange,type NativeSearchMembersRequest,type NativeSearchMembers,type NativeSearchMemberRangeRequest} from '../harness/native-search-members.js';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {ActivityToolResultPage,ActivityToolResultSearchPage,ActivityToolResultMatch,ActivityNativeSearchMembersPage,ActivityNativeFileOpeningsPage,NativeMemberOfficeDocumentPage} from '../../contracts/types.ts';
import {withReadTransaction} from '../db/database.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {readOriginalActivitySnapshot,type NativeSearchCandidate} from './activity-tool-result.ts';
import {readActivityHistory} from './activity-history.ts';
import {readNativeMemberExecution} from '../workbench/native-member-owner-controls.ts';
import {sessionProjectionId} from '../harness/session-event-projector.ts';
import {SessionAdapterError} from '../harness/session-controller-client.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_CHARS = 32 * 1024 * 1024;
const hash = (value:unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const retainedNativeBinding=(owner:string,activity:string,opened:string)=>hash({protocol:'jot-retained-native-file/v1',owner,activity,opened});
type Input = Record<string,unknown>;
export type NativeSearchSourceRequest = {call_seq:number;tool_name:'glob'|'grep';offset_chars:number;source_sha256?:string};
export type NativeSearchSourceSearchRequest = Omit<NativeSearchSourceRequest,'offset_chars'>&{q:string};
export interface NativeSearchSourceClient {
  readNativeSearchMemberFileRange?(ownerId:string,sessionId:string,input:NativeSearchMemberRangeRequest,signal?:AbortSignal):Promise<unknown>;
  readNativeFileRange?(ownerId:string,sessionId:string,input:NativeFileRangeRequest,signal?:AbortSignal):Promise<unknown>;
  readNativeSearchMembers?(ownerId:string,sessionId:string,input:NativeSearchMembersRequest,signal?:AbortSignal):Promise<unknown>;
  readNativeSearchSource(ownerId:string,sessionId:string,input:NativeSearchSourceRequest,signal?:AbortSignal):Promise<unknown>;
  searchNativeSearchSource?(ownerId:string,sessionId:string,input:NativeSearchSourceSearchRequest,signal?:AbortSignal):Promise<unknown>;
}

/** Original activity, native run binding and child receipts form one owned snapshot. */
function source(db:DatabaseSync,owner:string,conversationId:string,runId:string,activityId:string,asOfSeq?:string,activitySeq?:string) {
  return withReadTransaction(db,()=>{
    // The stored event revision never rewrites the original public history/signature boundary.
    if(activitySeq!==undefined&&asOfSeq!==undefined&&BigInt(activitySeq)>BigInt(asOfSeq))throw Error('activity_tool_result_source_changed');
    const snapshot=readOriginalActivitySnapshot(db,owner,conversationId,activityId,runId,activitySeq??asOfSeq),activity=snapshot.activity;
    if(activitySeq!==undefined&&snapshot.seq!==activitySeq)throw Error('activity_tool_result_source_changed');
    if(asOfSeq!==undefined)readActivityHistory(db,conversationId,{as_of_seq:asOfSeq,run_id:runId,limit:1});
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
    return {sessionId,activity,activitySeq:snapshot.seq,tool:tool as 'glob'|'grep',callSeq:Number(callSeq),resultSeq:Number(resultSeq),callSha,resultSha,
      identity:hash({owner,conversationId,runId,sessionId,activity,callSha:callSha??null,resultSha:resultSha??null,...(asOfSeq?{asOfSeq}:{})})};
  });
}

function memberResultHash(original:ReturnType<typeof source>,response:NativeSearchMembers) {
  return hash({activity:original.identity,call:response.call_sha256,result:response.result_sha256,
    members:response.members_sha256,workdir:response.workdir,total:response.total_members,originalTotal:response.original_total});
}

async function readMembers(client:NativeSearchSourceClient,owner:string,original:ReturnType<typeof source>,input:NativeSearchMembersRequest,signal:AbortSignal) {
  if (!client.readNativeSearchMembers) throw Error('activity_tool_result_source_invalid');
  const response = validateNativeSearchMembers(await client.readNativeSearchMembers(owner,original.sessionId,input,signal),original.sessionId,input);
  signal.throwIfAborted();
  if (response.result_seq !== original.resultSeq || sessionProjectionId(response.tool_call_id,'') !== original.activity.tool_call_id
    || original.callSha !== undefined && response.call_sha256 !== original.callSha
    || original.resultSha !== undefined && response.result_sha256 !== original.resultSha)
    throw Error('activity_tool_result_source_changed');
  return response;
}

function resultHash(original:ReturnType<typeof source>,response:Input) {
  return hash({activity:original.identity,call:response.call_sha256,result:response.result_sha256,
    source:response.source_sha256,bytes:response.source_bytes,scope:response.scope});
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

/** Search the same retained historical activity outside its original read transaction. */
export async function searchNativeActivitySources(db:DatabaseSync,owner:string,base:ActivityToolResultSearchPage,
  candidates:NativeSearchCandidate[],client:NativeSearchSourceClient|undefined,signal:AbortSignal):Promise<ActivityToolResultSearchPage> {
  if(!client?.searchNativeSearchSource)return base;
  const items=base.items.slice();
  let unsearched=base.unsearched_results??0,inserted=0;
  const pattern=new RegExp(`^(?:${base.q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})$`,'iu');
  for(const candidate of candidates){
    signal.throwIfAborted();
    const activity=candidate.activity,runId=String(activity.run_id),activityId=String(activity.activity_id);
    try{
      const original=source(db,owner,base.conversation_id,runId,activityId,base.as_of_seq);
      if(hash(original.activity)!==hash(activity))throw Error('activity_tool_result_source_changed');
      const raw=await client.searchNativeSearchSource(owner,original.sessionId,{call_seq:original.callSeq,
        tool_name:original.tool,q:base.q},signal);
      signal.throwIfAborted();
      if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Object.hasOwn(raw,'match'))throw Error('activity_tool_result_source_invalid');
      const {match,...value}=raw as Input;
      if(!Number.isSafeInteger(value.offset_chars)||Number(value.offset_chars)<0)throw Error('activity_tool_result_source_invalid');
      const response=page(value,original,Number(value.offset_chars));
      if(source(db,owner,base.conversation_id,runId,activityId,base.as_of_seq).identity!==original.identity)
        throw Error('activity_tool_result_source_changed');
      if(match===null){
        if(response.text!==''||response.offset_chars!==response.total_chars)throw Error('activity_tool_result_source_invalid');
      }else{
        if(!match||typeof match!=='object'||Array.isArray(match))throw Error('activity_tool_result_source_invalid');
        const found=match as Input,offset=Number(response.offset_chars);
        if(Object.keys(found).sort().join(',')!=='match_offset_chars,match_text'||!Number.isSafeInteger(found.match_offset_chars)
          ||Number(found.match_offset_chars)<offset||Number(found.match_offset_chars)-offset>61
          ||typeof found.match_text!=='string'||!found.match_text||found.match_text.length>200||!pattern.test(found.match_text)
          ||response.text.length>400||response.text.slice(Number(found.match_offset_chars)-offset,
            Number(found.match_offset_chars)-offset+found.match_text.length)!==found.match_text)throw Error('activity_tool_result_source_invalid');
        const hit:ActivityToolResultMatch={run_id:runId,activity_id:activityId,tool_name:original.tool,
          title:typeof activity.title==='string'?activity.title.slice(0,256):original.tool,native_source:true,
          result_sha256:resultHash(original,response),text_sha256:response.source_sha256,offset_chars:offset,
          match_offset_chars:Number(found.match_offset_chars),match_text:found.match_text,excerpt:response.text};
        const index=items.findIndex(item=>item.run_id===runId&&item.activity_id===activityId);
        if(index>=0)items[index]=hit;
        else {items.splice(candidate.index+inserted,0,hit);inserted++;}
      }
      if(original.tool==='glob')unsearched=Math.max(0,unsearched-1);
    }catch(error){
      signal.throwIfAborted();
      if(error instanceof SessionAdapterError)continue;
      if(error instanceof Error&&['activity_tool_result_not_found','activity_tool_result_pending','activity_tool_result_source_changed',
        'activity_tool_result_source_invalid','native_member_not_found','native_member_execution_invalid'].includes(error.message))continue;
      throw error;
    }
  }
  return {...base,items,unsearched_results:unsearched};
}

export function registerNativeSearchSourceRoutes(app:FastifyInstance,{db,actor,client,snapshotRoot,retainedRoot,inspectOffice,renderOffice,nativeProofs}:{
  db:DatabaseSync;actor(request:{headers:Record<string,unknown>}):string;client?:NativeSearchSourceClient|undefined;snapshotRoot?:string;retainedRoot?:string;
  nativeProofs?:{sign:(owner:string,source:NativeFileProofSource,pdf?:NativeFileProofPdf)=>string;
    assert:(owner:string,source:NativeFileProofSource,proof:string,pdf?:NativeFileProofPdf)=>void};
  renderOffice?:(source:PinnedByteSource,name:string,binding:string,signal:AbortSignal,expected?:{sha256:string;size:number;pageCount:number})=>Promise<{pdf:{bytes:Buffer;sha256:string;size:number;page_count:number};engine:{name:string;version:string}}>;
  inspectOffice?:(source:PinnedByteSource,name:string,signal:AbortSignal)=>Promise<{media_type:string;document:OfficeDocumentPreview;engine:{name:string;version:string}}>;

}) {
  const downloads = new Set<{bytes:number}>(), downloadBudget = 512*1024*1024;
  const nativeFileRoute=(operation:'download'|'document'|'print')=>async(request:FastifyRequest,reply:FastifyReply)=>{
    reply.header('cache-control','private, no-store');
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal,AbortSignal.timeout(operation==='print'?180000:120000)]);
    let stream:Readable|undefined, store:ReturnType<typeof createPinnedByteStore>|undefined;
    const reservation = {bytes:0};
    const cancelled = () => stream?.destroy();
    signal.addEventListener('abort',cancelled,{once:true});
    const disconnected = () => {abort.abort();stream?.destroy();};
    request.raw.once('aborted',disconnected);
    reply.raw.once('close',disconnected);
    if (request.raw.aborted || reply.raw.destroyed) disconnected();
    let cleanupPromise:Promise<void>|undefined;
    const cleanup = () => cleanupPromise ??= (async()=>{
      signal.removeEventListener('abort',cancelled);
      request.raw.off('aborted',disconnected);
      reply.raw.off('close',disconnected);
      await store?.dispose();
      downloads.delete(reservation);
    })();
    try {
      const owner = actor(request), {conversationId,activityId,memberIndex} = request.params as {conversationId:string;activityId:string;memberIndex:string};
      const query = request.query as Input, runId = query.run_id, asOfSeq = query.as_of_seq;
      if (!ID.test(conversationId) || !ID.test(activityId) || typeof runId !== 'string' || !ID.test(runId)
        || !/^(0|[1-9]\d{0,7})$/.test(memberIndex) || Number(memberIndex) > MAX_CHARS
        || Object.keys(query).some(key=>!['run_id','result_sha256','members_sha256','as_of_seq','max_bytes','open_sha256','open_proof',...(operation==='print'?['preview_sha256','preview_size_bytes','preview_page_count','preview_proof']:[])].includes(key))
        || asOfSeq !== undefined && (typeof asOfSeq !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(asOfSeq) || BigInt(asOfSeq)>9223372036854775807n)
        || ['result_sha256','members_sha256'].some(key=>typeof query[key] !== 'string' || !SHA.test(query[key] as string)))
        throw Error('invalid_activity_tool_result_query');
      if(query.open_sha256!==undefined&&(typeof query.open_sha256!=='string'||!SHA.test(query.open_sha256)))throw Error('invalid_activity_tool_result_query');
      let expectedPdf:{sha256:string;size:number;pageCount:number}|undefined;
      if(operation==='print'&&['preview_sha256','preview_size_bytes','preview_page_count'].some(key=>query[key]!==undefined)){
        const size=Number(query.preview_size_bytes),pageCount=Number(query.preview_page_count);
        if(typeof query.preview_sha256!=='string'||!SHA.test(query.preview_sha256)||query.open_sha256===undefined
          ||typeof query.preview_size_bytes!=='string'||String(size)!==query.preview_size_bytes||!Number.isSafeInteger(size)||size<100||size>20*1024*1024
          ||typeof query.preview_page_count!=='string'||String(pageCount)!==query.preview_page_count||!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>50000)
          throw Error('invalid_activity_tool_result_query');
        expectedPdf={sha256:query.preview_sha256,size,pageCount};
      }
      for(const field of ['open_proof','preview_proof']){
        if(query[field]!==undefined&&(typeof query[field]!=='string'||(query[field] as string).length!==43||!/^[A-Za-z0-9_-]{43}$/.test(query[field] as string)
          ||query.open_sha256===undefined||field==='preview_proof'&&!expectedPdf))throw Error('invalid_activity_tool_result_query');
      }
      const operationLimit=operation==='download'?downloadBudget:OFFICE_SOURCE_MAX_BYTES;
      const requestedLimit = query.max_bytes === undefined ? operationLimit : Number(query.max_bytes);
      if (query.max_bytes !== undefined && (typeof query.max_bytes !== 'string' || !/^[1-9]\d{0,8}$/.test(query.max_bytes)
        || !Number.isSafeInteger(requestedLimit) || requestedLimit > operationLimit)) throw Error('invalid_activity_tool_result_query');
      if(operation==='document'&&!inspectOffice||operation==='print'&&!renderOffice)throw Error('activity_tool_result_source_invalid');
      if (!snapshotRoot)
        throw Error('activity_tool_result_source_invalid');
      if (downloads.size >= 4) return reply.code(429).send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_CAPACITY'}});
      downloads.add(reservation);
      const findRetained=async()=>{
        if(!retainedRoot||query.open_sha256===undefined)return undefined;
        let current:ReturnType<typeof source>|undefined;
        try{current=source(db,owner,conversationId,runId,activityId,asOfSeq as string|undefined);}
        catch(error){if(!(error instanceof Error)||!['activity_tool_result_not_found','activity_tool_result_source_changed','activity_tool_result_source_invalid'].includes(error.message))throw error;}
        if(current){
          const saved=await readRetainedNativeFile(retainedRoot,retainedNativeBinding(owner,current.identity,query.open_sha256 as string),signal);
          if(saved){
            const original=source(db,owner,conversationId,runId,activityId,asOfSeq as string|undefined,saved.activity_seq);
            if(original.identity!==current.identity)throw Error('activity_tool_result_source_changed');return {saved,original};
          }
        }
        if([...downloads].reduce((sum,value)=>sum+value.bytes,0)+64*1024*1024>downloadBudget)return 'capacity' as const;
        reservation.bytes=64*1024*1024;
        try{
          let found:{saved:Awaited<ReturnType<typeof listRetainedNativeFiles>>[number];original:ReturnType<typeof source>}|undefined;
          const records=await listRetainedNativeFiles(retainedRoot,signal);let scanned=0;
          for(const saved of records){
            if(++scanned%8===0)await new Promise<void>(resolve=>setImmediate(resolve));signal.throwIfAborted();
            const prior=saved.source;
            if(prior.conversationId!==conversationId||prior.runId!==runId||prior.activityId!==activityId||prior.resultSha!==query.result_sha256
              ||prior.membersSha!==query.members_sha256||prior.memberIndex!==Number(memberIndex)||prior.openSha!==query.open_sha256||prior.asOfSeq!==asOfSeq)continue;
            let original:ReturnType<typeof source>;
            try{original=source(db,owner,conversationId,runId,activityId,prior.asOfSeq,saved.activity_seq);}
            catch(error){if(error instanceof Error&&['activity_tool_result_not_found','activity_tool_result_source_changed','activity_tool_result_source_invalid'].includes(error.message))continue;throw error;}
            if(saved.binding!==retainedNativeBinding(owner,original.identity,prior.openSha))continue;
            if(found)throw Error('activity_tool_result_source_changed');found={saved,original};
          }
          return found;
        }finally{reservation.bytes=0;}
      };
      const retainedOpening=await findRetained();
      if(retainedOpening==='capacity')return reply.code(429).send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_CAPACITY'}});
      const saved=retainedOpening?.saved,original=retainedOpening?.original??source(db,owner,conversationId,runId,activityId,asOfSeq as string|undefined);
      let openedSource:PinnedByteSource,proofSource:NativeFileProofSource,verifyPreviewAuthority:()=>Promise<void>,retained=false;
      const retentionBinding=(opened:string)=>retainedNativeBinding(owner,original.identity,opened);
      if(saved){
        const prior=saved.source;
        if(prior.conversationId!==conversationId||prior.runId!==runId||prior.activityId!==activityId||prior.resultSha!==query.result_sha256
          ||prior.membersSha!==query.members_sha256||prior.memberIndex!==Number(memberIndex)||prior.openSha!==query.open_sha256||prior.asOfSeq!==asOfSeq)
          throw Error('activity_tool_result_source_changed');
        if(operation==='print'&&!officePreviewFormat(prior.path)||operation==='document'&&!officePreviewFormat(prior.path)?.native)throw Error('UNSUPPORTED_FORMAT_OPERATION');
        if(prior.size>requestedLimit)throw Error('activity_tool_result_file_unsupported');
        if([...downloads].reduce((sum,value)=>sum+value.bytes,0)+prior.size>downloadBudget)
          return reply.code(429).send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_CAPACITY'}});
        reservation.bytes=prior.size;store=createPinnedByteStore(snapshotRoot);
        const writer=await store.begin(prior.sha256,prior.size,signal);await loadRetainedNativeFile(retainedRoot!,saved,writer,signal);
        openedSource=writer.source;proofSource=prior;retained=true;
        verifyPreviewAuthority=async()=>{signal.throwIfAborted();if(source(db,owner,conversationId,runId,activityId,asOfSeq as string|undefined,saved.activity_seq).identity!==original.identity)throw Error('activity_tool_result_source_changed');};
      }else{
        if(!client?.readNativeSearchMemberFileRange||!client.readNativeFileRange)throw Error('activity_tool_result_source_invalid');
        const memberInput:NativeSearchMembersRequest = {call_seq:original.callSeq,tool_name:original.tool,
          offset_members:Number(memberIndex),members_sha256:query.members_sha256 as string};
        const membership = await readMembers(client,owner,original,memberInput,signal);
        if (memberResultHash(original,membership) !== query.result_sha256 || membership.items[0]?.index !== Number(memberIndex))
          throw Error('activity_tool_result_source_changed');
        if(operation==='print'&&!officePreviewFormat(membership.items[0]!.path))throw Error('UNSUPPORTED_FORMAT_OPERATION');
        if(operation==='document'&&!officePreviewFormat(membership.items[0]!.path)?.native)throw Error('UNSUPPORTED_FORMAT_OPERATION');
        const input:NativeSearchMemberRangeRequest = {member:{call_seq:original.callSeq,tool_name:original.tool,index:Number(memberIndex),
          members_sha256:membership.members_sha256,call_sha256:membership.call_sha256,result_sha256:membership.result_sha256},
          range:{offset_bytes:0,length_bytes:65536}};
        const first = validateNativeSearchMemberRange(await client.readNativeSearchMemberFileRange(owner,original.sessionId,input,signal),original.sessionId,input).range;
        signal.throwIfAborted();
        const limit = first.file_size_bytes ?? requestedLimit;
        if (limit > requestedLimit) throw Error('activity_tool_result_file_unsupported');
        if ([...downloads].reduce((sum,value)=>sum+value.bytes,0)+limit > downloadBudget)
          return reply.code(429).send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_CAPACITY'}});
        reservation.bytes = limit;
        store = createPinnedByteStore(snapshotRoot);
        const writer = await store.beginStream(limit,signal);
        let range = first, offset = 0;
        for (;;) {
          signal.throwIfAborted();
          const data = Buffer.from(range.data_base64,'base64');
          if (offset+data.length > limit) throw Error('activity_tool_result_file_unsupported');
          await writer.append(data);
          offset += data.length;
          if (range.eof) break;
          const next:NativeFileRangeRequest = {path:first.absolute_path,offset_bytes:offset,length_bytes:Math.min(65536,limit-offset+1),
            absolute_path:first.absolute_path,version:first.version,session_sha256:first.session_sha256,file_size_bytes:first.file_size_bytes};
          range = validateNativeFileRange(await client.readNativeFileRange(owner,original.sessionId,next,signal),original.sessionId,next);
          if (range.profile_id !== first.profile_id) throw Error('activity_tool_result_source_changed');
        }
        await writer.seal();
        const current = await readMembers(client,owner,original,memberInput,signal);
        if (hash(current) !== hash(membership)
          || source(db,owner,conversationId,runId,activityId,asOfSeq as string|undefined).identity !== original.identity)
          throw Error('activity_tool_result_source_changed');
        signal.throwIfAborted();
        const openedSha = hash({activity:query.result_sha256,members:membership.members_sha256,index:Number(memberIndex),
          profile:first.profile_id,session:first.session_sha256,path:first.absolute_path,version:first.version,
          reportedSize:first.file_size_bytes,size:writer.source.sizeBytes,content:writer.source.sha256});
        if(query.open_sha256!==undefined&&query.open_sha256!==openedSha)throw Error('activity_tool_result_source_changed');
        proofSource={conversationId,runId,activityId,resultSha:query.result_sha256 as string,
          membersSha:membership.members_sha256,memberIndex:Number(memberIndex),path:membership.items[0]!.path,
          openSha:openedSha,sha256:writer.source.sha256,size:writer.source.sizeBytes,...(asOfSeq!==undefined?{asOfSeq:asOfSeq as string}:{})};
        openedSource=writer.source;
        verifyPreviewAuthority=async()=>{
          signal.throwIfAborted();
          const final=await readMembers(client,owner,original,memberInput,signal);
          if(hash(final)!==hash(membership)||source(db,owner,conversationId,runId,activityId,asOfSeq as string|undefined).identity!==original.identity)
            throw Error('activity_tool_result_source_changed');
        };
      }
      if(saved)await verifyPreviewAuthority();
      const openedSha=proofSource.openSha;
      if(query.open_proof!==undefined){
        if(!nativeProofs)throw Error('native_file_reference_unproven');
        nativeProofs.assert(owner,proofSource,query.open_proof as string);
      }
      const openProof=nativeProofs?.sign(owner,proofSource);
      const retainOpened=async()=>{
        if(!retained&&retainedRoot){
          try{retained=await retainNativeFile(db,retainedRoot,retentionBinding(openedSha),proofSource,openedSource,signal,original.activitySeq);}
          catch(error){signal.throwIfAborted();app.log.warn({err:error},'Native opened source was not retained');}
        }
        await verifyPreviewAuthority();
      };
      if(operation==='document'){
        const value=await inspectOffice!(openedSource,proofSource.path,signal);
        await retainOpened();
        const result:NativeMemberOfficeDocumentPage={document_protocol:1,retained,conversation_id:conversationId,run_id:runId,activity_id:activityId,
          member_index:Number(memberIndex),path:proofSource.path,result_sha256:query.result_sha256 as string,
          members_sha256:proofSource.membersSha,open_sha256:openedSha,sha256:openedSource.sha256,size_bytes:openedSource.sizeBytes,
          ...(openProof?{open_proof:openProof}:{}),
          ...(asOfSeq!==undefined?{as_of_seq:asOfSeq as string}:{}),media_type:value.media_type,document:value.document,engine:value.engine,execution_authorized:false};
        return reply.header('x-content-type-options','nosniff').send(result);
      }
      if(operation==='print'){
        const binding=hash({protocol:'jot-native-office-print/v1',owner,activity:original.identity,opened:openedSha});
        const value=await renderOffice!(openedSource,proofSource.path,binding,signal,expectedPdf);
        await retainOpened();
        const derived={sha256:value.pdf.sha256,size:value.pdf.size,pageCount:value.pdf.page_count};
        if(query.preview_proof!==undefined){
          if(!nativeProofs)throw Error('native_file_reference_unproven');
          nativeProofs.assert(owner,proofSource,query.preview_proof as string,derived);
        }
        const previewProof=nativeProofs?.sign(owner,proofSource,derived);
        reply.header('x-activity-native-retained',String(retained));
        if(openProof)reply.header('x-activity-native-open-proof',openProof);
        if(previewProof)reply.header('x-jot-native-preview-proof',previewProof);
        stream=Readable.from([value.pdf.bytes]);
        stream.once('close',()=>{void cleanup().catch(error=>app.log.error({err:error},'Native Office PDF cleanup failed'));});
        return reply.type('application/octet-stream').header('content-length',String(value.pdf.size))
          .header('content-disposition','attachment; filename="office-preview.pdf"').header('x-content-type-options','nosniff')
          .header('x-activity-file-sha256',openedSource.sha256).header('x-activity-file-size',String(openedSource.sizeBytes))
          .header('x-activity-tool-result-sha256',query.result_sha256).header('x-activity-search-members-sha256',proofSource.membersSha)
          .header('x-activity-native-open-sha256',openedSha).header('x-activity-native-member-index',memberIndex)
          .header('x-activity-native-member-path-sha256',createHash('sha256').update(proofSource.path).digest('hex'))
          .header('x-jot-preview-protocol','1').header('x-jot-preview-renderer','libreoffice').header('x-jot-preview-media-type','application/pdf')
          .header('x-jot-preview-sha256',value.pdf.sha256).header('x-jot-preview-size',String(value.pdf.size))
          .header('x-jot-preview-pages',String(value.pdf.page_count)).header('x-jot-execution-authorized','false').send(stream);
      }
      await retainOpened();
      if(openProof)reply.header('x-activity-native-open-proof',openProof);
      reply.header('x-activity-native-retained',String(retained));
      const name = Buffer.from((proofSource.path.split(/[\\/]/).at(-1) || 'file').slice(0,200)).toString('utf8');
      async function* content(){try{yield* openedSource.stream(signal);}finally{await cleanup();}}
      stream = Readable.from(content());
      stream.once('close',()=>{void cleanup().catch(error=>app.log.error({err:error},'Native member download cleanup failed'));});
      reply.type('application/octet-stream').header('content-length',String(openedSource.sizeBytes))
        .header('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16))}`)
        .header('x-content-type-options','nosniff').header('x-activity-file-sha256',openedSource.sha256)
        .header('x-activity-file-size',String(openedSource.sizeBytes)).header('x-activity-tool-result-sha256',query.result_sha256)
        .header('x-activity-search-members-sha256',proofSource.membersSha).header('x-activity-native-open-sha256',openedSha)
        .header('x-activity-native-member-path-sha256',createHash('sha256').update(proofSource.path).digest('hex'))
        .header('x-activity-native-member-index',memberIndex).header('x-jot-execution-authorized','false');
      return reply.send(stream);
    } catch (error) {
      if (stream) {stream.destroy();await cleanup();}
      if(error instanceof Error&&error.message==='native_file_retained_invalid')return reply.code(409).send({error:{code:'NATIVE_FILE_RETAINED_INVALID'}});
      if(error instanceof Error&&error.message==='native_file_reference_unproven')return reply.code(409).send({error:{code:'NATIVE_FILE_REFERENCE_UNPROVEN'}});
      if(error instanceof Error&&error.message==='DOCUMENT_PREVIEW_BUSY')return reply.code(429).header('retry-after','1').send({error:{code:'DOCUMENT_PREVIEW_BUSY'}});
      if (error instanceof SessionAdapterError) return reply.code(error.status === 404 ? 404 : error.status === 429 ? 429 : error.status === 409 ? 409 : 503)
        .send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_UNAVAILABLE'}});
      if (error instanceof Error && (['AbortError','TimeoutError'].includes(error.name)
        || ['native_search_source_invalid','native_file_range_source_invalid'].includes(error.message)))
        return reply.code(503).send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_UNAVAILABLE'}});
      throw error;
    } finally {
      if (!stream) await cleanup();
    }
  };
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result/members/:memberIndex/download',nativeFileRoute('download'));
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result/members/:memberIndex/document',nativeFileRoute('document'));
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result/members/:memberIndex/print',nativeFileRoute('print'));
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result/openings',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const abort=new AbortController(),signal=AbortSignal.any([abort.signal,AbortSignal.timeout(20000)]),reservation={bytes:64*1024*1024};
    let sending=false;
    const cleanup=()=>{downloads.delete(reservation);request.raw.off('aborted',disconnected);reply.raw.off('close',disconnected);reply.raw.off('finish',cleanup);signal.removeEventListener('abort',timedOut);};
    const disconnected=()=>{abort.abort();if(sending)cleanup();};
    const timedOut=()=>{if(sending&&!reply.raw.destroyed)reply.raw.destroy();};
    signal.addEventListener('abort',timedOut,{once:true});
    request.raw.once('aborted',disconnected);reply.raw.once('close',disconnected);
    if(request.raw.aborted||reply.raw.destroyed)disconnected();
    try{
      const owner=actor(request),{conversationId,activityId}=request.params as {conversationId:string;activityId:string};
      const query=request.query as Input,runId=query.run_id,asOfSeq=query.as_of_seq,offsetValue=query.offset_openings??'0',offset=Number(offsetValue);
      if(!ID.test(conversationId)||!ID.test(activityId)||typeof runId!=='string'||!ID.test(runId)
        ||Object.keys(query).some(key=>!['run_id','as_of_seq','offset_openings','openings_sha256'].includes(key))
        ||typeof offsetValue!=='string'||String(offset)!==offsetValue||!Number.isSafeInteger(offset)||offset<0||offset>128
        ||asOfSeq!==undefined&&(typeof asOfSeq!=='string'||asOfSeq.length>19||!/^(0|[1-9][0-9]{0,18})$/.test(asOfSeq)||String(BigInt(asOfSeq))!==asOfSeq||BigInt(asOfSeq)>9223372036854775807n)
        ||query.openings_sha256!==undefined&&(typeof query.openings_sha256!=='string'||query.openings_sha256.length!==64||!SHA.test(query.openings_sha256))
        ||offset>0&&query.openings_sha256===undefined)throw Error('invalid_activity_tool_result_query');
      if(downloads.size>=4||[...downloads].reduce((sum,value)=>sum+value.bytes,0)+reservation.bytes>downloadBudget)
        return reply.code(429).send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_CAPACITY'}});
      downloads.add(reservation);signal.throwIfAborted();
      const original=source(db,owner,conversationId,runId,activityId,asOfSeq as string|undefined);
      const describe=(value:ReturnType<typeof source>)=>({identity:value.identity,semantic:hash({session:value.sessionId,activityId:value.activity.activity_id,toolCallId:value.activity.tool_call_id,
        tool:value.tool,callSeq:value.callSeq,resultSeq:value.resultSeq,call:value.callSha??null,result:value.resultSha??null})});
      const descriptor=describe(original),authorityKey=(boundary:string|undefined,revision:string|undefined)=>JSON.stringify([boundary??null,revision??null]);
      const authorities=new Map<string,{boundary:string|undefined;revision:string|undefined;descriptor:ReturnType<typeof describe>}>();
      const records=retainedRoot?await listRetainedNativeFiles(retainedRoot,signal):[],eligible:typeof records=[];
      let scanned=0;
      for(const record of records){
        if(++scanned%8===0)await new Promise<void>(resolve=>setImmediate(resolve));
        signal.throwIfAborted();const saved=record.source;
        if(saved.conversationId!==conversationId||saved.runId!==runId||saved.activityId!==activityId)continue;
        if(asOfSeq!==undefined&&(saved.asOfSeq!==undefined&&BigInt(saved.asOfSeq)>BigInt(asOfSeq as string)
          ||record.activity_seq!==undefined&&BigInt(record.activity_seq)>BigInt(asOfSeq as string)))continue;
        const key=authorityKey(saved.asOfSeq,record.activity_seq);let authority=authorities.get(key);
        if(!authority){
          try{authority={boundary:saved.asOfSeq,revision:record.activity_seq,descriptor:describe(source(db,owner,conversationId,runId,activityId,saved.asOfSeq,record.activity_seq))};}
          catch(error){if(error instanceof Error&&['activity_tool_result_not_found','activity_tool_result_source_changed','activity_tool_result_source_invalid'].includes(error.message))continue;throw error;}
          authorities.set(key,authority);
        }
        if(authority.descriptor.semantic!==descriptor.semantic||record.binding!==retainedNativeBinding(owner,authority.descriptor.identity,saved.openSha))continue;
        eligible.push(record);
      }
      // Preserve each original context; the requested history boundary never becomes an alias for stored file provenance.
      let checked=0;
      for(const authority of authorities.values()){if(++checked%8===0)await new Promise<void>(resolve=>setImmediate(resolve));signal.throwIfAborted();if(source(db,owner,conversationId,runId,activityId,authority.boundary,authority.revision).identity!==authority.descriptor.identity)throw Error('activity_tool_result_source_changed');}
      if(source(db,owner,conversationId,runId,activityId,asOfSeq as string|undefined).identity!==original.identity)throw Error('activity_tool_result_source_changed');
      const openingSha=hash({protocol:'jot-owned-native-openings/v1',owner,activity:original.identity,records:eligible});
      if(query.openings_sha256!==undefined&&query.openings_sha256!==openingSha||offset>eligible.length)throw Error('activity_tool_result_source_changed');
      const selected=eligible.slice(offset,offset+8);
      const result:ActivityNativeFileOpeningsPage={conversation_id:conversationId,run_id:runId,activity_id:activityId,tool_name:original.tool,
        scope:'owned_opened_files',openings_sha256:openingSha,offset_openings:offset,total_openings:eligible.length,
        ...(asOfSeq!==undefined?{as_of_seq:asOfSeq as string}:{}),
        items:selected.map(({source:saved})=>({member_index:saved.memberIndex,path:saved.path,result_sha256:saved.resultSha,members_sha256:saved.membersSha,
          open_sha256:saved.openSha,sha256:saved.sha256,size_bytes:saved.size,...(saved.asOfSeq!==undefined?{source_as_of_seq:saved.asOfSeq}:{})})),
        ...(offset+selected.length<eligible.length?{next_offset_openings:offset+selected.length}:{}),execution_authorized:false};
      sending=true;reply.raw.once('finish',cleanup);return reply.send(result);
    }catch(error){
      if(sending){sending=false;cleanup();}
      if(error instanceof Error&&['native_file_retained_invalid','native_file_retained_changed'].includes(error.message))return reply.code(409).send({error:{code:'NATIVE_FILE_RETAINED_INVALID'}});
      if(error instanceof Error&&['AbortError','TimeoutError'].includes(error.name)||/^E[A-Z]+$/.test(String((error as NodeJS.ErrnoException)?.code??'')))return reply.code(503).send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_UNAVAILABLE'}});
      throw error;
    }finally{if(!sending)cleanup();}
  });
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result/members',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const abort = new AbortController(), disconnected = () => abort.abort();
    request.raw.once('aborted',disconnected);
    reply.raw.once('close',disconnected);
    if (request.raw.aborted || reply.raw.destroyed) disconnected();
    try {
      const owner = actor(request), {conversationId,activityId} = request.params as {conversationId:string;activityId:string};
      const query = request.query as Input, runId = query.run_id, offsetValue = query.offset_members ?? '0', asOfSeq = query.as_of_seq;
      if (!ID.test(conversationId) || !ID.test(activityId) || typeof runId !== 'string' || !ID.test(runId)
        || Object.keys(query).some(key=>!['run_id','offset_members','result_sha256','members_sha256','as_of_seq'].includes(key))
        || asOfSeq !== undefined && (typeof asOfSeq !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(asOfSeq) || BigInt(asOfSeq)>9223372036854775807n)
        || typeof offsetValue !== 'string' || !/^(0|[1-9]\d{0,7})$/.test(offsetValue)
        || ['result_sha256','members_sha256'].some(key=>query[key] !== undefined && (typeof query[key] !== 'string' || !SHA.test(query[key] as string))))
        throw Error('invalid_activity_tool_result_query');
      const offset = Number(offsetValue);
      if (offset > MAX_CHARS || offset > 0 && (query.result_sha256 === undefined || query.members_sha256 === undefined))
        throw Error('invalid_activity_tool_result_query');
      const original = source(db,owner,conversationId,runId,activityId,asOfSeq as string|undefined);
      if (!client?.readNativeSearchMembers) throw Error('activity_tool_result_source_invalid');
      const signal = AbortSignal.any([abort.signal,AbortSignal.timeout(20000)]);
      const input:NativeSearchMembersRequest = {call_seq:original.callSeq,tool_name:original.tool,offset_members:offset,
        ...(query.members_sha256 ? {members_sha256:query.members_sha256 as string} : {})};
      const response = await readMembers(client,owner,original,input,signal);
      if (source(db,owner,conversationId,runId,activityId,asOfSeq as string|undefined).identity !== original.identity)
        throw Error('activity_tool_result_source_changed');
      const resultSha = memberResultHash(original,response);
      if (query.result_sha256 !== undefined && query.result_sha256 !== resultSha) throw Error('activity_tool_result_source_changed');
      const result:ActivityNativeSearchMembersPage = {conversation_id:conversationId,run_id:runId,activity_id:activityId,
        tool_name:original.tool,result_sha256:resultSha,members_sha256:response.members_sha256,offset_members:offset,
        total_members:response.total_members,original_total:response.original_total,items:response.items,
        ...(asOfSeq !== undefined ? {as_of_seq:asOfSeq as string} : {}),
        ...(response.next_offset_members !== undefined ? {next_offset_members:response.next_offset_members} : {}),execution_authorized:false};
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === 'native_search_source_invalid') throw Error('activity_tool_result_source_invalid');
      if (error instanceof SessionAdapterError) return reply.code(error.status === 404 ? 404 : error.status === 429 ? 429 : error.status === 409 ? 409 : 503)
        .send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_UNAVAILABLE'}});
      if (error instanceof Error && ['AbortError','TimeoutError'].includes(error.name))
        return reply.code(503).send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_UNAVAILABLE'}});
      throw error;
    } finally {
      request.raw.off('aborted',disconnected);
      reply.raw.off('close',disconnected);
    }
  });
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result/source',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const abort = new AbortController(), disconnected = () => abort.abort();
    request.raw.once('aborted',disconnected);
    reply.raw.once('close',disconnected);
    if (request.raw.aborted || reply.raw.destroyed) disconnected();
    try {
      const owner = actor(request), {conversationId,activityId} = request.params as {conversationId:string;activityId:string};
      const query = request.query as Input, runId = query.run_id, offsetValue = query.offset_chars ?? '0', asOfSeq=query.as_of_seq;
      if (!ID.test(conversationId) || !ID.test(activityId) || typeof runId !== 'string' || !ID.test(runId)
        || Object.keys(query).some(key=>!['run_id','offset_chars','result_sha256','text_sha256','as_of_seq'].includes(key))
        || asOfSeq!==undefined&&(typeof asOfSeq!=='string'||!/^(0|[1-9]\d{0,18})$/.test(asOfSeq)||BigInt(asOfSeq)>9223372036854775807n)
        || typeof offsetValue !== 'string' || !/^(0|[1-9]\d{0,7})$/.test(offsetValue)
        || ['result_sha256','text_sha256'].some(key=>query[key] !== undefined && (typeof query[key] !== 'string' || !SHA.test(query[key] as string))))
        throw Error('invalid_activity_tool_result_query');
      const offset = Number(offsetValue);
      if (offset > MAX_CHARS || offset > 0 && (query.result_sha256 === undefined || query.text_sha256 === undefined))
        throw Error('invalid_activity_tool_result_query');
      const original = source(db,owner,conversationId,runId,activityId,asOfSeq as string|undefined);
      if (!client) throw Error('activity_tool_result_source_invalid');
      const signal = AbortSignal.any([abort.signal,AbortSignal.timeout(20000)]);
      const response = page(await client.readNativeSearchSource(owner,original.sessionId,{call_seq:original.callSeq,
        tool_name:original.tool,offset_chars:offset,...(query.text_sha256 ? {source_sha256:query.text_sha256 as string} : {})},signal),original,offset);
      signal.throwIfAborted();
      if (source(db,owner,conversationId,runId,activityId,asOfSeq as string|undefined).identity !== original.identity) throw Error('activity_tool_result_source_changed');
      const resultSha = resultHash(original,response);
      if (query.result_sha256 !== undefined && query.result_sha256 !== resultSha
        || query.text_sha256 !== undefined && query.text_sha256 !== response.source_sha256) throw Error('activity_tool_result_source_changed');
      const result:ActivityToolResultPage = {conversation_id:conversationId,run_id:runId,activity_id:activityId,
        tool_name:original.tool,source:'native',operation:original.tool,source_truncated:original.tool === 'grep',
        ...(asOfSeq!==undefined?{as_of_seq:asOfSeq as string}:{}),
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
