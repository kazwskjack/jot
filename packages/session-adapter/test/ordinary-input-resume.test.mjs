import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const prepare=(await import('../ordinary-input-resume.js').catch(()=>({}))).prepareOrdinaryInputResume;
function fixture(){
 const calls=[],message={id:'native-input',role:'user',source:{kind:'user',rpcId:'run-a'},content:[{type:'text',text:'Original input'}]},binding={runId:'run-a',sessionRef:'session-a',executionLease:{owner:'worker-a',generation:2}};
 const authority={protocol:1,run_id:'run-a',request_id:'run-a',input_message_id:'product-input',conversation_id:'conv-a',owner_id:'owner-a',session_id:'session-a',execution_lease:binding.executionLease,input_sha256:'a'.repeat(64),execution_authorized:false};
 const agent={id:'session-a',session:{id:'session-a',seq:4},status:'idle',inbox:{nextStep:[],nextTurn:[message]},jotPendingInputProtocol:1,jotPendingWakeRevocationProtocol:1,jotRevokePendingWake(){throw Error('preflight_must_not_revoke');},jotResumePending(){throw Error('preflight_must_not_wake');},runMaintenance(){throw Error('preflight_must_not_execute');}};
 let resident=undefined,allow=true,fingerprint='b'.repeat(64);const view={values:{agentPreset:'jot-general',goal:null,inbox:{'next-step':[],'next-turn':[message]}}},history={meta:{id:'session-a'},events:[{seq:0,type:'session/end-seed',data:{}}]};
 const options={binding,signal:new AbortController().signal,observer:{assertActive(){calls.push('observer');}},ordinaryPresets:new Set(['jot-general']),agents:{get(){return resident;}},controller:{projections:async()=>{calls.push('cold');return view;},inspect:async()=>history,resolveAgent:async()=>{calls.push('resolve');resident=agent;return{agent};}},bridge:{request:async(path,b,body)=>{calls.push('binding');assert.equal(path,'ordinary-input-binding');assert.deepEqual(b,binding);assert.deepEqual(body,{});if(!allow)throw Error('revoked');return{binding:structuredClone(authority)};}},verifyComposition:async({phase})=>{calls.push(phase+'-composition');return{verified:true,fingerprint};}};
 return{options,calls,view,history,agent,authority,revoke:()=>allow=false,changeProfile:()=>fingerprint='c'.repeat(64)};
}

function steeringFixture(){
 const f=fixture(),message=f.agent.inbox.nextTurn[0];message.source.rpcId='cmd-a';
 f.agent.jotPendingInputBindingsProtocol=1;f.agent.jotResumePendingInputs=()=>assert.fail('preflight cannot wake');
 f.history.events.push({seq:1,type:'user/message',data:{id:'previous-root-input',source:{kind:'user',rpcId:'run-a'}}});
 const proof={...f.authority,kind:'ordinary_steer',request_id:'cmd-a',command_id:'cmd-a',input_message_id:'message-cmd-a',original_input_message_id:f.authority.input_message_id,original_input_sha256:f.authority.input_sha256,command_sha256:'c'.repeat(64),native_content_sha256:createHash('sha256').update(JSON.stringify(message.content)).digest('hex')};
 const original=f.options.bridge.request;f.options.bridge.request=async(path,binding,body)=>{
  if(path==='ordinary-input-binding')return original(path,binding,body);
  assert.equal(path,'ordinary-steering-binding');assert.deepEqual(body,{command_id:'cmd-a'});return{binding:structuredClone(proof)};
 };return {...f,proof,message};
}

test('cold pending steering preserves its command RPC and accepts prior consumed parent history without replay',async()=>{
 const f=steeringFixture(),prepared=await prepare(f.options);
 assert.deepEqual(prepared.request,{requestId:'run-a',messageIds:['native-input'],seq:4,inputSources:[{messageId:'native-input',requestId:'cmd-a'}]});
 prepared.check();await prepared.recheck();f.proof.command_sha256='d'.repeat(64);await assert.rejects(()=>prepared.guardExecution(new AbortController().signal),/ordinary_input_/);
});

