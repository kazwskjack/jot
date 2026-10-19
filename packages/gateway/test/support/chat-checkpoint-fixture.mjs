import {completedChatFixture} from './chat-maintenance-fixture.mjs';
import {ChatCompactionAttempts} from '../../src/conversations/chat-compaction-attempts.ts';
export function settledCheckpointFixture(t,{db,settled=true}={}){
 const f=completedChatFixture(t,{db,contextRevision:'checkpoint-text-v2'}),ledger=new ChatCompactionAttempts(f.db),base={intent_id:f.intent.intent_id,attempt_id:'checkpoint-attempt',observer_id:'checkpoint-host'},reserved=ledger.reserve(f.scope,{...base,request:f.request,witness:f.witness}),binding={...base,fence_id:reserved.fence_id};ledger.dispatch(f.scope,binding);
 const usage={inputTokens:10,outputTokens:1,totalTokens:11};if(settled)ledger.settle(f.scope,binding,usage);else ledger.unknown(f.scope,binding,'stream_incomplete',{inputTokens:10});
 const text='SYNTHETIC-CHECKPOINT: preserve the original facts and next step.';
 const witness={protocol:1,kind:'native_chat_checkpoint',compaction_id:'synthetic-compaction',source_command_id:base.attempt_id,start_seq:8,summary_seq:9,replacement_seq:10,end_seq:11,raw_event_count:12,prefix_raw_sha256:f.witness.raw_sha256,prefix_event_count:8,raw_sha256:'e'.repeat(64),surface_generation_before:1,surface_generation_after:2,shadowed_start:1,shadowed_end:7,shadowed_count:4,shadowed_seqs_sha256:'f'.repeat(64),context_marker_seq:1,answer_seq:5,answer_covered:true,native_message_ids_sha256:f.witness.native_message_ids_sha256,context_sha256:f.intent.source.context_sha256,summary_sha256:'1'.repeat(64),summary_text_sha256:digestText(text),replacement_sha256:'2'.repeat(64),event_span_sha256:'3'.repeat(64),profile_fingerprint:f.witness.profile_fingerprint,provider:'fixture',model:'fast',usage,execution_authorized:false};
 return{...f,ledger,binding,text,witness,input:{...binding,source_sha256:f.intent.source_sha256,summary_text:text,witness}};
}
import {createHash} from 'node:crypto';
const digestText=text=>createHash('sha256').update(text).digest('hex');
