import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';

function fixture(t){
 const base=resolve('.test-tmp/memory-consolidation');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 const db=openProductDatabase(join(root,'db.sqlite')),options={workspaceIds:['ws','other'],root:join(root,'files')},service=new WorkbenchService(db,options),agent=service.createAgent('alice',{name:'Researcher'});
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const save=fields=>service.saveMemory('alice','ws',{scope:'project',project_id:agent.project_id,content:'Original finding',...fields});
 const input=ids=>({project_id:agent.project_id,scope:'project',memory_ids:ids});
 return {db,root,options,service,agent,save,input,c:service.memoryConsolidations};
}
function proposed(f,changes){
 const a=f.save({content:'Earlier conclusion',verified:true,provenance:[{kind:'document',reference:'notes.md'}]}),b=f.save({content:'Repeated conclusion'});
 const stage=f.c.stage('alice','ws',f.input([a.memory_id,b.memory_id]));
 const proposal=f.c.propose('alice','ws',stage.consolidation_id,{expected_version:1,summary:'Merge repeated notes',changes:changes?.(a,b)??[{action:'rewrite',memory_id:a.memory_id,content:'A concise combined conclusion'},{action:'supersede',memory_id:b.memory_id,replacement_id:a.memory_id}]});
 return {a,b,stage,proposal};
}

test('staging freezes sources and proposal leaves live memory unchanged until atomic user application',t=>{
 const f=fixture(t),{a,b,stage,proposal}=proposed(f);
 assert.equal(stage.status,'draft');assert.equal(proposal.status,'proposed');assert.equal(proposal.version,2);
 assert.equal(f.service.memoryHistory('alice','ws',a.memory_id).current_version,1);
 const applied=f.c.apply('alice','ws',stage.consolidation_id,2);assert.equal(applied.status,'applied');assert.equal(applied.version,3);
 const live=f.service.listMemory('alice','ws',{project_id:f.agent.project_id}).items;assert.equal(live.length,1);assert.equal(live[0].content,'A concise combined conclusion');assert.equal(live[0].verified,false);assert.deepEqual(live[0].provenance,a.provenance);
 assert.equal(f.db.prepare('SELECT status,version FROM wb_memories WHERE memory_id=?').get(b.memory_id).status,'superseded');
 assert.equal(applied.sources[0].content,a.content);assert.equal(applied.results.length,2);
 const rolled=f.c.rollback('alice','ws',stage.consolidation_id,3);assert.equal(rolled.status,'rolled_back');
 const restored=f.service.listMemory('alice','ws',{project_id:f.agent.project_id}).items;assert.equal(restored.length,2);assert.equal(restored.find(x=>x.memory_id===a.memory_id).content,a.content);assert.equal(restored.every(x=>x.version===3&&!x.verified),true);
 assert.throws(()=>f.c.apply('alice','ws',stage.consolidation_id,4),/memory_consolidation_state_conflict/);
});

test('owner, scope, role, exact fields and replacement graph are enforced before any live change',t=>{
 const f=fixture(t),{a,b,stage}=proposed(f);
 assert.throws(()=>f.c.get('bob','ws',stage.consolidation_id),/memory_consolidation_not_found/);
 assert.throws(()=>f.c.get('alice','other',stage.consolidation_id),/memory_consolidation_not_found/);
 assert.throws(()=>f.c.stage('alice','ws',{...f.input([a.memory_id]),owner_id:'bob'}),/invalid_memory_consolidation/);
 const privateMemory=f.save({scope:'private',agent_id:f.agent.agent_id});assert.throws(()=>f.c.stage('alice','ws',f.input([privateMemory.memory_id])),/memory_scope_forbidden/);
 for(const changes of [[{action:'supersede',memory_id:a.memory_id,replacement_id:a.memory_id}],[{action:'supersede',memory_id:a.memory_id,replacement_id:b.memory_id},{action:'supersede',memory_id:b.memory_id,replacement_id:a.memory_id}],[{action:'rewrite',memory_id:a.memory_id,content:'A',verified:true}],[{action:'rewrite',memory_id:a.memory_id,content:'A'},{action:'rewrite',memory_id:a.memory_id,content:'B'}]]){
  const draft=f.c.stage('alice','ws',f.input([a.memory_id,b.memory_id]));assert.throws(()=>f.c.propose('alice','ws',draft.consolidation_id,{expected_version:1,summary:'Invalid candidate',changes}),/invalid_memory_consolidation/);
 }
 assert.equal(f.service.memoryHistory('alice','ws',a.memory_id).current_version,1);
});

