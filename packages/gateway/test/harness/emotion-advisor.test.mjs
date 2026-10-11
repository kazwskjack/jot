import test from 'node:test';import assert from 'node:assert/strict';
import {EmotionAdvisor,emotionIds,taskEmotionEvent,userEmotionSignal} from '../../src/harness/emotion-advisor.ts';
test('simultaneous identical requests share one Jev and one fallback call',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});const calls=[];
 const advisor=new EmotionAdvisor({JOT_EMOTION_PROVIDER:'openjev',OPENJEV_API_KEY:'test',JOT_EMOTION_LAYA_URL:'http://127.0.0.1/emotion',JOT_EMOTION_LAYA_TOKEN:'test'},async(url)=>{
  calls.push(String(url));await gate;
  return String(url).includes('openjev')?new Response('{}',{status:503}):new Response(JSON.stringify({status:'selected',provider:'laya',emotion_id:'40',ttl_ms:5500}));
 });
 const pending=Array.from({length:12},()=>advisor.select('owner|conversation|run','searching'));
 release();const values=await Promise.all(pending);
 assert.ok(values.every(value=>value.provider==='laya'));assert.equal(calls.length,2);
});

test('coalescing does not share different owners or original messages',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let calls=0;
 const advisor=new EmotionAdvisor({JOT_EMOTION_PROVIDER:'openjev',OPENJEV_API_KEY:'test'},async()=>{
  calls++;await gate;return new Response(JSON.stringify({answers:{emotion:{choice:'03',confidence:.8}}}));
 });
 const first=advisor.select('owner-a','thinking','neutral','first');
 const second=advisor.select('owner-b','thinking','neutral','first');
 const duplicate=advisor.select('owner-a','thinking','neutral','first');
 assert.equal((await advisor.select('owner-a','thinking','neutral','different')).reason_code,'OVERLOADED');
 release();assert.ok((await Promise.all([first,second,duplicate])).every(value=>value.status==='selected'));assert.equal(calls,2);
 assert.equal((await advisor.select('owner-a','thinking','neutral','different')).status,'selected');assert.equal(calls,3);
});

test('failed shared calls release the slot and allow a fresh retry',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let calls=0;
 const advisor=new EmotionAdvisor({JOT_EMOTION_PROVIDER:'openjev',OPENJEV_API_KEY:'test'},async()=>{
  calls++;await gate;return new Response('{}',{status:503});
 });
 const first=advisor.select('owner','thinking');const duplicate=advisor.select('owner','thinking');
 release();assert.ok((await Promise.all([first,duplicate])).every(value=>value.reason_code==='PROVIDER_ERROR'));assert.equal(calls,1);
 assert.equal((await advisor.select('owner','thinking')).reason_code,'PROVIDER_ERROR');assert.equal(calls,2);
});
test('Jev first accepts low confidence; failure falls back to Laya exactly once',async()=>{
 for(const failed of [false,true]){
  const calls=[];const a=new EmotionAdvisor({JOT_EMOTION_PROVIDER:'openjev',OPENJEV_API_KEY:'test',JOT_EMOTION_LAYA_URL:'http://127.0.0.1/emotion',JOT_EMOTION_LAYA_TOKEN:'test'},async(url)=>{
   calls.push(String(url));if(calls.length===1)return failed?new Response('{}',{status:503}):new Response(JSON.stringify({answers:{emotion:{choice:'40',confidence:.01}}}));
   return new Response(JSON.stringify({status:'selected',provider:'laya',emotion_id:'40',ttl_ms:5500}));
  });
  const r=await a.select('k','searching');assert.equal(r.provider,failed?'laya':'openjev');assert.equal(calls.length,failed?2:1);assert.equal(calls[0],'https://api.openjev.sh/v1/systemone');
 }
});
test('click count and scroll direction reach Jev as display context only',async()=>{
 const a=new EmotionAdvisor({JOT_EMOTION_PROVIDER:'openjev',OPENJEV_API_KEY:'test'},async(url,opts)=>{
  const body=JSON.parse(opts.body);assert.deepEqual(body.state.interaction,{kind:'click',click_count:9,scroll_direction:'none'});
  return new Response(JSON.stringify({answers:{emotion:{choice:'11',confidence:.05}}}));
 });
 assert.equal((await a.select('k','interaction','neutral','',{kind:'click',click_count:9,scroll_direction:'none'})).emotion_id,'11');
});
test('both providers receive only actual event and retain 32 catalog entries and narrow choices to actual event',async()=>{
 for(const provider of ['laya','openjev']){
  let calls=0;
  const advisor=new EmotionAdvisor({JOT_EMOTION_PROVIDER:provider,JOT_EMOTION_LAYA_TOKEN:'test',JOT_EMOTION_LAYA_URL:'http://127.0.0.1/emotion',OPENJEV_API_KEY:'test'},async(url,opts)=>{
   calls++;const body=JSON.parse(opts.body);if(provider==='laya')assert.deepEqual(body,{event:'searching',user_signal:'neutral',user_text:''});else {assert.deepEqual(body.state,{event:'searching',user_signal:'neutral',user_text:''});assert.equal(Object.keys(body.questions.emotion.criteria).length,4)};
   return new Response(JSON.stringify(provider==='laya'?{status:'selected',provider,emotion_id:'40',ttl_ms:5500}:{answers:{emotion:{choice:'40',confidence:.8}}}));
  });
  assert.equal((await advisor.select('owner|conversation|run','searching')).emotion_id,'40');
  await advisor.select('owner|conversation|run','searching');assert.equal(calls,1);
 }
 assert.equal(emotionIds.length,32);
});
test('offline/error do not block tasks; events ignore other runs',async()=>{
 assert.equal((await new EmotionAdvisor({}).select('a','thinking')).status,'abstain');
 assert.equal(taskEmotionEvent({run_id:'a',status:'running'},[{run_id:'b',status:'running',kind:'search'}]),'thinking');
 assert.equal(taskEmotionEvent({run_id:'a',status:'cancelled'},[]),'cancelled');
});

test('authorized original message is transmitted without persistence or truncation',async()=>{
 for(const provider of ['laya','openjev']){
  let count=0;const text='我没看懂这个方案，能解释一下吗？';
  const advisor=new EmotionAdvisor({JOT_EMOTION_PROVIDER:provider,JOT_EMOTION_LAYA_TOKEN:'test',JOT_EMOTION_LAYA_URL:'http://127.0.0.1/emotion',OPENJEV_API_KEY:'test'},async(url,opts)=>{
   count++;const body=JSON.parse(opts.body);assert.equal((provider==='laya'?body:body.state).user_text,text);
   return new Response(JSON.stringify(provider==='laya'?{status:'selected',provider,emotion_id:'03',ttl_ms:5500}:{answers:{emotion:{choice:'03',confidence:.8}}}));
  });
  assert.equal(userEmotionSignal(text),'confused');assert.equal((await advisor.select('k','thinking','confused',text)).emotion_id,'03');
  assert.equal((await advisor.select('k','thinking','neutral','a'.repeat(4001))).reason_code,'INPUT_TOO_LARGE');assert.equal(count,1);
 }
});
