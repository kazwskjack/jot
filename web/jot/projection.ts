/** Pure UI projection example, not a Harness launcher or full application.
 * The server must authorize, sanitize and validate events BEFORE sending them.
 * This reducer expects one ordered per-conversation stream, not merged unordered tabs.
 */
import type {AgentEvent, Snapshot, Message, Run, Activity, Source, Interaction, Artifact} from './types';
export interface Projection {
  conversationId: string;
  seq: string;
  messages: Record<string, Message>;
  runs: Record<string, Run>;
  activities: Record<string, Activity>;
  sources: Record<string, Source>;
  interactions: Record<string, Interaction>;
  artifacts: Record<string, Artifact>;
  deltaCursors: Record<string, number>;
  attempts: Record<string,string>;
  timeline: Array<{key:string;runId:string;attempt?:string;kind:string;text?:string;activityId?:string}>;
}
const indexBy = <T>(xs: T[], key: (x: T) => string): Record<string,T> =>
  Object.fromEntries(xs.map(x => [key(x), x]));
const cursorKey = (attempt: string, block: string): string => JSON.stringify([attempt, block]);
export function fromSnapshot(s: Snapshot): Projection {
  // Clone to prevent caller-held response objects being changed later.
  const v = JSON.parse(JSON.stringify(s)) as Snapshot;
  const finalRuns=new Set(v.messages.filter(m=>m.role==='assistant'&&m.status==='complete'&&!m.message_id.startsWith('stream-')).map(m=>m.run_id));
  v.messages=v.messages.filter(m=>!(m.role==='assistant'&&m.message_id.startsWith('stream-')&&finalRuns.has(m.run_id)));
  return {conversationId:v.conversation.conversation_id, seq:v.as_of_seq,
    messages:indexBy(v.messages,x=>x.message_id),runs:indexBy(v.runs,x=>x.run_id),
    activities:indexBy(v.activities,x=>x.activity_id),sources:indexBy(v.sources,x=>x.source_id),
    interactions:indexBy(v.interactions,x=>x.interaction_id),artifacts:indexBy(v.artifacts,x=>x.artifact_id),
    attempts:{},timeline:[],
    deltaCursors:Object.fromEntries(v.stream_cursors.map(x=>[cursorKey(x.attempt_id,x.block_id),x.next_delta_index]))};
}
/** Throws on a gap: the caller must close the stream and load a fresh snapshot.
 * Returns the same object for duplicate event sequences. Terminal events replace
 * full messages rather than appending the same text again.
 */
