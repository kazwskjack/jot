import type {DatabaseSync} from 'node:sqlite';
import type {EventStore} from '../events/event-store.ts';
import {readNativeMemberExecution} from './native-member-owner-controls.ts';

type Payload=Record<string,unknown>;

/** Original tool identity selects the original published child, even after activation. */
export function bindNativeDelegationActivity(db:DatabaseSync,conversationId:string,runId:string,payload:Payload):Payload{
 if(payload.kind!=='subagent')return payload;
 const detail=payload.detail as Payload|undefined;
 if(!detail||typeof detail.native_request_id!=='string'||!/^delegate-[a-f0-9]{64}$/.test(detail.native_request_id))return payload;
 if(!db.isTransaction||payload.run_id!==runId)throw Error('native_delegation_activity_scope_invalid');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_native_spawn_publications'").get())return payload;
 const source=db.prepare(`SELECT n.owner_id,n.child_session_ref,n.run_id,n.reservation_id,s.session_id
  FROM wb_native_child_reservations v
  JOIN wb_native_child_runs n ON n.reservation_id=v.reservation_id AND n.owner_id=v.owner_id
   AND n.root_run_id=v.root_run_id AND n.child_session_ref=v.child_session_ref
  JOIN wb_native_spawn_publications p ON p.reservation_id=v.reservation_id
  JOIN ga_runs r ON r.id=v.root_run_id JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=v.owner_id
  JOIN wb_run_bindings root_binding ON root_binding.run_id=r.id AND root_binding.owner_id=c.owner_id AND root_binding.kind='task'
  JOIN ga_run_native_sessions s ON s.run_id=r.id AND s.conversation_id=c.id AND s.owner_id=c.owner_id
  WHERE v.root_run_id=? AND v.request_id=? AND c.id=?`).get(runId,detail.native_request_id,conversationId) as
  {owner_id:string;child_session_ref:string;run_id:string;reservation_id:string;session_id:string}|undefined;
 if(!source)return payload;
 const child=readNativeMemberExecution(db,source.owner_id,runId,source.child_session_ref,source.session_id,source.run_id);
 const bound={child_run_id:child.child_run_id,child_conversation_id:child.child_conversation_id,
  child_session_ref:child.child_session_ref,role_ref:child.role_ref,reservation_id:source.reservation_id};
 if(Object.entries(bound).every(([key,value])=>detail[key]===value))return payload;
 return {...payload,detail:{...detail,...bound}};
}

/** Publication may follow the tool receipt. Append only the latest original state. */
export function backfillNativeDelegationActivity(db:DatabaseSync,events:EventStore,runId:string,requestId:string){
 if(!db.isTransaction||!events.usesDatabase(db))throw Error('native_delegation_activity_scope_invalid');
 const rows=db.prepare(`SELECT e.conversation_id,e.payload_json FROM ga_events e
  JOIN ga_runs r ON r.id=e.run_id AND r.conversation_id=e.conversation_id
  WHERE e.run_id=? AND e.type='activity.upsert' AND json_extract(e.payload_json,'$.kind')='subagent'
   AND json_extract(e.payload_json,'$.detail.native_request_id')=?
   AND NOT EXISTS(SELECT 1 FROM ga_events newer WHERE newer.conversation_id=e.conversation_id
    AND newer.run_id=e.run_id AND newer.type='activity.upsert' AND newer.seq>e.seq
    AND json_extract(newer.payload_json,'$.activity_id')=json_extract(e.payload_json,'$.activity_id'))`)
  .all(runId,requestId) as Array<{conversation_id:string;payload_json:string}>;
 for(const row of rows){
  const payload=JSON.parse(row.payload_json) as Payload;
  const bound=bindNativeDelegationActivity(db,row.conversation_id,runId,payload);
  if(bound!==payload)events.append(row.conversation_id,runId,'activity.upsert',bound);
 }
}
