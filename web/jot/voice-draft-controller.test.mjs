import test from 'node:test';
import assert from 'node:assert/strict';
import * as mod from './voice-draft-controller.mjs';
const deferred=()=>Promise.withResolvers();
function fixture(overrides={}){
 let scope='a'.repeat(64),draft='原有文字',stops=0,cancels=0,uploads=0,signal;
 const recorder={finish:()=>{stops++;return new Uint8Array([1,2]);},cancel:()=>cancels++};
 const options={readScope:()=>scope,verifyScope:async()=>true,record:async()=>recorder,
  transcribe:async(id,audio,s)=>{uploads++;signal=s;assert.equal(id,'conversation-a');assert.deepEqual([...audio],[1,2]);return '识别内容';},
  onText:text=>{draft=mod.appendVoiceText(draft,text);},...overrides};
 assert.equal(typeof mod.VoiceDraftController,'function','voice draft controller must exist');
 const controller=new mod.VoiceDraftController('conversation-a',options);
 return {controller,recorder,options,setScope:value=>scope=value,setDraft:value=>draft=value,
  get draft(){return draft;},get uploads(){return uploads;},get cancels(){return cancels;},get signal(){return signal;}};
}
test('transcription appends to the latest editable draft without sending a message',async()=>{
 const f=fixture();await f.controller.start({maxDurationMs:60000,maxBytes:2000000});assert.equal(f.controller.status,'recording');
 f.setDraft('用户最新修改');await f.controller.stop();assert.equal(f.draft,'用户最新修改\n识别内容');assert.equal(f.uploads,1);assert.equal(f.controller.status,'idle');
});
test('cancelled pending microphone permission closes the late stream without transcription',async()=>{
 const ready=deferred(),f=fixture({record:()=>ready.promise});const start=f.controller.start({});f.controller.cancel();ready.resolve(f.recorder);await start;
 assert.equal(f.cancels,1);assert.equal(f.uploads,0);assert.equal(f.draft,'原有文字');assert.equal(f.controller.status,'idle');
});
test('cancelled transcription ignores a provider that returns success late',async()=>{
 const reply=deferred(),entered=deferred(),f=fixture({transcribe:async()=>{entered.resolve();return reply.promise;}});await f.controller.start({});const stop=f.controller.stop();await entered.promise;
 f.controller.cancel();reply.resolve('迟到内容');await stop;assert.equal(f.draft,'原有文字');assert.equal(f.controller.status,'idle');assert.equal(f.controller.error,'');
});
test('unmount or conversation/role replacement disposes the original recording',async()=>{
 const f=fixture();await f.controller.start({});f.controller.dispose();assert.equal(f.cancels,1);await f.controller.stop();await f.controller.start({});assert.equal(f.uploads,0);assert.equal(f.draft,'原有文字');
});
test('owner change before upload refuses transcription and releases the recorder',async()=>{
 const f=fixture();await f.controller.start({});f.setScope('b'.repeat(64));await f.controller.stop();assert.equal(f.uploads,0);assert.equal(f.draft,'原有文字');assert.match(f.controller.error,/VOICE_SCOPE_CHANGED/);
});
test('owner revalidation after transcription prevents cross-owner draft application',async()=>{
 let proofs=0;const f=fixture({verifyScope:async()=>++proofs===1});await f.controller.start({});await f.controller.stop();assert.equal(f.draft,'原有文字');assert.match(f.controller.error,/VOICE_SCOPE_CHANGED/);
});
test('provider errors retain their actual code and a new recording can be started',async()=>{
 const f=fixture({transcribe:async()=>{throw Error('VOICE_PROVIDER_UNAVAILABLE');}});await f.controller.start({});await f.controller.stop();assert.equal(f.controller.error,'VOICE_PROVIDER_UNAVAILABLE');assert.equal(f.controller.status,'idle');await f.controller.start({});assert.equal(f.controller.status,'recording');f.controller.dispose();
});
test('permission errors reset the UI and keep the original draft',async()=>{
 const f=fixture({record:async()=>{throw Error('麦克风权限被拒绝 (NotAllowedError)');}});await f.controller.start({});assert.equal(f.controller.status,'idle');assert.match(f.controller.error,/NotAllowedError/);assert.equal(f.draft,'原有文字');
});
test('duplicate stops never create multiple transcription requests',async()=>{
 const reply=deferred(),entered=deferred(),f=fixture({transcribe:async()=>{entered.resolve();return reply.promise;}});await f.controller.start({});const first=f.controller.stop();await entered.promise;await f.controller.stop();reply.resolve('一次');await first;assert.equal(f.draft,'原有文字\n一次');
});
test('empty or oversized transcript cannot erase or silently truncate a draft',()=>{
 assert.equal(typeof mod.appendVoiceText,'function');assert.throws(()=>mod.appendVoiceText('原文','  '),/VOICE_TEXT_EMPTY/);assert.throws(()=>mod.appendVoiceText('x'.repeat(7999),'ab'),/VOICE_DRAFT_TOO_LONG/);assert.equal(mod.appendVoiceText('','语音'),'语音');
});
