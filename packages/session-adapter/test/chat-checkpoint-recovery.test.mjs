import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ordinaryCompletionFixture} from './support/ordinary-completion-fixture.mjs';
import {createOrdinaryRunCompletionReader} from '../ordinary-run-completion.js';
import {chatMaintenanceNativeWitness} from '../chat-maintenance-observation.js';
import {createAdapterHandler,apply} from '../index.js';
const impl=await import('../chat-checkpoint-recovery.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex'),textHash=v=>createHash('sha256').update(v).digest('hex');
async function fixture(){
 const f=ordinaryCompletionFixture(0),{scope,options}=f;f.header.agentPreset='jot-chat';options.ordinaryPresets=new Set(['jot-chat']);f.source.run_status='succeeded';f.source.canonical={message_id:'answer',status:'complete',content_sha256:'5'.repeat(64),record_sha256:'6'.repeat(64)};
 const contextHash='a'.repeat(64);f.events.unshift({type:'system/message',data:{role:'system',content:[{type:'text',text:'Synthetic system.'}]},surfaceOp:'append'});f.events.splice(4,0,{type:'user/message',data:{id:'context',role:'user',source:{kind:'jot-chat-context',run_id:'r',context_sha256:contextHash},content:[{type:'text',text:'Synthetic prior context.'}]},surfaceOp:'append'});f.resequence();
 options.Session.create=(id,events,header)=>{let nodes=[],generation=0;for(const e of events){if(!['system/message','user/message','assistant/message'].includes(e.type))continue;if(e.surfaceOp?.op==='replace'){const a=nodes.indexOf(e.surfaceOp.startSeq),b=nodes.indexOf(e.surfaceOp.endSeq);assert.ok(a>=0&&b>=a);nodes.splice(a,b-a+1,e.seq);generation++;}else nodes.push(e.seq);}return{id,header,seq:events.length,inheritedEventCount:0,surface:{nodes,replaceGeneration:generation},snapshotEvents:()=>structuredClone(events)};};
 const proof=await createOrdinaryRunCompletionReader(options)(f.request()),prefix=structuredClone(f.events),source={protocol:1,kind:'chat_compaction_source',...scope,session_id:scope.session_ref,run_version:scope.expected_run_version,policy:{mode:'chat',thinking:'disabled',context_revision:'checkpoint-text-v2'},model:{provider:'fixture',model:'fast',reasoning_effort:'off'},history_sha256:proof.source_sha256,context_sha256:contextHash,execution_authorized:false};delete source.session_ref;delete source.expected_run_version;
 const intentId='intent',attemptId='attempt',binding={intent_id:intentId,attempt_id:attemptId,observer_id:'original-host',fence_id:'original-fence'},usage={inputTokens:10,outputTokens:1,totalTokens:11},sourceHash=hash(source),receipt={protocol:1,kind:'chat_compaction_attempt',...binding,run_id:'r',session_id:'s',source_sha256:sourceHash,state:'settled',dispatch_allowed:false,execution_authorized:false,request:{provider:'fixture',model:'fast',reasoning_effort:'off',purpose:'compaction',session_id:'s',call_sha256:'b'.repeat(64)}};
 const inspection={protocol:1,kind:'chat_compaction_attempt_inspection',intent_id:intentId,owner_id:'u',conversation_id:'c',run_id:'r',run_version:4,session_id:'s',source_sha256:sourceHash,source,receipt,native_witness:chatMaintenanceNativeWitness(proof),execution_authorized:false},start=prefix.length,selected=options.Session.create('s',prefix,f.header).surface.nodes.filter(seq=>['context',f.root.id].includes(prefix[seq].data?.id)),range={start:selected[0],end:selected.at(-1)},summary=[{type:'text',text:'SYNTHETIC-RECOVERED-CHECKPOINT'}],lifecycle={compactionId:'compaction',sourceCommandId:attemptId,turn:null};
 f.events.push({seq:start,type:'compaction/start',data:{...lifecycle}},{seq:start+1,type:'compaction/summary',data:{...lifecycle,summary,shadowedRange:range,shadowedSeqs:selected,shadowedTokenCount:1000,provider:'fixture',model:'fast',usage:structuredClone(usage),llmStreamCall:true}},{seq:start+2,type:'user/message',data:{id:'checkpoint',role:'user',source:{kind:'compact-checkpoint',compactionId:'compaction',sourceCommandId:attemptId},content:summary},surfaceOp:{op:'replace',startSeq:range.start,endSeq:range.end},sourceEventSeqs:[start,start+1,...selected]},{seq:start+3,type:'compaction/end',data:{...lifecycle}});
 const state={published:null,publishes:0,settles:0,stale:false,calls:[],inspection},originalRequest=options.bridge.request;
 options.bridge.request=async(path,scopeBinding,body)=>{state.calls.push({path,action:body.action});if(path==='ordinary-run-history')return originalRequest(path,scopeBinding,body);assert.deepEqual(scopeBinding,{runId:'r',sessionRef:'s'});
  if(path==='chat-compaction-attempt'&&body.action==='inspect')return{attempt:structuredClone(inspection)};
  if(path==='chat-compaction-checkpoint'&&body.action==='read')return{checkpoint:structuredClone(state.published)};
  if(path==='chat-compaction-source'){if(state.stale)throw Error('stale source');return{intent:{protocol:1,intent_id:intentId,run_id:'r',source_sha256:sourceHash,source:structuredClone(source),execution_authorized:false}};}
  if(path==='chat-compaction-attempt'&&body.action==='settle'){assert.deepEqual(body.usage,usage);state.settles++;inspection.receipt.state='settled';return{receipt:structuredClone(inspection.receipt)};}
  if(path==='chat-compaction-checkpoint'&&body.action==='publish'){assert.equal(body.source_sha256,sourceHash);assert.equal(Object.hasOwn(body,'execution_lease'),false);state.publishes++;state.published={protocol:1,kind:'chat_compaction_checkpoint',checkpoint_id:'saved',checkpoint_sha256:'d'.repeat(64),run_id:'r',session_id:'s',source_sha256:sourceHash,summary_text_sha256:textHash(body.summary_text),native_summary_sha256:body.witness.summary_sha256,parent_checkpoint_id:null,execution_authorized:false};return{checkpoint:structuredClone(state.published)};}
  assert.fail('unexpected operation '+path+' '+body.action);
 };
 return{...f,...state,state,inspection,options,source,proof,prefix,binding,start,request:{scope,intent_id:intentId,signal:new AbortController().signal}};
}