function attachmentFixture(){const f=steeringFixture(),sha='e'.repeat(64),manifest={protocol:1,attachments:[{artifact_id:'artifact-a',version:1,sha256:sha,size_bytes:5,media_type:'application/octet-stream',file_name:'file.bin',kind:'file'}]},canonical=value=>JSON.stringify(value,(_k,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item),hash=value=>createHash('sha256').update(value).digest('hex');f.message.content.push({type:'file',attachment:{attachmentId:'sha256:'+sha,bytes:5,name:'file.bin'}});Object.assign(f.proof,{protocol:2,kind:'ordinary_steer_attachments',attachment_manifest:manifest,attachment_manifest_sha256:hash(canonical(manifest)),text_sha256:hash(f.message.content[0].text)});delete f.proof.native_content_sha256;f.options.attachmentSteeringProtocol=1;return f;}

test('attachment recovery preflight preserves native sources without uploading, admitting or waking',async()=>{const f=attachmentFixture(),result=await prepare(f.options);assert.deepEqual(result.request.inputSources,[{messageId:f.message.id,requestId:'cmd-a'}]);assert.equal('admission' in result,false);await result.recheck();f.proof.command_sha256='f'.repeat(64);await assert.rejects(result.guardExecution(new AbortController().signal));});

for(const mutation of ['disabled','text','bytes','sha','shape'])test('attachment recovery preflight refuses '+mutation+' before Agent resolution',async()=>{const f=attachmentFixture();if(mutation==='disabled')delete f.options.attachmentSteeringProtocol;if(mutation==='text')f.message.content[0].text='Changed';if(mutation==='bytes')f.message.content[1].attachment.bytes=6;if(mutation==='sha')f.message.content[1].attachment.attachmentId='sha256:'+'f'.repeat(64);if(mutation==='shape')f.message.content[1].path='private';await assert.rejects(prepare(f.options));assert.equal(f.calls.includes('resolve'),false);});

test('cold steering refuses a foreign parent, changed text, already consumed RPC and missing binding capability',async()=>{
 for(const kind of ['parent','text','entered','capability']){
  const f=steeringFixture();if(kind==='parent')f.proof.original_input_sha256='d'.repeat(64);
  if(kind==='text')f.proof.native_content_sha256='d'.repeat(64);
  if(kind==='entered')f.history.events.push({seq:2,type:'user/message',data:{id:'another-id',source:{kind:'user',rpcId:'cmd-a'}}});
  if(kind==='capability')delete f.agent.jotPendingInputBindingsProtocol;
  await assert.rejects(()=>prepare(f.options),/ordinary_input_/);
  if(kind!=='capability')assert.ok(!f.calls.includes('resolve'),kind);
 }
});

test('a command changed during the awaited composition audit cannot pass the final execution fence',async()=>{
 const f=steeringFixture();let mutate=false;f.options.verifyComposition=async()=>{if(mutate)f.proof.command_sha256='e'.repeat(64);return{verified:true,fingerprint:'b'.repeat(64)};};
 const prepared=await prepare(f.options);mutate=true;await assert.rejects(()=>prepared.guardExecution(new AbortController().signal),/ordinary_input_/);
});
test('ordinary resume preflight binds original RPC and composition before resolving, without waking',async()=>{
 const f=fixture();assert.equal(typeof prepare,'function');const p=await prepare(f.options);assert.deepEqual(p.request,{requestId:'run-a',messageIds:['native-input'],seq:4});assert.equal(p.authority.execution_authorized,false);assert.ok(f.calls.indexOf('cold')<f.calls.indexOf('resolve'));assert.ok(f.calls.indexOf('cold-composition')<f.calls.indexOf('resolve'));p.check();await p.recheck();f.revoke();await assert.rejects(()=>p.recheck(),/ordinary_input_/);
});
test('foreign or committed input and an unbalanced history refuse before Agent resolution',async()=>{
 for(const kind of ['foreign-rpc','empty','other-preset','entered','open-turn','paused-goal']){const f=fixture();if(kind==='foreign-rpc')f.view.values.inbox['next-turn'][0].source.rpcId='other-run';if(kind==='empty')f.view.values.inbox['next-turn']=[];if(kind==='other-preset')f.view.values.agentPreset='other';if(kind==='entered')f.history.events.push({seq:1,type:'user/message',data:{id:'native-input',source:{kind:'user',rpcId:'run-a'}}});if(kind==='open-turn')f.history.events.push({seq:1,type:'turn/start',data:{turn:1}});if(kind==='paused-goal')f.view.values.goal={goal:{phase:'paused'}};await assert.rejects(()=>prepare(f.options),/ordinary_input_/);assert.ok(!f.calls.includes('resolve'),kind);}
});
test('profile or product lineage changes cannot authorize the original pending input',async()=>{
 const f=fixture(),p=await prepare(f.options);f.changeProfile();await assert.rejects(()=>p.recheck(),/ordinary_input_/);const g=fixture(),q=await prepare(g.options);g.authority.input_sha256='c'.repeat(64);await assert.rejects(()=>q.recheck(),/ordinary_input_/);const h=fixture();h.authority.owner_id='';await assert.rejects(()=>prepare(h.options),/ordinary_input_/);assert.ok(!h.calls.includes('resolve'));
});
test('native pending changes and observer loss invalidate prepared input before execution',async()=>{
 const f=fixture(),p=await prepare(f.options);f.agent.session.seq++;assert.throws(()=>p.check(),/ordinary_input_/);const g=fixture(),q=await prepare(g.options);g.options.observer.assertActive=()=>{throw Error('observer_closed');};assert.throws(()=>q.check(),/ordinary_input_/);
});
test('a shared mutable projection cannot replace the verified original input during composition checks',async()=>{
 const f=fixture();f.options.verifyComposition=async()=>{f.agent.inbox.nextTurn[0].content[0].text='Changed after cold validation';return{verified:true,fingerprint:'b'.repeat(64)};};await assert.rejects(()=>prepare(f.options),/ordinary_input_/);
});


test('empty pending recovery uses the scoped original factory receipt instead of prompting',async()=>{
 const f=fixture(),message=structuredClone(f.agent.inbox.nextTurn[0]);f.view.values.inbox['next-turn']=[];f.agent.inbox.nextTurn=[];
 f.options.claimedComposer={withResolution:async(scope,operation)=>{assert.deepEqual(scope.binding,f.options.binding);f.calls.push('claimed-factory');const value=await operation();f.agent.inbox.nextTurn=[message];return {value,recovery:{state:'restored',restored:1,execution_authorized:false},pending:{'next-step':[],'next-turn':[message]}};}};
 const result=await prepare(f.options);assert.deepEqual(result.request.messageIds,['native-input']);assert.ok(f.calls.indexOf('cold-composition')<f.calls.indexOf('claimed-factory'));result.check();
});

test('an interrupted turn with surviving pending input still uses the original claim factory',async()=>{
 const f=fixture();f.history.events.push({seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'turn/end',data:{turn:1,reason:{kind:'interrupted'}}});
 f.options.claimedComposer={withResolution:async(scope,operation)=>{assert.equal(scope.allowPending,true);f.calls.push('mixed-factory');const value=await operation();return{value,recovery:{state:'none',restored:0,execution_authorized:false},pending:structuredClone(f.view.values.inbox)};}};
 await prepare(f.options);assert.ok(f.calls.includes('mixed-factory'));
});

test('possible unentered claims plus a surviving queue refuse when the original claim factory is absent',async()=>{
 const f=fixture();f.history.events.push({seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'agent/inbox/spliced',data:{target:'next-step',start:0,removedCount:1,inserted:[]}},{seq:3,type:'turn/end',data:{turn:1,reason:{kind:'interrupted'}}});
 await assert.rejects(prepare(f.options),/ordinary_input_/);assert.ok(!f.calls.includes('resolve'));
});
