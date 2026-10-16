import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {patchDshPreSetupSource} from '../dsh-pre-setup-patch.js';
const patch=(await import('../dsh-pending-input-patch.js').catch(()=>({}))).patchDshPendingInputSource;
test('pending-input compatibility is an explicit pinned-source transform',()=>{
 assert.equal(typeof patch,'function');assert.throws(()=>patch({version:'0.2.0',runtimeSource:'unknown',declarationSource:'unknown'}));
});

test('multi-RPC pending wake requires an exact ordered binding for every existing input',{skip:!process.env.JOT_DSH_RUNTIME_MODULES},()=>{
 const root=join(process.env.JOT_DSH_RUNTIME_MODULES,'dsh-agent-loop'),read=p=>readFileSync(join(root,p),'utf8');
 const result=patch({version:JSON.parse(read('package.json')).version,runtimeSource:read('lib/index.js'),declarationSource:read('lib/types/index.d.ts')});
 assert.equal(result.pendingInputBindingsProtocol,1);
 const body=result.runtimeSource.match(/\tjotResumePendingInputs\(request\) \{([\s\S]+?)\n\t\}\n/);assert.ok(body);
 const resume=Function('return function(request){'+body[1]+'}')();
 const messages=['cmd-a','cmd-b'].map((rpcId,index)=>({id:'input-'+index,role:'user',source:{kind:'user',rpcId},content:[{type:'text',text:'Synthetic '+index}]}));
 const original={requestId:'parent-run',messageIds:messages.map(m=>m.id),seq:9,inputSources:messages.map(m=>({messageId:m.id,requestId:m.source.rpcId}))};
 for(const kind of ['accepted','wrong-rpc','wrong-order','missing','duplicate','extra-field','foreign-source','changed-seq','cancelled','already-waking']){
  const request=structuredClone(original),phase={kind:'maintenance',abort:new AbortController(),wakeRequested:false};let wakes=0;
  const agent={phase,session:{seq:9},inbox:{nextStep:structuredClone(messages),nextTurn:[]},wakeDriver(){wakes++;phase.wakeRequested=true;}};
  if(kind==='wrong-rpc')request.inputSources[1].requestId='foreign-command';
  if(kind==='wrong-order')request.inputSources.reverse();
  if(kind==='missing')request.inputSources.pop();
  if(kind==='duplicate')request.inputSources[1]=request.inputSources[0];
  if(kind==='extra-field')request.inputSources[0].owner='forged';
  if(kind==='foreign-source')agent.inbox.nextStep[1].source.kind='goal';
  if(kind==='changed-seq')agent.session.seq++;
  if(kind==='cancelled')phase.abort.abort({kind:'user'});
  if(kind==='already-waking')phase.wakeRequested=true;
  const before=structuredClone(agent.inbox);
  if(kind==='accepted'){const value=resume.call(agent,request);assert.deepEqual(value,{accepted:true,messageIds:original.messageIds,seq:9});assert.equal(typeof value.wakeToken,'symbol');assert.equal(wakes,1);}
  else{assert.throws(()=>resume.call(agent,request),/dsh_pending_input_/);assert.equal(wakes,0);}
  assert.deepEqual(agent.inbox,before);
 }
});
test('pending wake retains original messages, runs only behind maintenance and rejects changed identity',{skip:!process.env.JOT_DSH_RUNTIME_MODULES},()=>{
 const root=join(process.env.JOT_DSH_RUNTIME_MODULES,'dsh-agent-loop'),read=p=>readFileSync(join(root,p),'utf8'),input={version:JSON.parse(read('package.json')).version,runtimeSource:read('lib/index.js'),declarationSource:read('lib/types/index.d.ts')};
 assert.equal(typeof patch,'function');const result=patch(input);assert.equal(result.pendingInputProtocol,1);assert.equal(result.protocol,2);
 assert.equal(patch({...input,runtimeSource:result.runtimeSource,declarationSource:result.declarationSource}).changed,false);
 assert.throws(()=>patch({...input,runtimeSource:result.runtimeSource}));assert.throws(()=>patch({...input,runtimeSource:result.runtimeSource+'\n',declarationSource:result.declarationSource}));
 const nativeMethod=result.runtimeSource.match(/\t\/\*\* Jot compatibility only[\s\S]*?\n\t\}\n/)[0],typeDelta=result.declarationSource.replace(patchDshPreSetupSource(input).declarationSource,'');
 assert.throws(()=>patch({...input,runtimeSource:input.runtimeSource.replace('\tfollowup(input) {\n',nativeMethod+'\tfollowup(input) {\n'),declarationSource:typeDelta+input.declarationSource}),/dsh_pending_input_patch_partial/,'a pending-only partial package cannot masquerade as complete setup protocol 2');
 const body=result.runtimeSource.match(/\tjotResumePending\(request\) \{([\s\S]+?)\n\t\}\n/);assert.ok(body);const resume=Function('return function(request){'+body[1]+'}');
 const message={id:'native-input',role:'user',source:{kind:'user',rpcId:'original-run'},content:[{type:'text',text:'Original'}]},request={requestId:'original-run',messageIds:['native-input'],seq:7};
 for(const kind of ['accepted','idle','running','cancelled','changed-seq','changed-id','foreign-rpc','goal-source','duplicate','extra-input','already-waking']){
  let wakes=0;const phase={kind:'maintenance',abort:new AbortController(),wakeRequested:false},inbox={nextTurn:[message],nextStep:[]},agent={phase,inbox,session:{seq:7},wakeDriver(){wakes++;phase.wakeRequested=true;}};
  if(['idle','running'].includes(kind))phase.kind=kind;if(kind==='cancelled')phase.abort.abort({kind:'user'});if(kind==='changed-seq')agent.session.seq++;
  if(kind==='changed-id')inbox.nextTurn=[{...message,id:'another'}];if(kind==='foreign-rpc')inbox.nextTurn=[{...message,source:{kind:'user',rpcId:'another-run'}}];if(kind==='goal-source')inbox.nextTurn=[{...message,source:{kind:'goal'}}];if(kind==='duplicate')inbox.nextStep=[message];if(kind==='extra-input')inbox.nextStep=[{...message,id:'another'}];if(kind==='already-waking')phase.wakeRequested=true;
  const before=structuredClone(inbox);if(kind==='accepted'){assert.deepEqual(resume().call(agent,request),{accepted:true,messageIds:['native-input'],seq:7});assert.equal(wakes,1);}else{assert.throws(()=>resume().call(agent,request),/dsh_pending_input_/);assert.equal(wakes,0);}
  assert.deepEqual(inbox,before);
 }
 for(const value of [null,{}, {...request,owner:'forged'}, {...request,messageIds:[]}, {...request,seq:'7'}])assert.throws(()=>resume().call({},value),/dsh_pending_input_/);
});
