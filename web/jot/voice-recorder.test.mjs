import test from 'node:test';import assert from 'node:assert/strict';
import {validateVoiceWave} from '../../packages/gateway/src/voice/wav.ts';
import * as mod from './voice-recorder.mjs';
test('PCM encoder produces strict mono 16k PCM16 WAV with bounded clipping',()=>{
 assert.equal(typeof mod.encodeVoiceWave,'function','WAV encoder must exist');
 const bytes=mod.encodeVoiceWave(new Float32Array([-2,-1,0,1,2,0]),48000),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 assert.equal(new TextDecoder().decode(bytes.slice(0,4)),'RIFF');assert.equal(bytes.length,48);assert.equal(view.getUint32(4,true),40);assert.equal(view.getUint16(20,true),1);assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint32(24,true),16000);assert.equal(view.getUint32(28,true),32000);assert.equal(view.getUint16(34,true),16);assert.equal(view.getUint32(40,true),4);assert.equal(view.getInt16(44,true),-32768);assert.equal(view.getInt16(46,true),32767);
});
function platform(permission){let stopped=0,closed=0,disconnected=0;let processor;
 const stream={getTracks:()=>[{stop:()=>stopped++}]},node=()=>({connect(){},disconnect(){disconnected++;}});
 class AudioContext{sampleRate=48000;destination={};state='running';async resume(){}async close(){closed++;}createMediaStreamSource(){return node();}createGain(){return {...node(),gain:{value:1}};}createScriptProcessor(){processor={...node(),onaudioprocess:null};return processor;}}
 return {env:{isSecureContext:true,AudioContext,navigator:{mediaDevices:{getUserMedia:()=>permission??Promise.resolve(stream)}}},stream,get processor(){return processor;},get stopped(){return stopped;},get closed(){return closed;},get disconnected(){return disconnected;}};
}
test('finishing captures microphone PCM and releases every owned browser resource',async()=>{
 assert.equal(typeof mod.recordVoice,'function');const p=platform(),r=await mod.recordVoice({maxDurationMs:60000,maxBytes:2000000,signal:new AbortController().signal,env:p.env});
 p.processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4800).fill(.5)}});const audio=r.finish();assert.equal(audio.length,3244);assert.equal(p.stopped,1);assert.equal(p.closed,1);assert.ok(p.disconnected>=3);r.cancel();assert.equal(p.stopped,1);
 assert.equal(validateVoiceWave(Buffer.from(audio)),0.1);
});
test('cancellation during microphone permission closes a stream granted later',async()=>{
 assert.equal(typeof mod.recordVoice,'function');const pending=Promise.withResolvers(),p=platform(pending.promise),abort=new AbortController();const recording=mod.recordVoice({signal:abort.signal,maxDurationMs:60000,maxBytes:2000000,env:p.env});abort.abort();await assert.rejects(recording,{name:'AbortError'});pending.resolve(p.stream);await new Promise(r=>setImmediate(r));assert.equal(p.stopped,1);assert.equal(p.closed,1);
});
test('unsupported and refused microphone requests expose actionable errors',async()=>{
 assert.equal(typeof mod.recordVoice,'function');await assert.rejects(()=>mod.recordVoice({env:{isSecureContext:false}}),/VOICE_RECORDING_UNSUPPORTED/);
 const p=platform(Promise.reject(Object.assign(Error('denied'),{name:'NotAllowedError'})));await assert.rejects(()=>mod.recordVoice({env:p.env,signal:new AbortController().signal}),/NotAllowedError/);assert.equal(p.closed,1);
});
test('empty capture and configured byte limits refuse invalid uploads',()=>{
 assert.equal(typeof mod.encodeVoiceWave,'function');assert.throws(()=>mod.encodeVoiceWave(new Float32Array(),48000),/VOICE_AUDIO_EMPTY/);assert.throws(()=>mod.encodeVoiceWave(new Float32Array(48000),48000,100),/VOICE_AUDIO_TOO_LARGE/);
});
test('configured recording limit never captures more bytes than the backend accepts',async()=>{
 let reached=0;const p=platform();let r;
 r=await mod.recordVoice({maxDurationMs:1000,maxBytes:3244,signal:new AbortController().signal,env:p.env,onLimit:()=>reached++});
 p.processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(10000).fill(.25)}});
 assert.equal(reached,1);const audio=r.finish();assert.equal(audio.length,3244);assert.equal(validateVoiceWave(Buffer.from(audio)),.1);assert.equal(p.stopped,1);
});
