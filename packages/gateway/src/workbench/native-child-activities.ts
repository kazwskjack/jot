import {bindToolArtifactReceipts} from '../harness/tool-artifact-receipts.ts';
import {createHash} from 'node:crypto';
import {constants as bufferConstants} from 'node:buffer';
import type {DatabaseSync} from 'node:sqlite';
import type {EventStore} from '../events/event-store.ts';
import {withImmediateTransaction,withReadTransaction} from '../db/database.ts';
import {assertExecutionLease} from './execution-lease.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {parsePublicNativeToolResult,parsePublicNativeToolCall,nativeBatchWebCall} from '../harness/native-tool-result.js';
import {readNativeMemberExecution} from './native-member-owner-controls.ts';
import {projectNativeToolEvent,projectWebOperationSnapshot,sessionToolCallId,type ProjectionContext} from '../harness/session-event-projector.ts';

type Input=Record<string,unknown>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA=/^[a-f0-9]{64}$/;
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Original native tool observation receipts. Projection never admits execution. */
export class NativeChildActivities {
 constructor(private readonly db:DatabaseSync,private readonly events:EventStore,private readonly guardLive:(input:Input)=>void){
  if(!events.usesDatabase(db))throw Error('native_activity_store_mismatch');
  db.exec(`CREATE TABLE IF NOT EXISTS wb_native_activity_receipts(
   run_id TEXT NOT NULL REFERENCES ga_runs(id),source_seq INTEGER NOT NULL,source_sha256 TEXT NOT NULL,
   event_type TEXT NOT NULL,call_id TEXT,projection_json TEXT,created_at TEXT NOT NULL,PRIMARY KEY(run_id,source_seq));
   CREATE INDEX IF NOT EXISTS wb_native_activity_call ON wb_native_activity_receipts(run_id,event_type,call_id,source_seq);
   CREATE TRIGGER IF NOT EXISTS wb_native_activity_receipt_no_update BEFORE UPDATE ON wb_native_activity_receipts
    BEGIN SELECT RAISE(ABORT,'native_activity_receipt_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_native_activity_receipt_no_delete BEFORE DELETE ON wb_native_activity_receipts
    BEGIN SELECT RAISE(ABORT,'native_activity_receipt_immutable'); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS wb_native_activity_chunks(
   run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,source_seq INTEGER NOT NULL,
   transport_sha256 TEXT NOT NULL,chunk_index INTEGER NOT NULL,chunk_count INTEGER NOT NULL,
   source_sha256 TEXT NOT NULL,chunk_sha256 TEXT NOT NULL,chunk_json TEXT NOT NULL,created_at TEXT NOT NULL,
   PRIMARY KEY(run_id,source_seq,transport_sha256,chunk_index));
   CREATE TRIGGER IF NOT EXISTS wb_native_activity_chunk_no_update BEFORE UPDATE ON wb_native_activity_chunks
    BEGIN SELECT RAISE(ABORT,'native_activity_chunk_immutable'); END;`);
 }
 /** Component-scoped metadata for original closed executions awaiting public replay. */
 pending(input:Input){
  const cursor=input.cursor,limit=input.limit===undefined?25:Number(input.limit);
  if(cursor!==undefined&&(typeof cursor!=='string'||!ID.test(cursor))
   ||input.limit!==undefined&&typeof input.limit!=='number'&&typeof input.limit!=='string'
   ||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('native_activity_pending_query_invalid');
  return withReadTransaction(this.db,()=>{
   if(cursor!==undefined&&!this.db.prepare(`SELECT 1 FROM wb_native_execution_runs n
    JOIN wb_native_execution_closures k ON k.run_id=n.run_id WHERE n.run_id=?`).get(cursor as string))throw Error('native_activity_pending_query_invalid');
   const rows=this.db.prepare(`SELECT n.run_id,n.child_session_ref FROM wb_native_execution_runs n
    JOIN wb_native_execution_closures k ON k.run_id=n.run_id
    JOIN wb_native_spawn_publications p ON p.reservation_id=n.reservation_id
    JOIN wb_run_bindings b ON b.run_id=n.run_id AND b.owner_id=n.owner_id AND b.kind='native_team' AND b.agent_id=n.role_id
    JOIN ga_runs r ON r.id=n.run_id JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=n.owner_id
    JOIN ga_harness_session_bindings h ON h.conversation_id=c.id AND h.owner_id=c.owner_id AND h.session_id=n.child_session_ref
    JOIN ga_runs root ON root.id=n.root_run_id JOIN ga_conversations pc ON pc.id=root.conversation_id AND pc.owner_id=c.owner_id
    WHERE json_extract(p.publication_json,'$.member.id')=n.child_session_ref AND json_extract(p.publication_json,'$.member.role')='teammate'
     AND NOT EXISTS(SELECT 1 FROM wb_native_activity_receipts x WHERE x.run_id=n.run_id AND x.event_type='replay/complete'
      AND x.source_seq=json_extract(k.receipt_json,'$.seq_exclusive') AND x.source_sha256=json_extract(k.receipt_json,'$.log_sha256'))
     ${cursor===undefined?'':'AND n.run_id>?'} ORDER BY n.run_id LIMIT ?`)
    .all(...(cursor===undefined?[]:[cursor as string]),limit+1) as Array<{run_id:string;child_session_ref:string}>;
   const selected=rows.slice(0,limit),last=selected.at(-1);
   return {protocol:1,kind:'native_closed_activity_pending',execution_authorized:false,
    items:selected.map(row=>({run_id:row.run_id,session_ref:row.child_session_ref})),
    ...(rows.length>limit&&last?{next_cursor:last.run_id}:{})};
  });
 }
 source(owner:string,runId:string,sessionRef:string){
  return withReadTransaction(this.db,()=>this.sourceInside(owner,runId,sessionRef));
 }
 liveSource(owner:string,runId:string,sessionRef:string,input:Input){
  return withReadTransaction(this.db,()=>this.liveSourceInside(owner,runId,sessionRef,input));
 }
 /** Stage bounded public observations, then publish through the original receipt transaction. */
 appendChunk(owner:string,runId:string,sessionRef:string,input:Input){
  const format=input.observation_format===undefined?'public-call-v1':input.observation_format;
  const seq=input.event_seq,index=input.chunk_index,count=input.chunk_count,data=input.chunk_data;
  const sourceSha=input.source_event_sha256,transportSha=input.event_sha256,chunkSha=input.chunk_sha256;
  if(typeof format!=='string'||!['public-call-v1','public-result-v1'].includes(format)||!Number.isSafeInteger(seq)||Number(seq)<0||!Number.isSafeInteger(index)||Number(index)<0
   ||!Number.isSafeInteger(count)||Number(count)<1||Number(count)>Math.ceil(bufferConstants.MAX_STRING_LENGTH/65_536)
   ||Number(index)>=Number(count)||typeof data!=='string'||data.length<1||data.length>65_536
   ||Number(index)<Number(count)-1&&data.length!==65_536
   ||typeof sourceSha!=='string'||!SHA.test(sourceSha)||typeof transportSha!=='string'||!SHA.test(transportSha)
   ||typeof chunkSha!=='string'||!SHA.test(chunkSha)||digest(data)!==chunkSha)throw Error('native_activity_chunk_invalid');
  return withImmediateTransaction(this.db,()=>{
   const live=input.action==='live-append-chunk';
   const source=live?this.liveSourceInside(owner,runId,sessionRef,input):this.sourceInside(owner,runId,sessionRef);
   if(Number(seq)<source.source_start)throw Error('native_activity_source_changed');
   if(live){
    if(!('snapshot_sha256' in source)||input.source_snapshot_sha256!==source.snapshot_sha256)throw Error('native_activity_source_changed');
   }else if(!('log_sha256' in source)||input.source_log_sha256!==source.log_sha256||Number(seq)>=source.source_end){
    throw Error('native_activity_source_changed');
   }
   const prior=this.db.prepare('SELECT source_sha256,projection_json,event_type FROM wb_native_activity_receipts WHERE run_id=? AND source_seq=?')
    .get(runId,Number(seq)) as {source_sha256:string;projection_json:string|null;event_type:string}|undefined;
   if(prior){
    if(prior.source_sha256!==sourceSha||prior.event_type!==(format==='public-call-v1'?'tool/call':'tool/result'))throw Error('native_activity_receipt_conflict');
   }
   if(prior&&(format==='public-call-v1'||live)){
    this.db.prepare('DELETE FROM wb_native_activity_chunks WHERE run_id=? AND source_seq=?').run(runId,Number(seq));
    return this.receipt(runId,sessionRef,Number(seq),sourceSha,prior.projection_json);
   }
   if(!prior&&(source.complete||source.last_event_seq!==null&&Number(seq)<=source.last_event_seq))throw Error('native_activity_event_order');
   const identity=this.db.prepare('SELECT source_sha256 FROM wb_native_activity_chunks WHERE run_id=? AND source_seq=? LIMIT 1')
    .get(runId,Number(seq)) as {source_sha256:string}|undefined;
   if(identity&&identity.source_sha256!==sourceSha)throw Error('native_activity_receipt_conflict');
   const first=this.db.prepare(`SELECT chunk_count FROM wb_native_activity_chunks
    WHERE run_id=? AND source_seq=? AND transport_sha256=? AND chunk_index=0`)
    .get(runId,Number(seq),transportSha) as {chunk_count:number}|undefined;
   if(first&&first.chunk_count!==count)throw Error('native_activity_chunk_conflict');
   const existing=this.db.prepare(`SELECT chunk_sha256,chunk_json FROM wb_native_activity_chunks
    WHERE run_id=? AND source_seq=? AND transport_sha256=? AND chunk_index=?`)
    .get(runId,Number(seq),transportSha,Number(index)) as {chunk_sha256:string;chunk_json:string}|undefined;
   if(existing){
    if(existing.chunk_sha256!==chunkSha||existing.chunk_json!==JSON.stringify(data))throw Error('native_activity_chunk_conflict');
   }else{
    const last=this.db.prepare(`SELECT MAX(chunk_index) chunk_index FROM wb_native_activity_chunks
     WHERE run_id=? AND source_seq=? AND transport_sha256=?`).get(runId,Number(seq),transportSha) as {chunk_index:number|null};
    if(Number(index)!==(last.chunk_index??-1)+1)throw Error('native_activity_chunk_order');
    this.db.prepare('INSERT INTO wb_native_activity_chunks VALUES(?,?,?,?,?,?,?,?,?)')
     .run(runId,Number(seq),transportSha,Number(index),Number(count),sourceSha,chunkSha,JSON.stringify(data),new Date().toISOString());
   }
   if(Number(index)<Number(count)-1){
    return {accepted:false,staged:true,execution_authorized:false,run_id:runId,session_ref:sessionRef,
     event_seq:Number(seq),event_sha256:sourceSha,chunk_index:Number(index),chunk_sha256:chunkSha};
   }
   let encoded='',position=0;
   for(const row of this.db.prepare(`SELECT chunk_index,chunk_json FROM wb_native_activity_chunks
    WHERE run_id=? AND source_seq=? AND transport_sha256=? ORDER BY chunk_index`)
    .iterate(runId,Number(seq),transportSha) as Iterable<{chunk_index:number;chunk_json:string}>){
    if(row.chunk_index!==position++)throw Error('native_activity_chunk_order');
    // JSON quoting preserves a surrogate pair split across two SQLite text values.
    const chunk=JSON.parse(row.chunk_json) as string;
    if(encoded.length+chunk.length>bufferConstants.MAX_STRING_LENGTH)throw Error('native_activity_chunk_invalid');
    encoded+=chunk;
   }
   if(position!==count)throw Error('native_activity_chunk_order');
   const observation=JSON.parse(encoded) as Input;
   const event=observation?.event as Input|undefined;
   if(!observation||typeof observation!=='object'||Array.isArray(observation)
    ||Object.keys(observation).sort().join(',')!==(format==='public-call-v1'?'event,public_call':'event,public_result')||event?.seq!==seq)throw Error('native_activity_chunk_invalid');
   const receipt=this.append(owner,runId,sessionRef,{...input,action:live?'live-append':'append',
    event_format:format,event,...(format==='public-call-v1'?{public_call:observation.public_call}:{public_result:observation.public_result})});
   return receipt;
  });
 }
 append(owner:string,runId:string,sessionRef:string,input:Input){
  const event=input.event as Input|undefined;
  const summarizedResult=input.event_format==='public-result-v1';
  const summarizedCall=input.event_format==='public-call-v1';
  const summarized=summarizedResult||summarizedCall;
  if(input.event_format!==undefined&&!summarized
   ||!summarized&&(input.public_result!==undefined||input.public_call!==undefined||input.source_event_sha256!==undefined)
   ||summarizedResult&&input.public_call!==undefined||summarizedCall&&input.public_result!==undefined)throw Error('native_activity_event_invalid');
  const publicResult=summarizedResult?parsePublicNativeToolResult(input.public_result):undefined;
  const publicCall=summarizedCall?parsePublicNativeToolCall(input.public_call):undefined;
  const observation=summarizedResult?{event,public_result:input.public_result}:summarizedCall?{event,public_call:input.public_call}:event;
  const sourceSha=summarized?input.source_event_sha256:input.event_sha256;
  if(typeof sourceSha!=='string'||!SHA.test(sourceSha))throw Error('native_activity_event_invalid');
  if(!event||typeof event!=='object'||Array.isArray(event)||!['tool/call','tool/result'].includes(String(event.type))
   ||!Number.isSafeInteger(event.seq)||Number(event.seq)<0||!Number.isSafeInteger(event.time)||Number(event.time)<0||Number(event.time)>8640000000000000
   ||!event.data||typeof event.data!=='object'||Array.isArray(event.data)
   ||event.type==='tool/result'&&event.surfaceOp!==undefined&&event.surfaceOp!=='append'
   ||typeof input.event_sha256!=='string'||!SHA.test(input.event_sha256)||digest(observation)!==input.event_sha256)throw Error('native_activity_event_invalid');
  if(summarized&&(Object.keys(event).sort().join(',')!=='data,seq,time,type'
   ||summarizedResult&&(event.type!=='tool/result'||Object.keys(event.data as Input).sort().join(',')!=='callId')
   ||summarizedCall&&(event.type!=='tool/call'||Object.keys(event.data as Input).sort().join(',')!=='callId,name'
    ||typeof (event.data as Input).name!=='string'
    ||publicCall?.delegates&&(event.data as Input).name!=='jot_workspace'
    ||publicCall?.native_batch_web!==undefined&&publicCall.native_batch_web!==(event.data as Input).name)))throw Error('native_activity_event_invalid');
  const callId=sessionToolCallId(event.data as Input);
  if(typeof callId!=='string'||!ID.test(callId))throw Error('native_activity_event_invalid');
  return withImmediateTransaction(this.db,()=>{
   const live=input.action==='live-append';
   const source=live?this.liveSourceInside(owner,runId,sessionRef,input):this.sourceInside(owner,runId,sessionRef);
   if(Number(event.seq)<source.source_start)throw Error('native_activity_source_changed');
   if(live){
    if(!('snapshot_sha256' in source)||input.source_snapshot_sha256!==source.snapshot_sha256)throw Error('native_activity_source_changed');
   }else if(!('log_sha256' in source)||input.source_log_sha256!==source.log_sha256||Number(event.seq)>=source.source_end){
    throw Error('native_activity_source_changed');
   }
   const prior=this.db.prepare('SELECT source_sha256,projection_json FROM wb_native_activity_receipts WHERE run_id=? AND source_seq=?')
    .get(runId,Number(event.seq)) as {source_sha256:string;projection_json:string|null}|undefined;
   if(prior){
    if(prior.source_sha256!==sourceSha)throw Error('native_activity_receipt_conflict');
    if(!live&&event.type==='tool/result'&&prior.projection_json){
     const original=JSON.parse(prior.projection_json) as Input;
     const context={runId,sessionRef,attemptId:String(original.attempt_id??'native-observation'),messageId:'native-observation',
      blockId:'native-observation',deltaIndex:0,at:new Date(Number(event.time)).toISOString()};
     const refined=this.settledWebProjection(runId,sessionRef,callId,context,original);
     if(refined!==original){
      const final={...refined,activity_id:original.activity_id};
      const latest=this.db.prepare(`SELECT payload_json FROM ga_events WHERE conversation_id=? AND run_id=? AND type='activity.upsert'
       AND json_extract(payload_json,'$.activity_id')=? ORDER BY seq DESC LIMIT 1`).get(source.conversation_id,runId,String(original.activity_id)) as {payload_json:string}|undefined;
      if(!latest||latest.payload_json!==JSON.stringify(final))this.events.append(source.conversation_id,runId,'activity.upsert',final);
     }
    }
    this.db.prepare('DELETE FROM wb_native_activity_chunks WHERE run_id=? AND source_seq=?').run(runId,Number(event.seq));
    return this.receipt(runId,sessionRef,Number(event.seq),prior.source_sha256,prior.projection_json);
   }
   if(source.complete||source.last_event_seq!==null&&Number(event.seq)<=source.last_event_seq)throw Error('native_activity_event_order');
   const call=event.type==='tool/result'?this.db.prepare(`SELECT source_seq,projection_json FROM wb_native_activity_receipts
    WHERE run_id=? AND event_type='tool/call' AND call_id=? AND source_seq<? ORDER BY source_seq DESC LIMIT 1`)
    .get(runId,callId,Number(event.seq)) as {source_seq:number;projection_json:string}|undefined:undefined;
   const token=createHash('sha256').update(JSON.stringify([runId,callId,call?.source_seq??event.seq])).digest('hex');
   const context={runId,sessionRef,attemptId:`native-${token.slice(0,24)}`,
    messageId:'native-observation',blockId:'native-observation',deltaIndex:0,at:new Date(Number(event.time)).toISOString()};
   const callProjection=call?JSON.parse(call.projection_json):undefined;
   const projection=projectNativeToolEvent(event,context,callProjection,publicResult,publicCall);
   if(!projection||projection.type!=='activity.upsert')throw Error('native_activity_event_invalid');
   const linked=bindToolArtifactReceipts(this.db,source.conversation_id,runId,projection.payload,projection.artifactReceipts);
   let observed=event.type==='tool/result'?this.settledWebProjection(runId,sessionRef,callId,context,linked):linked;
   if(live&&event.type==='tool/result'&&callProjection?.native_batch_web&&observed.status!=='failed'){
    observed={...observed,status:'unknown',title:'网页任务结果待核对'};
    delete observed.ended_at;
   }
   const payload={...observed,activity_id:`native-tool-${token}`};
   const batch=event.type==='tool/call'&&!publicCall?nativeBatchWebCall(event.data as Input):null;
   const batchName=publicCall?.native_batch_web??batch?.name;
   const encoded=JSON.stringify(batchName?{...payload,native_batch_web:batchName}:payload);
   this.db.prepare('INSERT INTO wb_native_activity_receipts VALUES(?,?,?,?,?,?,?)')
    .run(runId,Number(event.seq),sourceSha,String(event.type),callId,encoded,new Date().toISOString());
   this.events.append(source.conversation_id,runId,'activity.upsert',payload);
   this.db.prepare('DELETE FROM wb_native_activity_chunks WHERE run_id=? AND source_seq=?').run(runId,Number(event.seq));
   return this.receipt(runId,sessionRef,Number(event.seq),sourceSha,encoded);
  });
 }
 complete(owner:string,runId:string,sessionRef:string,input:Input){
  return withImmediateTransaction(this.db,()=>{
   const source=this.sourceInside(owner,runId,sessionRef);
   if(input.source_log_sha256!==source.log_sha256||input.expected_last_event_seq!==source.last_event_seq)throw Error('native_activity_source_changed');
   if(!source.complete)this.db.prepare('INSERT INTO wb_native_activity_receipts VALUES(?,?,?,?,?,?,?)')
    .run(runId,source.source_end,source.log_sha256,'replay/complete',null,null,new Date().toISOString());
   this.db.prepare('DELETE FROM wb_native_activity_chunks WHERE run_id=?').run(runId);
   return {...source,complete:true};
  });
 }
 private settledWebProjection(runId:string,sessionRef:string,callId:string,context:ProjectionContext,payload:Input):Input{
  const settled=this.db.prepare(`SELECT op.value,stamp.created_at FROM wb_native_execution_closures c,json_each(c.receipt_json,'$.remote_operations') op,
   (SELECT run_id,created_at FROM wb_native_child_closures UNION ALL SELECT run_id,created_at FROM wb_native_activation_closures) stamp
   WHERE c.run_id=? AND stamp.run_id=c.run_id AND json_extract(op.value,'$.request_id')=? AND json_extract(op.value,'$.session_ref')=?`)
   .get(runId,callId,sessionRef) as {value:string;created_at:string}|undefined;
  if(!settled)return payload;
  const operation=JSON.parse(settled.value),counts:Record<string,number>={};
  for(const item of operation.items)counts[item.status]=(counts[item.status]??0)+1;
  const snapshot=projectWebOperationSnapshot(callId,operation.tool_name,{...operation,
   kind:String(operation.tool_name).replace(/^universe_/,''),counts},{...context,at:settled.created_at});
  if(!snapshot)throw Error('native_activity_web_source_invalid');
  return {...snapshot.payload,tool_call_id:payload.tool_call_id,started_at:payload.started_at,
   ...(payload.detail&&typeof payload.detail==='object'&&!Array.isArray(payload.detail)&&'result_artifacts' in payload.detail
    ?{detail:{...(snapshot.payload.detail as Input),result_artifacts:payload.detail.result_artifacts}}:{})};
 }
 private liveSourceInside(owner:string,runId:string,sessionRef:string,input:Input){
  if(input.run_id!==runId||input.session_ref!==sessionRef)throw Error('workbench_identity_forbidden');
  assertExecutionLease(this.db,runId,input.execution_lease);this.guardLive(input);
  const row=this.db.prepare(`SELECT n.root_run_id,n.snapshot_json,n.previous_run_id,r.conversation_id
   FROM wb_native_execution_runs n JOIN ga_runs r ON r.id=n.run_id
   WHERE n.run_id=? AND n.owner_id=? AND n.child_session_ref=?`).get(runId,owner,sessionRef) as
   {root_run_id:string;snapshot_json:string;previous_run_id:string|null;conversation_id:string}|undefined;
  if(!row)throw Error('workbench_identity_forbidden');
  const saved=JSON.parse(row.snapshot_json);
  const execution=readNativeMemberExecution(this.db,owner,row.root_run_id,sessionRef,saved.parent_session_ref,runId);
  const start=row.previous_run_id===null?0:saved.source_seq_exclusive;
  if(!Number.isSafeInteger(start)||start<0||execution.child_conversation_id!==row.conversation_id)throw Error('native_activity_source_changed');
  const last=this.db.prepare("SELECT MAX(source_seq) seq FROM wb_native_activity_receipts WHERE run_id=? AND event_type<>'replay/complete'").get(runId) as {seq:number|null};
  return {protocol:1,kind:'native_child_live_observation',run_id:runId,session_ref:sessionRef,conversation_id:row.conversation_id,
   parent_session_ref:saved.parent_session_ref,source_start:start as number,snapshot_sha256:createHash('sha256').update(row.snapshot_json).digest('hex'),
   last_event_seq:last.seq,complete:false,execution_authorized:false};
 }
 private receipt(runId:string,sessionRef:string,seq:number,sha:string,encoded:string|null){
  return {accepted:true,run_id:runId,session_ref:sessionRef,event_seq:seq,event_sha256:sha,
   activity_id:encoded?JSON.parse(encoded).activity_id:null,execution_authorized:false};
 }
 private sourceInside(owner:string,runId:string,sessionRef:string){
  if(!ID.test(owner)||!ID.test(runId)||!ID.test(sessionRef))throw Error('workbench_identity_forbidden');
  const row=this.db.prepare(`SELECT n.root_run_id,n.snapshot_json,n.previous_run_id,k.receipt_json,
   r.conversation_id,parent_session.session_id parent_session_ref FROM wb_native_execution_runs n
   JOIN wb_native_execution_closures k ON k.run_id=n.run_id JOIN ga_runs r ON r.id=n.run_id
   JOIN ga_runs root ON root.id=n.root_run_id
   JOIN wb_run_bindings parent_binding ON parent_binding.run_id=root.id AND parent_binding.owner_id=n.owner_id AND parent_binding.kind='task'
   JOIN ga_run_native_sessions parent_session ON parent_session.run_id=root.id AND parent_session.conversation_id=root.conversation_id AND parent_session.owner_id=n.owner_id
   WHERE n.run_id=? AND n.owner_id=? AND n.child_session_ref=?`).get(runId,owner,sessionRef) as
   {root_run_id:string;snapshot_json:string;previous_run_id:string|null;receipt_json:string;conversation_id:string;parent_session_ref:string}|undefined;
  if(!row)throw Error('native_activity_closure_required');
  const saved=JSON.parse(row.snapshot_json),proof=JSON.parse(row.receipt_json);
  if(!saved||typeof saved!=='object'||Array.isArray(saved)||!proof||typeof proof!=='object'||Array.isArray(proof))throw Error('native_activity_source_changed');
  const start=row.previous_run_id===null?0:saved.source_seq_exclusive;
  if(saved.owner_id!==owner||saved.root_run_id!==row.root_run_id||saved.child_session_ref!==sessionRef
   ||saved.parent_session_ref!==row.parent_session_ref||proof.session_ref!==sessionRef||proof.parent_session_ref!==saved.parent_session_ref
   ||proof.protocol!==1||proof.driver_nonresident!==true||proof.inbox_pending!==0||typeof proof.log_sha256!=='string'||!SHA.test(proof.log_sha256)
   ||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(proof.seq_exclusive)||proof.seq_exclusive<start)throw Error('native_activity_source_changed');
  const execution=readNativeMemberExecution(this.db,owner,row.root_run_id,sessionRef,row.parent_session_ref,runId);
  if(execution.child_conversation_id!==row.conversation_id)throw Error('native_activity_source_changed');
  if(row.previous_run_id!==null){
   const previous=this.db.prepare('SELECT receipt_json FROM wb_native_execution_closures WHERE run_id=?').get(row.previous_run_id) as {receipt_json:string}|undefined;
   const prior=previous?JSON.parse(previous.receipt_json):undefined;
   if(!prior||saved.previous_run_id!==row.previous_run_id||prior.seq_exclusive!==start||prior.log_sha256!==saved.source_log_sha256)throw Error('native_activity_source_changed');
  }
  const last=this.db.prepare("SELECT MAX(source_seq) seq FROM wb_native_activity_receipts WHERE run_id=? AND event_type<>'replay/complete'").get(runId) as {seq:number|null};
  const complete=!!this.db.prepare("SELECT 1 FROM wb_native_activity_receipts WHERE run_id=? AND source_seq=? AND event_type='replay/complete' AND source_sha256=?").get(runId,proof.seq_exclusive,proof.log_sha256);
  return {protocol:1,run_id:runId,session_ref:sessionRef,conversation_id:row.conversation_id,parent_session_ref:saved.parent_session_ref,
   source_start:start as number,source_end:proof.seq_exclusive as number,log_sha256:proof.log_sha256 as string,last_event_seq:last.seq,complete,
   settled_web_call_ids:(proof.remote_operations??[]).map((operation:Input)=>String(operation.request_id)),execution_authorized:false};
 }
}