export function reduceEvent(state: Projection, event: AgentEvent): Projection {
  if(event.conversation_id !== state.conversationId) throw new Error('WRONG_CONVERSATION');
  const incoming=BigInt(event.seq), current=BigInt(state.seq);
  if(incoming <= current) return state;
  if(incoming !== current+1n) throw new Error('SEQUENCE_GAP_RESNAPSHOT');
  let next: Projection={...state,seq:event.seq};
  switch(event.type){
    case 'run.state': next.runs={...state.runs,[event.payload.run_id]:event.payload}; break;
    case 'message.created': {
      const m=event.payload; next.messages={...state.messages,[m.message_id]:m};
      if(m.run_id!==null&&m.role==='assistant'&&m.status==='complete')for(const [key,value] of Object.entries(next.messages)){
        if(key!==m.message_id&&value.run_id===m.run_id&&value.role==='assistant')delete next.messages[key];
      }
      break;
    }
    case 'assistant.delta': {
      const d=event.payload, previous=state.messages[d.message_id];
      const changed=state.attempts[d.message_id]&&state.attempts[d.message_id]!==d.attempt_id;
      const message:Message=!previous||changed?{message_id:d.message_id,run_id:event.run_id,role:'assistant',status:'streaming',blocks:[],created_at:event.at}:previous;
      const key=cursorKey(d.attempt_id,d.block_id), expected=state.deltaCursors[key] ?? 0;
      if(d.delta_index < expected) break;
      if(d.delta_index > expected) throw new Error('DELTA_GAP_RESNAPSHOT');
      if(message.status!=='streaming') throw new Error('DELTA_AFTER_SETTLEMENT');
      const old=message.blocks.find(b=>b.block_id===d.block_id);
      if(old && old.kind!==d.kind) throw new Error('BLOCK_KIND_CHANGED');
      const block={...(old??{block_id:d.block_id,kind:d.kind,text:'',exposure:d.kind==='reasoning'?'provider' as const:'public' as const}),text:(old?.text??'')+d.text};
      const blocks=old?message.blocks.map(b=>b.block_id===d.block_id?block:b):[...message.blocks,block];
      next.messages={...state.messages,[message.message_id]:{...message,blocks}};
      next.deltaCursors={...state.deltaCursors,[key]:expected+1};
      next.attempts={...state.attempts,[d.message_id]:d.attempt_id};
      const last=state.timeline[state.timeline.length-1],timelineKey=cursorKey(d.attempt_id,d.block_id);
      next.timeline=last?.key===timelineKey?[...state.timeline.slice(0,-1),{...last,text:(last.text??'')+d.text}]:[...state.timeline,{key:timelineKey,runId:event.run_id,attempt:d.attempt_id,kind:d.kind,text:d.text}];
      break;
    }
    case 'assistant.settled':
      next.messages={...state.messages,[event.payload.message.message_id]:event.payload.message};
      next.attempts={...state.attempts,[event.payload.message.message_id]:event.payload.attempt_id};
      if(event.payload.message.status==='complete')for(const [key,value] of Object.entries(next.messages)){
        if(key!==event.payload.message.message_id&&value.run_id===event.run_id&&value.role==='assistant'&&(key.startsWith('stream-')||state.attempts[key]))delete next.messages[key];
      }
      if(event.payload.message.status==='failed'){
        next.timeline=state.timeline.filter(x=>x.attempt!==event.payload.attempt_id);
        for(const [key,attempt] of Object.entries(state.attempts))if(attempt===event.payload.attempt_id)delete next.messages[key];
        next.messages[event.payload.message.message_id]=event.payload.message;
      }
      // Keep bounded cursor tombstones until run compaction; late deltas must not append again.
      break;
    case 'activity.upsert':
      next.activities={...state.activities,[event.payload.activity_id]:event.payload};
      if(!state.activities[event.payload.activity_id])next.timeline=[...state.timeline,{key:event.payload.activity_id,runId:event.run_id,kind:'activity',activityId:event.payload.activity_id}];
      break;
    case 'source.upsert': next.sources={...state.sources,[event.payload.source_id]:event.payload}; break;
    case 'interaction.requested':
    case 'interaction.resolved': next.interactions={...state.interactions,[event.payload.interaction_id]:event.payload}; break;
    case 'artifact.upsert': next.artifacts={...state.artifacts,[event.payload.artifact_id]:event.payload}; break;
    case 'run.artifact': {
      const file=event.payload;
      if(file.conversation_id!==state.conversationId||file.run_id!==event.run_id)throw new Error('WRONG_ARTIFACT_SCOPE');
      next.artifacts={...state.artifacts,[file.artifact_id]:{...file,status:file.status as Artifact['status'],origin:'generated',preview_kind:file.media_type.startsWith('image/')?'image':file.media_type.startsWith('text/')?'text':'unsupported'}};
      break;
    }
    case 'goal.updated':
    case 'progress.updated':
    case 'runtime.outcome':
    case 'checkpoint.upsert':
    case 'delivery.upsert':
    case 'response.upsert':
    case 'usage.updated':
    case 'run.error':
      // Application adds usage/error indexes; run.state is the authoritative run status.
      break;
    default: { const exhaustive: never=event; throw new Error(String(exhaustive)); }
  }
  return next;
}