test('an intervening edit to any frozen source blocks the whole application',t=>{
 const f=fixture(t),{a,b,stage}=proposed(f, a=>[{action:'rewrite',memory_id:a.memory_id,content:'Merged'}]);
 f.save({memory_id:b.memory_id,expected_version:1,content:'New evidence after staging'});
 assert.throws(()=>f.c.apply('alice','ws',stage.consolidation_id,2),/version_conflict/);
 assert.equal(f.service.memoryHistory('alice','ws',a.memory_id).current_version,1);assert.equal(f.c.get('alice','ws',stage.consolidation_id).status,'proposed');
});

test('rollback cannot overwrite later edits, explicit deletion or expired memory',t=>{
 for(const change of ['edit','delete','expire']){
  const f=fixture(t),{a,stage}=proposed(f);f.c.apply('alice','ws',stage.consolidation_id,2);
  if(change==='edit')f.save({memory_id:a.memory_id,expected_version:2,content:'Later user correction'});
  if(change==='delete')f.service.deleteMemory('alice','ws',a.memory_id,2);
  if(change==='expire')f.db.prepare('UPDATE wb_memories SET expires_at=? WHERE memory_id=?').run('2000-01-01T00:00:00.000Z',a.memory_id);
  assert.throws(()=>f.c.rollback('alice','ws',stage.consolidation_id,3),/version_conflict|memory_consolidation_source_conflict/);
  assert.equal(f.c.get('alice','ws',stage.consolidation_id).status,'applied');
 }
});

test('a failing second revision write rolls back every row, index and batch status',t=>{
 const f=fixture(t),{a,b,stage}=proposed(f);
 f.db.exec(`CREATE TRIGGER fail_second_consolidation BEFORE INSERT ON wb_memory_revisions WHEN NEW.memory_id='${b.memory_id}' AND NEW.version=2 BEGIN SELECT RAISE(ABORT,'synthetic_revision_failure'); END;`);
 assert.throws(()=>f.c.apply('alice','ws',stage.consolidation_id,2),/synthetic_revision_failure/);
 assert.equal(f.service.memoryHistory('alice','ws',a.memory_id).current_version,1);assert.equal(f.service.memoryHistory('alice','ws',b.memory_id).current_version,1);
 assert.equal(f.db.prepare('SELECT revision FROM wb_memory_index_jobs WHERE memory_id=?').get(a.memory_id).revision,1);assert.equal(f.c.get('alice','ws',stage.consolidation_id).version,2);
});

test('no-op and rejection are durable and snapshots cannot be rewritten or replaced',t=>{
 const f=fixture(t),a=f.save({}),draft=f.c.stage('alice','ws',f.input([a.memory_id]));
 f.c.propose('alice','ws',draft.consolidation_id,{expected_version:1,summary:'No duplicate or conflicting finding',changes:[]});
 assert.deepEqual(f.c.apply('alice','ws',draft.consolidation_id,2).results,[]);assert.equal(f.c.rollback('alice','ws',draft.consolidation_id,3).status,'rolled_back');
 for(const sql of ["UPDATE wb_memory_consolidations SET sources_json='[]',version=version+1 WHERE consolidation_id=?",'DELETE FROM wb_memory_consolidations WHERE consolidation_id=?','INSERT OR REPLACE INTO wb_memory_consolidations SELECT * FROM wb_memory_consolidations WHERE consolidation_id=?'])assert.throws(()=>f.db.prepare(sql).run(draft.consolidation_id),/memory_consolidation_immutable/);
 const rejected=f.c.stage('alice','ws',f.input([a.memory_id]));assert.equal(f.c.reject('alice','ws',rejected.consolidation_id,1).status,'rejected');
 const reopened=new WorkbenchService(f.db,f.options);assert.equal(reopened.memoryConsolidations.get('alice','ws',draft.consolidation_id).status,'rolled_back');assert.equal(reopened.memoryConsolidations.list('alice','ws',{project_id:f.agent.project_id,scope:'project'}).items.length,2);
});

