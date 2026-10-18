import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {ConversationRepository} from '../../src/conversations/repository.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
const implementation=await import('../../src/conversations/chat-web-allowance.ts').catch(()=>({}));
const policy={protocol:1,mode:'chat',model:{provider:'fixture',model:'fast'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-native-v1',context_revision:'bounded-text-v1'};
function fixture(db){
 assert.equal(typeof implementation.reserveOrdinaryChatWeb,'function','durable original Chat Web allowance is not implemented');
 const conversations=new ConversationRepository(db),runs=new RunRepository(db,new EventStore(db)),c=conversations.create('web-owner',{workspace_id:'ws',mode:'chat',model:{provider:'fixture',model:'work'}},{chatPolicy:policy});
 const accepted=runs.enqueue(c.conversation_id,'web-owner',{client_message_id:'web-current',content:[{type:'text',text:'Synthetic current question.'}]},{modePolicy:policy}),coordinator=new HarnessCoordinator(db,runs,new EventStore(db));let lease=coordinator.claimNext('web-worker',30000);coordinator.start(lease);
 const row=db.prepare('SELECT * FROM ga_runs WHERE id=?').get(accepted.run_id),scope=()=>({run_id:accepted.run_id,session_ref:row.native_session_ref,execution_lease:{owner:lease.owner,generation:lease.generation}});
 const reserve=(group,call_id)=>implementation.reserveOrdinaryChatWeb(db,{...scope(),group,call_id});
 return{accepted,row,reserve,scope,replace(){db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()-1),accepted.run_id);lease=coordinator.claimNext('replacement-web-worker',30000);coordinator.start(lease);}};
}
const group=(kind,step,calls)=>({protocol:1,kind,native_turn:1,native_step:step,assistant_seq:10+step,assistant_message_id:'assistant-'+step,calls:calls.map(([call_id,args])=>({call_id,name:kind==='search'?'web_search':'web_fetch',arguments:args}))});
test('one frozen search group and fetch group allow their parallel members once before any effect',t=>{
 const db=openProductDatabase(':memory:');t.after(()=>db.close());const f=fixture(db),search=group('search',1,[['search-a',{queries:['synthetic one','synthetic two']}],['search-b',{queries:['synthetic three']}]]),fetch=group('fetch',2,[['fetch-a',{url:'https://example.com/one'}],['fetch-b',{url:'https://example.com/two'}]]);
 for(const g of [search,fetch])for(const call of g.calls){const receipt=f.reserve(g,call.call_id);assert.equal(receipt.first_dispatch,true);assert.equal(receipt.run_id,f.accepted.run_id);assert.match(receipt.group_sha256,/^[a-f0-9]{64}$/);assert.equal(f.reserve(g,call.call_id).first_dispatch,false);}
 assert.equal(db.prepare('SELECT count(*) n FROM ga_chat_web_groups').get().n,2);assert.equal(db.prepare('SELECT count(*) n FROM ga_chat_web_calls').get().n,4);
 assert.throws(()=>f.reserve(group('search',3,[['search-c',{queries:['second round']}]]),'search-c'),/chat_web_group_exhausted/);
 assert.throws(()=>f.reserve({...search,native_turn:2},'search-a'),/chat_web_group_exhausted/);
 assert.throws(()=>db.prepare("UPDATE ga_chat_web_groups SET native_step=999").run(),/chat_web_group_immutable/);
 assert.throws(()=>db.prepare("UPDATE ga_chat_web_calls SET request_sha256=?").run('f'.repeat(64)),/chat_web_call_immutable/);
});
test('duplicate fetch URLs, lost acknowledgements, and replacement leases do not obtain another effect',t=>{
 const db=openProductDatabase(':memory:');t.after(()=>db.close());const f=fixture(db),g=group('fetch',1,[['a',{url:'https://EXAMPLE.com:443/item#first'}],['b',{url:'https://example.com/item#second'}]]);
 assert.equal(f.reserve(g,'a').first_dispatch,true);const old=f.scope();f.replace();assert.equal(f.reserve(g,'a').first_dispatch,false);assert.equal(f.reserve(g,'b').first_dispatch,false);
 assert.throws(()=>implementation.reserveOrdinaryChatWeb(db,{...old,group:g,call_id:'a'}));assert.equal(db.prepare('SELECT count(*) n FROM ga_chat_web_calls').get().n,1);
});
test('foreign Session, missing members, changed arguments and malformed group cannot consume allowance',t=>{
 const db=openProductDatabase(':memory:');t.after(()=>db.close());const f=fixture(db),g=group('search',1,[['a',{queries:['synthetic']}]]);
 for(const changed of [{...g,native_turn:'1'},{...g,calls:[...g.calls,...g.calls]},{...g,calls:[{...g.calls[0],name:'bash'}]},{...g,owner_id:'other'}])assert.throws(()=>f.reserve(changed,'a'));
 assert.throws(()=>f.reserve(g,'missing'));assert.throws(()=>implementation.reserveOrdinaryChatWeb(db,{...f.scope(),session_ref:'foreign-session',group:g,call_id:'a'}));
 assert.equal(db.prepare('SELECT count(*) n FROM ga_chat_web_groups').get().n,0);
 f.reserve(g,'a');assert.throws(()=>f.reserve({...g,calls:[{...g.calls[0],arguments:{queries:['changed']}}]},'a'),/chat_web_group_exhausted/);
});
test('a consumed call survives closing the database and reopening under a replacement worker',()=>{
 const base=resolve('.test-tmp/chat-web-reopen');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),path=join(root,'product.db');let db;
 try{db=openProductDatabase(path);const f=fixture(db),g=group('fetch',1,[['a',{url:'https://example.com/synthetic'}]]);assert.equal(f.reserve(g,'a').first_dispatch,true);const scope=f.scope();db.close();db=openProductDatabase(path);
  assert.equal(implementation.reserveOrdinaryChatWeb(db,{...scope,group:g,call_id:'a'}).first_dispatch,false);
 }finally{db?.close();const child=relative(base,root);assert.ok(child&&!isAbsolute(child)&&!child.startsWith('..'));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
