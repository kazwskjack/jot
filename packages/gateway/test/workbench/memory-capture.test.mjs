import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {openProductDatabase,withImmediateTransaction} from '../../src/db/database.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
function fixture(t){
 const base=resolve('.test-tmp/memory-capture');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),db=openProductDatabase(join(root,'db.sqlite')),options={workspaceIds:['ws','other'],root:join(root,'files')},service=new WorkbenchService(db,options),agent=service.createAgent('alice',{name:'Memory owner'}),runs=new RunRepository(db,new EventStore(db));
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const turn=(text='I prefer concise answers')=>service.enqueueAgentMessage('alice',agent.agent_id,{text,client_message_id:crypto.randomUUID()});
 const finish=(run,status='succeeded',blocks)=>withImmediateTransaction(db,()=>{runs.appendAssistant(run.run_id,'Public answer',blocks);runs.finalizePublication(run.run_id,status,null);});
 return {db,service,agent,runs,options,turn,finish,c:service.memoryCapture};
}
const policy={expected_version:0,mode:'suggest',include_assistant:false,include_automation:false};
test('capture is opt-in for future bindings and waits for the public run to finish',t=>{
 const f=fixture(t);assert.equal(f.c.policy('alice',f.agent.agent_id).mode,'off');const old=f.turn();f.finish(old);f.c.setPolicy('alice',f.agent.agent_id,policy);assert.equal(f.c.collect('alice',f.agent.agent_id).ready,0);
 const current=f.turn();assert.equal(f.c.list('alice',f.agent.agent_id).items.length,1);assert.equal(f.c.collect('alice',f.agent.agent_id).ready,0);f.finish(current);assert.equal(f.c.collect('alice',f.agent.agent_id).ready,1);assert.equal(f.c.collect('alice',f.agent.agent_id).ready,0);
 const batch=f.c.get('alice',f.agent.agent_id,f.c.list('alice',f.agent.agent_id).items[0].capture_id);assert.equal(batch.status,'ready');assert.equal(batch.sources.length,1);assert.equal(batch.sources[0].text,'I prefer concise answers');assert.equal(batch.sources[0].origin,'human');assert.equal(f.service.listMemory('alice','ws',{agent_id:f.agent.agent_id}).items.length,0);
});
test('only complete public text is captured, with explicit truncation and assistant origin',t=>{
 const f=fixture(t);f.c.setPolicy('alice',f.agent.agent_id,{...policy,include_assistant:true});const run=f.turn('x'.repeat(19000));f.finish(run,'succeeded',[{kind:'reasoning',text:'PRIVATE_PROVIDER_REASONING'},{kind:'text',text:'A'.repeat(5000)}]);f.c.collect('alice',f.agent.agent_id);
 const batch=f.c.get('alice',f.agent.agent_id,f.c.list('alice',f.agent.agent_id).items[0].capture_id);assert.equal(batch.sources.length,2);assert.equal(batch.sources[1].origin,'agent');assert.equal(batch.sources[1].truncated,true);assert.equal(batch.info.captured_chars,20000);assert.doesNotMatch(JSON.stringify(batch),/PRIVATE_PROVIDER_REASONING/);
});
test('DSH proposals stay separate from live memory, require real sources, and owner apply is unverified and deduplicated',t=>{
 const f=fixture(t);f.c.setPolicy('alice',f.agent.agent_id,policy);const run=f.turn();f.finish(run);f.c.collect('alice',f.agent.agent_id);const id=f.c.list('alice',f.agent.agent_id).items[0].capture_id,batch=f.c.get('alice',f.agent.agent_id,id),processor=f.turn('Extract pending memories');
 for(const notes of [[{content:'Invented',source_ids:['foreign']}],[{content:'Self verified',source_ids:[batch.sources[0].source_id],verified:true}]])assert.throws(()=>f.c.propose('alice',f.agent.agent_id,id,{expected_version:2,summary:'Invalid candidate',notes},processor.run_id),/invalid_memory_capture/);
 const proposal=f.c.propose('alice',f.agent.agent_id,id,{expected_version:2,summary:'Durable answer preference',notes:[{content:'Prefers concise answers',source_ids:[batch.sources[0].source_id]}]},processor.run_id);assert.equal(proposal.status,'proposed');assert.equal(f.service.listMemory('alice','ws',{agent_id:f.agent.agent_id}).items.length,0);
 const existing=f.service.saveMemory('alice','ws',{scope:'private',agent_id:f.agent.agent_id,content:'Prefers concise answers',verified:true});
 const applied=f.c.apply('alice',f.agent.agent_id,id,3);assert.equal(applied.status,'applied');assert.equal(applied.results[0].reused,true);assert.equal(applied.results[0].memory_id,existing.memory_id);assert.equal(f.service.memoryHistory('alice','ws',existing.memory_id).current_version,1);
});
test('source edits, policy changes and role boundaries prevent stale proposals or application',t=>{
 const f=fixture(t);f.c.setPolicy('alice',f.agent.agent_id,policy);const run=f.turn();f.finish(run);f.c.collect('alice',f.agent.agent_id);const id=f.c.list('alice',f.agent.agent_id).items[0].capture_id,batch=f.c.get('alice',f.agent.agent_id,id),processor=f.turn();
 assert.throws(()=>f.c.get('bob',f.agent.agent_id,id),/agent_not_found|memory_capture_not_found/);
 const other=f.service.createAgent('alice',{name:'Other',project_id:f.agent.project_id});assert.throws(()=>f.c.get('alice',other.agent_id,id),/memory_capture_not_found/);
 f.db.prepare("UPDATE ga_messages SET content_json=? WHERE id=?").run(JSON.stringify({blocks:[{block_id:'changed',kind:'text',text:'New message'}],attachments:[]}),batch.sources[0].message_id);
 const hidden=f.c.get('alice',f.agent.agent_id,id);assert.equal(hidden.sources[0].available,false);assert.equal(Object.hasOwn(hidden.sources[0],'text'),false);
 assert.throws(()=>f.c.propose('alice',f.agent.agent_id,id,{expected_version:2,summary:'Stale',notes:[]},processor.run_id),/memory_capture_source_conflict/);
 f.c.setPolicy('alice',f.agent.agent_id,{expected_version:1,mode:'off'});assert.throws(()=>f.c.propose('alice',f.agent.agent_id,id,{expected_version:2,summary:'Old policy',notes:[]},processor.run_id),/memory_capture_policy_stale/);
});
test('empty extraction is explicit and failed runs never become memory sources',t=>{
 const f=fixture(t);f.c.setPolicy('alice',f.agent.agent_id,policy);const failed=f.turn();f.finish(failed,'failed');const run=f.turn('Just saying hello');f.finish(run);f.c.collect('alice',f.agent.agent_id);
 assert.equal(f.c.list('alice',f.agent.agent_id).items.some(x=>x.status==='source_failed'),true);const batch=f.c.list('alice',f.agent.agent_id).items.find(x=>x.status==='ready'),processor=f.turn();assert.equal(f.c.propose('alice',f.agent.agent_id,batch.capture_id,{expected_version:2,summary:'No durable fact',notes:[]},processor.run_id).status,'no_notes');
 assert.equal(f.c.pending('alice',f.agent.agent_id).items.length,0);
});
test('capture application is one transaction and immutable sources cannot be rewritten',t=>{
 const f=fixture(t);f.c.setPolicy('alice',f.agent.agent_id,policy);const run=f.turn('Two durable preferences');f.finish(run);f.c.collect('alice',f.agent.agent_id);const batch=f.c.get('alice',f.agent.agent_id,f.c.list('alice',f.agent.agent_id).items[0].capture_id),processor=f.turn();
 f.c.propose('alice',f.agent.agent_id,batch.capture_id,{expected_version:2,summary:'Two notes',notes:[{content:'First stable note',source_ids:[batch.sources[0].source_id]},{content:'Second stable note',source_ids:[batch.sources[0].source_id]}]},processor.run_id);
 f.db.exec("CREATE TRIGGER capture_note_failure BEFORE INSERT ON wb_memories WHEN NEW.content='Second stable note' BEGIN SELECT RAISE(ABORT,'synthetic_note_failure'); END;");assert.throws(()=>f.c.apply('alice',f.agent.agent_id,batch.capture_id,3),/synthetic_note_failure/);assert.equal(f.service.listMemory('alice','ws',{agent_id:f.agent.agent_id}).items.length,0);assert.equal(f.c.get('alice',f.agent.agent_id,batch.capture_id).status,'proposed');
 f.db.exec('DROP TRIGGER capture_note_failure');const result=f.c.apply('alice',f.agent.agent_id,batch.capture_id,3);assert.equal(result.results.length,2);const notes=f.service.listMemory('alice','ws',{agent_id:f.agent.agent_id}).items;assert.equal(notes.every(x=>!x.verified&&x.scope==='private'&&x.provenance[0].kind==='conversation_block'),true);
 for(const sql of ["UPDATE wb_memory_captures SET source_json='[]',version=version+1 WHERE capture_id=?",'DELETE FROM wb_memory_captures WHERE capture_id=?','INSERT OR REPLACE INTO wb_memory_captures SELECT * FROM wb_memory_captures WHERE capture_id=?'])assert.throws(()=>f.db.prepare(sql).run(batch.capture_id),/memory_capture_immutable/);
});

