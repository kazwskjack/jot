import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {createWorkForkContextSelector} from '../chat-context.js';
const hash=v=>createHash('sha256').update(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)).digest('hex');
function fixture(attachments=[]){
 const binding={runId:'run',sessionRef:'session',executionLease:{owner:'worker',generation:1}},authority={protocol:1,run_id:'run',request_id:'run',input_message_id:'input',conversation_id:'target',owner_id:'owner',session_id:'session',execution_lease:binding.executionLease,input_sha256:'a'.repeat(64),execution_authorized:false};
 const manifest={protocol:1,fork_id:'fork',owner_id:'owner',source:{conversation_id:'source',session_id:'source-native',session_created_at:1,conversation_version:1,head_seq:2,head_sha256:'b'.repeat(64),through_message_id:'old-input'},target:{conversation_id:'target',session_id:'session'},messages:[{message_id:'old-input',role:'user',text:'Inherited material.',content_sha256:'c'.repeat(64),attachments}],role_refs:[]};
 const events=[{seq:0,type:'system/message',data:{}}],surface={nodes:[0]},session={id:'session',header:{agentPreset:'jot-general'},surface,snapshotEvents:()=>structuredClone(events),append(type,data,options={}){const event={seq:events.length,type,data,...options};events.push(event);if(options.surfaceOp==='append')surface.nodes.push(event.seq);else if(options.surfaceOp?.op==='replace'){const first=surface.nodes.indexOf(options.surfaceOp.startSeq),last=surface.nodes.indexOf(options.surfaceOp.endSeq);surface.nodes.splice(first,last-first+1,event.seq);}return event;}};
 let serial=0;const selector=createWorkForkContextSelector({bridge:{request:async path=>path==='ordinary-input-binding'?{binding:authority}:{context:{authority,manifest,manifest_sha256:hash(manifest)}}},sessions:{flush:async()=>true},createUserMessage:input=>({id:'context-'+serial++,role:'user',...input})}),agent={id:'session',session};
 return{events,session,run:()=>selector({agent,binding,signal:new AbortController().signal,check:async()=>{}})};
}
test('ten valid attachment pins with escaped filenames stay within the rendering budget and retain target refs',async t=>{
 const pins=Array.from({length:10},(_,i)=>({artifact_id:'artifact-fork-'+String(i).padStart(40,'0'),version:1,sha256:'a'.repeat(64),size_bytes:1,media_type:'text/plain',file_name:'\u0001'.repeat(255)})),f=fixture(pins);
 await f.run();const text=f.events[1].data.content[0].text;assert.ok(text.length<=7000,'rendered '+text.length+' characters');for(const p of pins)assert.ok(text.includes(p.artifact_id));assert.match(text,/attachment_metadata_omitted/);
 t.diagnostic('ten refs retained; rendered characters='+text.length+'; budget=7000');
});
test('a lost marker without compaction proof or a changed original marker cannot bypass its binding',async()=>{
 for(const changed of [false,true]){const f=fixture();await f.run();const marker=f.events[1];
  const start=f.session.append('compaction/start',{compactionId:'compact'}),summary=f.session.append('compaction/summary',{compactionId:'compact',shadowedRange:{start:marker.seq,end:marker.seq},shadowedSeqs:[marker.seq]});
  f.session.append('user/message',{id:'checkpoint',role:'user',source:{kind:'compact-checkpoint',compactionId:'compact'},content:[{type:'text',text:'Inherited summary'}]},{surfaceOp:{op:'replace',startSeq:marker.seq,endSeq:marker.seq},sourceEventSeqs:changed?[start.seq,summary.seq,marker.seq]:[]});
  f.session.append('compaction/end',{compactionId:'compact'});if(changed)marker.data.source.fork_manifest_sha256='0'.repeat(64);
  await assert.rejects(f.run(),/chat_context_unconfirmed/);assert.equal(f.events.filter(e=>e.data?.source?.kind==='jot-fork-context').length,1);
 }
});