test('scope revocation, expired staging and unsafe proposal metadata cannot bypass the frozen transaction',t=>{
 const f=fixture(t),privateNote=f.save({scope:'private',agent_id:f.agent.agent_id}),input={scope:'private',project_id:f.agent.project_id,agent_id:f.agent.agent_id,memory_ids:[privateNote.memory_id]};
 const stage=f.c.stage('alice','ws',input);f.c.propose('alice','ws',stage.consolidation_id,{expected_version:1,summary:'Compact',changes:[{action:'rewrite',memory_id:privateNote.memory_id,content:'Compact'}]});
 f.service.deleteAgent('alice',f.agent.agent_id,f.agent.version);
 assert.throws(()=>f.c.apply('alice','ws',stage.consolidation_id,2),/agent_capability_revoked|agent_not_found|agent_not_active/);
 const other=f.service.createAgent('alice',{name:'Active curator'}),expired=f.service.saveMemory('alice','ws',{scope:'project',project_id:other.project_id,content:'Old',expires_at:'2000-01-01T00:00:00Z'});
 assert.throws(()=>f.c.stage('alice','ws',{scope:'project',project_id:other.project_id,memory_ids:[expired.memory_id]}),/memory_not_found/);
});

test('list pages expose bounded summaries, not repeated source and proposal bodies',t=>{
 const f=fixture(t),{stage}=proposed(f);const page=f.c.list('alice','ws',{scope:'project',project_id:f.agent.project_id});
 assert.equal(page.items.length,1);assert.equal(page.items[0].summary,'Merge repeated notes');assert.equal(page.items[0].change_count,2);
 for(const field of ['sources','proposal','results','rollback_results','owner_id','run_id'])assert.equal(Object.hasOwn(page.items[0],field),false);
 assert.equal(f.c.get('alice','ws',stage.consolidation_id).proposal.changes.length,2);
});

test('staged inputs, applied receipts and rollback remain valid after closing and reopening SQLite',t=>{
 const base=resolve('.test-tmp/memory-consolidation-restart');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),path=join(root,'restart.sqlite'),options={workspaceIds:['ws'],root:join(root,'files')};let db=openProductDatabase(path);
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 let service=new WorkbenchService(db,options);const agent=service.createAgent('alice',{name:'Restart curator'}),note=service.saveMemory('alice','ws',{scope:'private',agent_id:agent.agent_id,content:'Before restart',verified:true});
 const stage=service.memoryConsolidations.stage('alice','ws',{scope:'private',agent_id:agent.agent_id,project_id:agent.project_id,memory_ids:[note.memory_id]});
 service.memoryConsolidations.propose('alice','ws',stage.consolidation_id,{expected_version:1,summary:'Persisted candidate',changes:[{action:'rewrite',memory_id:note.memory_id,content:'After restart'}]});
 db.close();db=openProductDatabase(path);service=new WorkbenchService(db,options);assert.equal(service.memoryConsolidations.get('alice','ws',stage.consolidation_id).status,'proposed');
 service.memoryConsolidations.apply('alice','ws',stage.consolidation_id,2);db.close();db=openProductDatabase(path);service=new WorkbenchService(db,options);
 assert.equal(service.memoryConsolidations.get('alice','ws',stage.consolidation_id).results[0].version,2);assert.equal(service.memoryHistory('alice','ws',note.memory_id).current_version,2);
 service.memoryConsolidations.rollback('alice','ws',stage.consolidation_id,3);assert.equal(service.listMemory('alice','ws',{scope:'private',agent_id:agent.agent_id}).items[0].content,'Before restart');
 db.close();db=openProductDatabase(path);service=new WorkbenchService(db,options);assert.equal(service.memoryConsolidations.get('alice','ws',stage.consolidation_id).status,'rolled_back');
 assert.throws(()=>db.prepare('DELETE FROM wb_memory_consolidations WHERE consolidation_id=?').run(stage.consolidation_id),/memory_consolidation_immutable/);
});