test('source role changes hide captured content even when the text hash is unchanged',t=>{
 const f=fixture(t);f.c.setPolicy('alice',f.agent.agent_id,policy);const run=f.turn();f.finish(run);f.c.collect('alice',f.agent.agent_id);const item=f.c.list('alice',f.agent.agent_id).items[0],batch=f.c.get('alice',f.agent.agent_id,item.capture_id);
 f.db.prepare("UPDATE ga_messages SET role='assistant' WHERE id=?").run(batch.sources[0].message_id);
 const hidden=f.c.get('alice',f.agent.agent_id,item.capture_id);assert.equal(hidden.sources[0].available,false);assert.equal(Object.hasOwn(hidden.sources[0],'text'),false);
});

test('audit fields can only be initially populated in their designated transitions',t=>{
 const f=fixture(t);f.c.setPolicy('alice',f.agent.agent_id,policy);const run=f.turn();const item=f.c.list('alice',f.agent.agent_id).items[0];
 for(const field of ['source_json','proposal_json','results_json'])assert.throws(()=>f.db.prepare(`UPDATE wb_memory_captures SET ${field}='[]',status='rejected',version=version+1 WHERE capture_id=?`).run(item.capture_id),/memory_capture_immutable/);
 assert.throws(()=>f.db.prepare("UPDATE wb_memory_captures SET sequence=sequence+100,status='rejected',version=version+1 WHERE capture_id=?").run(item.capture_id),/memory_capture_immutable/);
 assert.equal(f.c.get('alice',f.agent.agent_id,item.capture_id).status,'watching');f.finish(run);assert.equal(f.c.collect('alice',f.agent.agent_id).ready,1);
});

