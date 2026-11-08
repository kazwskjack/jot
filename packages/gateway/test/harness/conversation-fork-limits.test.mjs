import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {buildServer} from '../../src/server.ts';
import {ConversationForks,installConversationForks} from '../../src/harness/conversation-fork.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {validateForkAttachmentSet} from '../../src/harness/fork-attachment-limits.ts';
import {prepareForkAttachmentClones} from '../../src/harness/conversation-fork-attachments.ts';
import {AttachmentResolver} from '../../src/artifacts/resolver.ts';
const MiB=1024*1024,pin=(i,size=1)=>({artifact_id:'source-'+i,version:1,sha256:'a'.repeat(64),size_bytes:size,media_type:'text/plain',file_name:'file-'+i+'.txt'});
const hash=value=>createHash('sha256').update(JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)).digest('hex');
async function fixture(t,pins){
 const service=await buildServer({databasePath:':memory:',workspaces:['ws'],csrfToken:'fork-capacity-csrf-token-0123456789',allowedOrigins:['https://fixture.invalid'],conversationForkSourceClient:{inspectConversationForkSource:async()=>{throw Error('no reread');}}});t.after(async()=>{await service.app.close();service.db.close();});installConversationForks(service.db);
 const owner='owner',source=service.conversations.create(owner,{workspace_id:'ws',title:'Capacity fixture',model:{provider:'fixture',model:'fixture'}}),native=new SessionBindingRepository(service.db).getOrCreate(owner,source.conversation_id),now=new Date().toISOString();
 for(const [i,p] of pins.entries())service.db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,NULL,'assistant','complete',?,?,?)").run('message-'+String(i).padStart(4,'0'),source.conversation_id,JSON.stringify({blocks:[{kind:'text',text:'History '+i}],attachments:[p.artifact_id]}),now,now);
 const counters={metadata:0,byteReads:0,copies:0},forks=new ConversationForks(service.db,{
  readSource:async scope=>{counters.metadata++;return{session_id:native.session_id,session_created_at:1,head_seq:1,head_sha256:'b'.repeat(64),role_refs:[],message_attachments:Object.fromEntries(scope.messages.map((m,i)=>[m.id,[pins[i]]]))};},
  verifyAttachments:async(_scope,pins)=>{counters.byteReads+=pins.length;},
  prepareAttachments:async(_scope,pins)=>{counters.copies+=pins.length;return{remap:p=>p,commit:()=>{}};}
 });
 const input={expected_version:1,through_message_id:'message-'+String(pins.length-1).padStart(4,'0')},key='fork-capacity-key';
 return{...service,owner,source,native,counters,forks,input,key,run:()=>forks.fork(owner,source.conversation_id,input,key)};
}
for(const [name,pins,error] of [
 ['unique count across historical messages',Array.from({length:11},(_,i)=>pin(i)),/fork_attachment_count_invalid/],
 ['aggregate bytes across historical messages',[pin(1,100*MiB),pin(2,100*MiB),pin(3,1)],/fork_attachment_aggregate_size_invalid/]
])test(name+' is refused before any source bytes or clone operation',async t=>{
 const f=await fixture(t,pins);await assert.rejects(f.run(),error);assert.deepEqual(f.counters,{metadata:1,byteReads:0,copies:0});assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversation_forks').get().n,0);
 let reads=0;const original=AttachmentResolver.prototype.snapshotInputForMessage;AttachmentResolver.prototype.snapshotInputForMessage=async()=>{reads++;throw Error('unexpected bytes read');};
 try{await assert.rejects(prepareForkAttachmentClones(f.db,'E:/codex/never-created-fork-capacity-test',{},pins,f.key),error);assert.equal(reads,0);}finally{AttachmentResolver.prototype.snapshotInputForMessage=original;}
});
test('duplicate pins count once across messages and the exact byte/count limits remain valid',async t=>{
 const p=pin(1,200*MiB),f=await fixture(t,Array.from({length:11},()=>({...p})));const result=await f.run();assert.equal(result.state,'ready');assert.deepEqual(f.counters,{metadata:1,byteReads:1,copies:1});
 assert.equal(validateForkAttachmentSet(Array.from({length:10},(_,i)=>pin(i,20*MiB))).length,10);
 assert.deepEqual(f.forks.recoverReceipt(f.owner,f.source.conversation_id,f.input,f.key),result);assert.deepEqual(f.counters,{metadata:1,byteReads:1,copies:1});
});
test('receipt recovery and resumed context recheck the same frozen historical set',async t=>{
 const f=await fixture(t,[pin(1)]),receipt=await f.run(),row=f.db.prepare('SELECT manifest_json FROM ga_conversation_forks WHERE fork_id=?').get(receipt.fork_id),manifest=JSON.parse(row.manifest_json);
 const url='/v1/conversations/'+f.source.conversation_id+'/fork',stamp=new Date().toISOString();
 f.db.prepare('INSERT INTO ga_idempotency(owner_id,operation,idempotency_key,request_sha256,response_status,response_json,created_at,expires_at,receipt_protocol) VALUES(?,?,?,?,201,?,?,?,?)').run(f.owner,'POST '+url,f.key,hash(f.input),JSON.stringify(receipt),stamp,new Date(Date.now()+60000).toISOString(),'conversation-fork-atomic-v1');
 const replay=()=>f.app.inject({method:'POST',url,headers:{'x-user-id':f.owner,'idempotency-key':f.key,origin:'https://fixture.invalid','x-csrf-token':'fork-capacity-csrf-token-0123456789'},payload:f.input});
 assert.equal((await replay()).statusCode,201);
 // Model a pre-limit v3 persisted receipt; never mutate the live source or read bytes.
 f.db.exec('DROP TRIGGER ga_conversation_fork_immutable');
 for(const [pins,error] of [[Array.from({length:11},(_,i)=>pin(i)),/fork_attachment_count_invalid/],[[pin(1,100*MiB),pin(2,100*MiB),pin(3,1)],/fork_attachment_aggregate_size_invalid/]]){
  manifest.messages=pins.map((p,i)=>({...manifest.messages[0],message_id:'historic-'+i,attachments:[p],source_attachments:[p]}));
  f.db.prepare('UPDATE ga_conversation_forks SET manifest_json=?,manifest_sha256=? WHERE fork_id=?').run(JSON.stringify(manifest),hash(manifest),receipt.fork_id);
  assert.throws(()=>f.forks.recoverReceipt(f.owner,f.source.conversation_id,f.input,f.key),error);
  assert.throws(()=>f.forks.context(f.owner,receipt.conversation_id,manifest.target.session_id),error);
  const rejected=await replay();assert.equal(rejected.statusCode,409,rejected.body);assert.equal(rejected.json().error.code,'IDEMPOTENCY_IN_PROGRESS');
  assert.deepEqual(f.counters,{metadata:1,byteReads:1,copies:1});
 }
});