test('cold recovery verifies original prefix and native tail, settles through the original journal and publishes without model replay',async()=>{
 assert.equal(typeof impl.createChatCheckpointRecovery,'function');const f=await fixture(),before=canonical(f.events),counts=f.counts(),recover=impl.createChatCheckpointRecovery(f.options),result=await recover(f.request);assert.equal(result.status,'recovered');assert.equal(result.execution_authorized,false);assert.equal(result.checkpoint.checkpoint_id,'saved');assert.equal(f.state.settles,1);assert.equal(f.state.publishes,1);assert.equal(canonical(f.events),before);assert.equal(f.counts().opens-f.counts().closes,0);assert.ok(f.counts().opens>counts.opens);assert.ok(f.state.calls.every(c=>!['dispatch','reserve'].includes(c.action)));
 f.state.stale=true;f.options.agents.get=()=>({});const reads=f.counts();assert.equal((await recover(f.request)).status,'already_published');assert.deepEqual(f.counts(),reads);assert.equal(f.state.publishes,1);assert.equal(f.state.settles,1);
 f.inspection.receipt.state='usage_unknown';await assert.rejects(()=>recover(f.request));assert.deepEqual(f.counts(),reads);
});

test('partial, changed, active, foreign or cancelled cold sources cannot become a useful recovered checkpoint',async()=>{
 assert.equal(typeof impl.createChatCheckpointRecovery,'function');
 for(const mode of ['partial','prefix','error','model','usage','agent','session','source','scope','abort','changed-during-read']){const f=await fixture();if(mode==='partial')f.events.pop();if(mode==='prefix')f.events[0].data.content[0].text+=' changed';if(mode==='error')f.events.at(-1).data.error={message:'cancelled'};if(mode==='model')f.events[f.start+1].data.provider='other';if(mode==='usage')f.events[f.start+1].data.usage.inputTokens=20;if(mode==='agent')f.options.agents.get=()=>({});if(mode==='session')f.options.sessions.get=()=>({});if(mode==='source')f.state.stale=true;if(mode==='scope')f.request.scope={...f.scope,owner_id:'other'};if(mode==='abort')f.request.signal=AbortSignal.abort();if(mode==='changed-during-read'){const read=f.options.admissions.read;f.options.admissions.read=async q=>{const r=await read(q);f.events[0].data.content[0].text+=' drift';return r;};}
  await assert.rejects(()=>impl.createChatCheckpointRecovery(f.options)(f.request),undefined,mode);assert.equal(f.state.publishes,0,mode);assert.equal(f.counts().opens,f.counts().closes,mode);
 }
});