test('deduplication preserves meaningful whitespace inside notes',t=>{
 const f=fixture(t);f.c.setPolicy('alice',f.agent.agent_id,policy);const run=f.turn('Keep the two spaces in this code');f.finish(run);f.c.collect('alice',f.agent.agent_id);const batch=f.c.get('alice',f.agent.agent_id,f.c.list('alice',f.agent.agent_id).items[0].capture_id),processor=f.turn();
 f.service.saveMemory('alice','ws',{scope:'private',agent_id:f.agent.agent_id,content:'literal = "a b"',verified:true});
 f.c.propose('alice',f.agent.agent_id,batch.capture_id,{expected_version:2,summary:'Exact literal',notes:[{content:'literal = "a  b"',source_ids:[batch.sources[0].source_id]}]},processor.run_id);
 const applied=f.c.apply('alice',f.agent.agent_id,batch.capture_id,3);assert.equal(applied.results[0].reused,false);assert.equal(f.service.listMemory('alice','ws',{agent_id:f.agent.agent_id}).items.length,2);
});

test('one collection cannot exceed the pending cap and failures still drain at capacity',t=>{
 const f=fixture(t);f.c.setPolicy('alice',f.agent.agent_id,policy);
 for(let i=0;i<49;i++){const run=f.turn('Stable preference '+i);f.finish(run);}assert.equal(f.c.collect('alice',f.agent.agent_id).ready,49);
 for(let i=0;i<3;i++){const run=f.turn('Next preference '+i);f.finish(run);}
 const failed=f.turn('Failed source');f.finish(failed,'failed');const result=f.c.collect('alice',f.agent.agent_id);assert.equal(result.ready,1);assert.equal(result.skipped,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_memory_captures WHERE status='ready'").get().n,50);assert.equal(f.db.prepare("SELECT count(*) n FROM wb_memory_captures WHERE status='watching'").get().n,2);
});

test('a retained watch whose source run is missing becomes an explicit source failure',t=>{
 const f=fixture(t);f.c.setPolicy('alice',f.agent.agent_id,policy);f.turn();
 f.db.exec(`INSERT INTO wb_memory_captures(capture_id,owner_id,workspace_id,project_id,agent_id,source_run_id,source_conversation_id,run_kind,policy_version,epoch,status,version,created_at,updated_at)
 SELECT 'capture-missing',owner_id,workspace_id,project_id,agent_id,'missing-run',source_conversation_id,run_kind,policy_version,epoch,status,version,created_at,updated_at FROM wb_memory_captures LIMIT 1`);
 assert.equal(f.c.collect('alice',f.agent.agent_id).skipped,1);const batch=f.c.get('alice',f.agent.agent_id,'capture-missing');assert.equal(batch.status,'source_failed');assert.equal(batch.info.source_status,'missing');assert.deepEqual(batch.sources,[]);
});

test('policies and frozen source batches survive closing and reopening the actual database',()=>{
 const base=resolve('.test-tmp/memory-capture');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'restart-')),path=join(root,'db.sqlite'),options={workspaceIds:['ws'],root:join(root,'files')};let db=openProductDatabase(path);
 try{
  const service=new WorkbenchService(db,options),agent=service.createAgent('alice',{name:'Persistent memory'});service.memoryCapture.setPolicy('alice',agent.agent_id,policy);const run=service.enqueueAgentMessage('alice',agent.agent_id,{text:'Remember a durable preference',client_message_id:'restart-source'});
  const runs=new RunRepository(db,new EventStore(db));withImmediateTransaction(db,()=>runs.finalizePublication(run.run_id,'succeeded',null));service.collectMemoryCaptures();const capture=service.memoryCapture.list('alice',agent.agent_id).items[0];db.close();db=openProductDatabase(path);
  const restored=new WorkbenchService(db,options);assert.equal(restored.memoryCapture.policy('alice',agent.agent_id).mode,'suggest');const batch=restored.memoryCapture.get('alice',agent.agent_id,capture.capture_id);assert.equal(batch.status,'ready');assert.equal(batch.sources[0].text,'Remember a durable preference');assert.equal(restored.collectMemoryCaptures().ready,0);
 }finally{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
