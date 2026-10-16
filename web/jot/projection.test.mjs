import test from 'node:test';
import assert from 'node:assert/strict';
import {fromSnapshot,reduceEvent} from './projection.ts';
test('final reconciliation reorders only an existing complete answer in its exact run and leaves creation dates intact',()=>{
 const message=(id,role,run='r',status='complete')=>({message_id:id,run_id:run,role,status,created_at:'2026-10-01T00:00:00Z',blocks:[{block_id:id,kind:'text',text:id}]}),state=fromSnapshot({conversation:{conversation_id:'c'},as_of_seq:'0',messages:[message('original','user'),message('final','assistant'),message('supplement','user')],runs:[],activities:[],sources:[],interactions:[],artifacts:[],stream_cursors:[]});
 const event={schema_version:'1.0',event_id:'event',conversation_id:'c',run_id:'r',seq:'1',at:'2026-10-17T00:00:00Z',type:'response.upsert',payload:{revision:1,value:{kind:'ordinary_final_reconciliation',run_id:'r',message_id:'final',execution_authorized:false}}};
 const next=reduceEvent(state,event);assert.deepEqual(Object.keys(next.messages),['original','supplement','final']);assert.deepEqual(Object.keys(state.messages),['original','final','supplement']);assert.equal(next.messages.final.created_at,state.messages.final.created_at);assert.equal(reduceEvent(next,event),next);
 for(const patch of [{run_id:'other'},{message_id:'missing'},{message_id:'original'},{execution_authorized:true}])assert.throws(()=>reduceEvent(state,{...event,payload:{...event.payload,value:{...event.payload.value,...patch}}}));
 assert.deepEqual(Object.keys(reduceEvent(state,{...event,payload:{revision:1,value:{kind:'other'}}}).messages),Object.keys(state.messages));
});
test('真实流无消息壳也能展示；失败撤回；最终消息替换临时答案',()=>{
 let s=fromSnapshot(snapshot); let seq=BigInt(s.seq);
 const emit=(type,payload)=>s=reduceEvent(s,{schema_version:'1.0',conversation_id:s.conversationId,run_id:'r',at:'2026-09-13',seq:String(++seq),type,payload});
 emit('assistant.delta',{message_id:'stream-r',attempt_id:'a',block_id:'b',kind:'reasoning',delta_index:0,text:'检查约束'});
 assert.equal(s.messages['stream-r'].blocks[0].exposure,'provider');
 emit('assistant.settled',{attempt_id:'a',message:{message_id:'stream-r',run_id:'r',role:'assistant',status:'failed',blocks:[],created_at:''}});
 assert.equal(s.messages['stream-r'].blocks.length,0);
 emit('assistant.delta',{message_id:'stream-r',attempt_id:'b',block_id:'b',kind:'text',delta_index:0,text:'答案'});
 emit('assistant.settled',{attempt_id:'b',message:{message_id:'dsh-native-id',run_id:'r',role:'assistant',status:'complete',blocks:[{block_id:'settled',kind:'text',text:'答案'}],created_at:''}});
 emit('message.created',{message_id:'final-r',run_id:'r',role:'assistant',status:'complete',blocks:[{block_id:'final',kind:'text',text:'答案'}],created_at:''});
 assert.equal(Object.values(s.messages).filter(m=>m.run_id==='r'&&m.blocks.some(b=>b.text==='答案')).length,1);
});
const snapshot={conversation:{conversation_id:'test-chat'},as_of_seq:'0',messages:[],runs:[],activities:[],sources:[],interactions:[],artifacts:[],stream_cursors:[]};
test('runless assistant events do not delete earlier independent replies',()=>{
 let state=fromSnapshot({...snapshot,messages:[]});for(const [index,id]of ['reply-a','reply-b'].entries()){state=reduceEvent(state,{schema_version:'1.0',event_id:id,conversation_id:state.conversationId,run_id:null,seq:String(BigInt(state.seq)+1n),at:'2026-10-05T00:00:00Z',type:'message.created',payload:{message_id:id,run_id:null,role:'assistant',status:'complete',blocks:[{block_id:id,kind:'text',text:`Reply ${index}`}],created_at:'2026-10-05T00:00:00Z'}});}assert.deepEqual(Object.keys(state.messages),['reply-a','reply-b']);
});
const events=[{schema_version:'1.0',event_id:'test-event',conversation_id:'test-chat',run_id:'test-run',seq:'1',at:'2026-10-05T00:00:00Z',type:'message.created',payload:{message_id:'test-message',run_id:'test-run',role:'user',status:'complete',blocks:[{block_id:'test-block',kind:'text',text:'Hello'}],created_at:'2026-10-05T00:00:00Z'}}];
test('重连快照不会同时展示 stream 和最终答案',()=>{
 const m={run_id:'r',role:'assistant',status:'complete',blocks:[{block_id:'b',kind:'text',text:'回答'}],created_at:''};
 const s=fromSnapshot({...snapshot,messages:[{...m,message_id:'stream-r'},{...m,message_id:'final'}]});
 assert.equal(Object.keys(s.messages).length,1);
});
test('完整契约示例可以重放，重复事件不重复追加',()=>{
 let s=fromSnapshot(snapshot);for(const e of events){s=reduceEvent(s,e);assert.equal(reduceEvent(s,e),s)}assert.equal(s.seq,events.at(-1).seq);assert.ok(Object.keys(s.messages).length>0);
});
test('乱序和跨会话事件要求重新同步',()=>{
 const s=fromSnapshot(snapshot);assert.throws(()=>reduceEvent(s,{...events[0],seq:'2'}),/SEQUENCE_GAP/);assert.throws(()=>reduceEvent(s,{...events[0],conversation_id:'other'}),/WRONG_CONVERSATION/);
});
test('超过 Number 精度的序号保持精确',()=>{
 const s=fromSnapshot({...snapshot,as_of_seq:'9007199254740993'});assert.equal(reduceEvent(s,{...events[0],seq:'9007199254740994'}).seq,'9007199254740994');
});
