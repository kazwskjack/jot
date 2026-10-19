import {createHash} from 'node:crypto';
import {openProductDatabase} from '../../src/db/database.ts';
import {ConversationRepository} from '../../src/conversations/repository.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {inspectOrdinaryModelPolicy,bindOrdinaryModelResolution,canonicalModelJson} from '../../src/conversations/model-policy.ts';
import {prepareChatCompactionIntent} from '../../src/conversations/chat-compaction-source.ts';
export const digest=value=>createHash('sha256').update(canonicalModelJson(value)).digest('hex');
export function completedChatFixture(t,{db:provided,path=':memory:',contextRevision='bounded-text-v1'}={}){
 const db=provided??openProductDatabase(path);if(!provided)t.after(()=>{if(db.isOpen)db.close();});
 const events=new EventStore(db),conversations=new ConversationRepository(db),runs=new RunRepository(db,events),policy={protocol:1,mode:'chat',model:{provider:'fixture',model:'fast'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-native-v1',context_revision:contextRevision};
 const c=conversations.create('compact-owner',{workspace_id:'ws',mode:'chat',model:policy.model},{chatPolicy:policy}),run=runs.enqueue(c.conversation_id,'compact-owner',{client_message_id:'compact-input',content:[{type:'text',text:'Synthetic original.'}]},{modePolicy:policy}),coordinator=new HarnessCoordinator(db,runs,events),lease=coordinator.claimNext('compact-worker',30000);coordinator.start(lease);
 const session=db.prepare('SELECT native_session_ref FROM ga_runs WHERE id=?').get(run.run_id).native_session_ref,execution={owner:lease.owner,generation:lease.generation},model=inspectOrdinaryModelPolicy(db,run.run_id,session,execution);bindOrdinaryModelResolution(db,run.run_id,session,execution,model.policy_sha256,{...policy.model,reasoning_effort:'off'});
 coordinator.recordCandidate(lease,'Synthetic final.');coordinator.setCandidateStatus(lease,'verified',[]);coordinator.recordAssistant(lease,'Synthetic final.');coordinator.finalizePublication(lease,'succeeded',null);
 const scope={owner_id:'compact-owner',conversation_id:c.conversation_id,run_id:run.run_id,session_ref:session,expected_run_version:runs.get(run.run_id,'compact-owner').version},intent=prepareChatCompactionIntent(db,scope);
 const witness={protocol:1,kind:'chat_compaction_native_witness',run_id:run.run_id,run_version:scope.expected_run_version,session_id:session,history_sha256:intent.source.history_sha256,proof_sha256:'a'.repeat(64),raw_sha256:'b'.repeat(64),raw_event_count:8,profile_fingerprint:'c'.repeat(64),command_ids_sha256:digest([]),native_message_ids_sha256:digest(['original-native']),native_message_count:1,answer_sha256:createHash('sha256').update('Synthetic final.').digest('hex'),answer_seq:5,turn_end_seq:7,execution_authorized:false};
 const request={provider:'fixture',model:'fast',reasoning_effort:'off',purpose:'compaction',session_id:session,call_sha256:'d'.repeat(64)};
 return{db,runs,conversations,scope,intent,witness,request,policy,c,run,newInput:()=>runs.enqueue(c.conversation_id,'compact-owner',{client_message_id:'next-question',content:[{type:'text',text:'New synthetic input.'}]},{modePolicy:policy})};
}