test('absent, reserved or released attempts cannot dispatch from recovery and unknown usage is not replaced by zero',async()=>{
 assert.equal(typeof impl.createChatCheckpointRecovery,'function');
 for(const state of ['absent','reserved','released','usage_unknown']){const f=await fixture();if(state==='absent'){f.inspection.receipt=null;f.inspection.native_witness=null;}else f.inspection.receipt.state=state;
  const result=await impl.createChatCheckpointRecovery(f.options)(f.request);assert.equal(result.execution_authorized,false);assert.equal(result.status,state==='usage_unknown'?'recovered':'unavailable');assert.equal(f.state.settles,state==='usage_unknown'?1:0);assert.equal(f.state.publishes,state==='usage_unknown'?1:0);assert.ok(f.state.calls.every(c=>!['dispatch','reserve'].includes(c.action)));
 }
});

test('recovery transport is opt-in, authenticated and refuses caller-supplied execution authority',async()=>{
 const token='test-original-checkpoint-recovery-token';let calls=0;const handler=createAdapterHandler({token,chatCheckpointRecovery:async value=>{calls++;assert.deepEqual(value.scope,{owner_id:'u',conversation_id:'c',run_id:'r',expected_run_version:4,session_ref:'s'});assert.equal(value.intent_id,'intent');return{execution_authorized:false};}}),body={history:{owner_id:'u',conversation_id:'c',run_id:'r',expected_run_version:4},intent_id:'intent'},url=new URL('http://127.0.0.1/v1/sessions/s/chat-checkpoint-recovery'),invoke=(payload=body,auth=token)=>handler({method:'POST',url,headers:{authorization:'Bearer '+auth},body:payload});
 assert.equal((await invoke(body,'wrong')).status,401);assert.equal((await invoke({...body,execution_lease:{owner:'old',generation:1}})).status,422);assert.equal(calls,0);assert.equal((await invoke()).status,200);assert.equal(calls,1);assert.equal((await createAdapterHandler({token})({method:'POST',url,headers:{authorization:'Bearer '+token},body})).status,503);
 assert.equal((await handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions/%ZZ/chat-checkpoint-recovery'),headers:{authorization:'Bearer '+token},body})).status,422);assert.equal(calls,1);
 for(const config of [{ordinaryChatCompactionRecovery:true},{ordinaryChatCompactionRecovery:'enabled'}])assert.throws(()=>apply({},config),/chat_checkpoint_recovery_config_invalid/);
});

test('the official disk default for root delegation depth resolves only through the exact original prefix hash',async()=>{
 assert.equal(typeof impl.createChatCheckpointRecovery,'function');for(const depth of [0,1]){const f=await fixture();f.header.delegationDepth=depth;if(depth===0)assert.equal((await impl.createChatCheckpointRecovery(f.options)(f.request)).status,'recovered');else{await assert.rejects(()=>impl.createChatCheckpointRecovery(f.options)(f.request));assert.equal(f.state.publishes,0);}assert.equal(f.counts().opens,f.counts().closes);}
 const changed=await fixture();changed.header.delegationDepth=0;changed.header.createdAt++;await assert.rejects(()=>impl.createChatCheckpointRecovery(changed.options)(changed.request));assert.equal(changed.state.publishes,0);
});

test('detached official replay markers are validated but never claimed as durable native events',async()=>{
 for(const kind of ['session/end-seed','user/message']){const f=await fixture(),create=f.options.Session.create;f.options.Session.create=(id,events,header)=>{const value=create(id,events,header),log=[...events,{seq:events.length,type:kind,data:{}}];return{...value,seq:log.length,snapshotEvents:()=>structuredClone(log)};};
  if(kind==='session/end-seed')assert.equal((await impl.createChatCheckpointRecovery(f.options)(f.request)).status,'recovered');else{await assert.rejects(()=>impl.createChatCheckpointRecovery(f.options)(f.request));assert.equal(f.state.publishes,0);}assert.equal(f.counts().opens,f.counts().closes);
 }
});
