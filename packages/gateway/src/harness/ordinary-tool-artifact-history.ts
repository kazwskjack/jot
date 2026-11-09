import type {DatabaseSync} from 'node:sqlite';
import type {EventStore} from '../events/event-store.ts';
import type {OrdinaryRunCompletion,OrdinaryRunHistoryScope} from './ordinary-run-completion.ts';
import {publicNativeToolResult,type NativeArtifactReceipt} from './native-tool-result.js';
import {sessionProjectionId,sessionToolCallId} from './session-event-projector.ts';
import {bindToolArtifactReceipts} from './tool-artifact-receipts.ts';

type Payload=Record<string,unknown>;

/** Caller holds the original transaction after validating both native proof reads. */
export function linkOrdinaryToolArtifactHistory(db:DatabaseSync,events:EventStore,scope:OrdinaryRunHistoryScope,
 sessionId:string,sourceSha256:string,proof:OrdinaryRunCompletion):void{
 if(!db.isTransaction||!events.usesDatabase(db)||proof.protocol!==1||proof.kind!=='ordinary_run_completion'
  ||proof.execution_authorized!==false||proof.run_id!==scope.run_id||proof.session_id!==sessionId
  ||proof.run_version!==scope.expected_run_version||proof.source_sha256!==sourceSha256)throw Error('ordinary_activity_projection_source_invalid');
 if(!db.prepare(`SELECT 1 FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
  WHERE r.id=? AND r.version=? AND c.id=? AND c.owner_id=?`)
  .get(scope.run_id,scope.expected_run_version,scope.conversation_id,scope.owner_id))throw Error('ordinary_activity_projection_source_invalid');
 const groups=new Map<string,{ambiguous:boolean;receipts:NativeArtifactReceipt[]}>();
 for(const event of proof.output_events){
  if(event.type!=='tool/result'||event.surfaceOp!==undefined&&event.surfaceOp!=='append')continue;
  const data=event.data as Payload,rawId=sessionToolCallId(data);
  if(typeof rawId!=='string')continue;
  const id=sessionProjectionId(rawId,'');
  if(!id)continue;
  const previous=groups.get(id);
  // Normalized-ID collisions and repeated results cannot select a unique old step.
  if(previous){previous.ambiguous=true;previous.receipts=[];continue;}
  groups.set(id,{ambiguous:false,receipts:publicNativeToolResult(data).artifact_receipts??[]});
 }
 const activities=db.prepare(`SELECT DISTINCT json_extract(payload_json,'$.activity_id') activity_id FROM ga_events
  WHERE conversation_id=? AND run_id=? AND type='activity.upsert' AND json_valid(payload_json)
   AND json_extract(payload_json,'$.tool_call_id')=? LIMIT 2`);
 const latest=db.prepare(`SELECT payload_json FROM ga_events WHERE conversation_id=? AND run_id=? AND type='activity.upsert'
  AND json_valid(payload_json) AND json_extract(payload_json,'$.activity_id')=? ORDER BY seq DESC LIMIT 1`);
 for(const [callId,group] of groups){
  if(group.ambiguous||!group.receipts.length)continue;
  const matches=activities.all(scope.conversation_id,scope.run_id,callId) as Array<{activity_id:unknown}>;
  const match=matches[0];
  if(matches.length!==1||typeof match?.activity_id!=='string')continue;
  const activityId=match.activity_id;
  const row=latest.get(scope.conversation_id,scope.run_id,activityId) as {payload_json:string}|undefined;
  if(!row)continue;
  let payload:Payload;
  try{payload=JSON.parse(row.payload_json) as Payload;}catch{continue;}
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||payload.run_id!==scope.run_id
   ||payload.activity_id!==activityId||payload.tool_call_id!==callId)continue;
  const linked=bindToolArtifactReceipts(db,scope.conversation_id,scope.run_id,payload,group.receipts);
  if(linked!==payload)events.append(scope.conversation_id,scope.run_id,'activity.upsert',linked);
 }
}
