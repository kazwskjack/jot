import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {MemoryImportService} from '../../src/workbench/memory-import.ts';

function fixture(t,{failSaveAt=0}={}){
 const base=resolve('.test-tmp/memory-import');mkdirSync(base,{recursive:true});
 const root=mkdtempSync(join(base,'case-')),db=openProductDatabase(join(root,'db.sqlite'));
 db.exec(`CREATE TABLE wb_memory_import_batches(owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,import_id TEXT NOT NULL,input_sha256 TEXT NOT NULL,input_json TEXT NOT NULL,preview_json TEXT NOT NULL,
  version INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('previewed','applied')),receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,workspace_id,import_id));
  CREATE TRIGGER wb_memory_import_input_immutable BEFORE UPDATE OF owner_id,workspace_id,import_id,input_sha256,input_json,created_at ON wb_memory_import_batches BEGIN SELECT RAISE(ABORT,'memory_import_input_immutable'); END;
  CREATE TRIGGER wb_memory_import_no_delete BEFORE DELETE ON wb_memory_import_batches BEGIN SELECT RAISE(ABORT,'memory_import_immutable'); END;`);
 const workbench=new WorkbenchService(db,{workspaceIds:['source-ws','target-ws'],root:join(root,'files')}),agent=workbench.createAgent('alice',{name:'Memory import owner'});
 let saveCalls=0;
 const imports=new MemoryImportService(db,{
  authorizeTarget(owner,workspace,target){
   if(owner!=='alice'||!['source-ws','target-ws'].includes(workspace)||target.project_id!==agent.project_id)throw Error('memory_scope_forbidden');
   if(target.scope==='private'&&target.agent_id!==agent.agent_id)throw Error('memory_scope_forbidden');
   return {scope:target.scope,project_id:target.project_id,agent_id:target.scope==='private'?target.agent_id:null};
  },
  save:(owner,workspace,input)=>{if(++saveCalls===failSaveAt)throw Error('fixture_import_write_failure');return workbench.saveMemory(owner,workspace,input);},
 });
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 return {db,workbench,agent,imports};
}

test('versioned import previews an explicit target and applies unverified records once',t=>{
 const {db,workbench,agent,imports}=fixture(t);
 const original=workbench.saveMemory('alice','source-ws',{scope:'project',project_id:agent.project_id,content:'Prefers concise answers.',verified:true,provenance:[{kind:'chat',reference:'run-1'}],source_revision:'source-revision-8'});
 const document=workbench.exportMemory('alice','source-ws');
 const input={import_id:'backup-2026-01',document,target:{scope:'project',project_id:agent.project_id}};
 const preview=imports.preview('alice','target-ws',input);
 assert.equal(preview.import_id,input.import_id);
 assert.equal(preview.items.length,1);
 assert.equal(preview.items[0].source_version,original.version);
 assert.deepEqual(preview.items[0].source_history_versions,[original.version]);
 assert.match(preview.input_sha256,/^[a-f0-9]{64}$/);
 assert.equal(preview.items[0].status,'ready');
 const applied=imports.apply('alice','target-ws',{import_id:input.import_id,expected_version:preview.version});
 assert.equal(applied.status,'applied');
 assert.equal(applied.items.length,1);
 const imported=db.prepare('SELECT * FROM wb_memories WHERE owner_id=? AND workspace_id=? AND memory_id=?').get('alice','target-ws',applied.items[0].memory_id);
 assert.equal(imported.content,original.content);
 assert.equal(imported.verified,0);
 assert.equal(imported.scope,'project');
 assert.notEqual(imported.memory_id,original.memory_id);
 assert.deepEqual(imports.apply('alice','target-ws',{import_id:input.import_id,expected_version:preview.version}),applied);
 assert.equal(db.prepare("SELECT count(*) AS count FROM wb_memories WHERE owner_id='alice' AND workspace_id='target-ws'").get().count,1);
});

test('the durable preview shows the exact source content and provenance to its authorized owner',t=>{
 const {workbench,agent,imports}=fixture(t);
 const original=workbench.saveMemory('alice','source-ws',{scope:'project',project_id:agent.project_id,content:'Review this exact source fact.',provenance:[{kind:'decision',reference:'reviewed-note-4'}]});
 const preview=imports.preview('alice','target-ws',{import_id:'batch-visible-source',document:workbench.exportMemory('alice','source-ws'),target:{scope:'project',project_id:agent.project_id}});
 assert.equal(preview.items[0].source_content,original.content);
 assert.deepEqual(preview.items[0].source_provenance,[{kind:'decision',reference:'reviewed-note-4'}]);
 assert.equal(preview.target.scope,'project');
});

test('an intervening source tombstone or target revision blocks the whole import batch',t=>{
 const {db,workbench,agent,imports}=fixture(t);
 const first=workbench.saveMemory('alice','source-ws',{scope:'project',project_id:agent.project_id,content:'Source one'});
 const second=workbench.saveMemory('alice','source-ws',{scope:'project',project_id:agent.project_id,content:'Source two'});
 const document=workbench.exportMemory('alice','source-ws');
 const preview=imports.preview('alice','target-ws',{import_id:'batch-stale',document,target:{scope:'project',project_id:agent.project_id}});
 assert.equal(preview.items.length,2);
 workbench.deleteMemory('alice','source-ws',first.memory_id,first.version);
 assert.throws(()=>imports.apply('alice','target-ws',{import_id:'batch-stale',expected_version:preview.version}),/memory_import_conflict/);
 assert.equal(db.prepare("SELECT count(*) AS count FROM wb_memories WHERE owner_id='alice' AND workspace_id='target-ws'").get().count,0);

 const fresh=workbench.exportMemory('alice','source-ws');
 const next=imports.preview('alice','target-ws',{import_id:'batch-target-race',document:fresh,target:{scope:'project',project_id:agent.project_id}});
 const collided=next.items.find(item=>item.source_memory_id===second.memory_id);
 workbench.saveMemory('alice','target-ws',{scope:'project',project_id:agent.project_id,content:'Concurrent target write',provenance:[{kind:'import',reference:collided.target_key}]});
 assert.throws(()=>imports.apply('alice','target-ws',{import_id:'batch-target-race',expected_version:next.version}),/memory_import_conflict/);
 assert.equal(db.prepare("SELECT count(*) AS count FROM wb_memories WHERE owner_id='alice' AND workspace_id='target-ws'").get().count,1);
});

test('an export skips already superseded source versions while importing the current replacement',t=>{
 const {db,workbench,agent,imports}=fixture(t);
 const retired=workbench.saveMemory('alice','source-ws',{scope:'project',project_id:agent.project_id,content:'Old project decision'});
 workbench.saveMemory('alice','source-ws',{scope:'project',project_id:agent.project_id,content:'Current project decision',supersedes:retired.memory_id});
 const input={import_id:'batch-superseded',document:workbench.exportMemory('alice','source-ws'),target:{scope:'project',project_id:agent.project_id}};
 const preview=imports.preview('alice','target-ws',input),old=preview.items.find(item=>item.source_memory_id===retired.memory_id);
 assert.equal(old.status,'skipped');assert.equal(old.reason,'source_superseded');
 assert.equal(preview.counts.ready,1);assert.equal(preview.counts.conflict,0);
 const receipt=imports.apply('alice','target-ws',{import_id:input.import_id,expected_version:preview.version});
 assert.equal(receipt.items.filter(item=>item.status==='created').length,1);
 assert.equal(receipt.items.filter(item=>item.status==='skipped').length,1);
 assert.equal(db.prepare("SELECT count(*) AS count FROM wb_memories WHERE owner_id='alice' AND workspace_id='target-ws'").get().count,1);
});

test('a failure after the first item rolls back the batch and leaves its receipt retryable',t=>{
 const {db,workbench,agent,imports}=fixture(t,{failSaveAt:2});
 workbench.saveMemory('alice','source-ws',{scope:'project',project_id:agent.project_id,content:'Atomic source one'});
 workbench.saveMemory('alice','source-ws',{scope:'project',project_id:agent.project_id,content:'Atomic source two'});
 const input={import_id:'batch-atomic',document:workbench.exportMemory('alice','source-ws'),target:{scope:'project',project_id:agent.project_id}};
 const preview=imports.preview('alice','target-ws',input);
 assert.throws(()=>imports.apply('alice','target-ws',{import_id:input.import_id,expected_version:preview.version}),/fixture_import_write_failure/);
 assert.equal(db.prepare("SELECT count(*) AS count FROM wb_memories WHERE owner_id='alice' AND workspace_id='target-ws'").get().count,0);
 assert.equal(imports.get('alice','target-ws',input.import_id).status,'previewed');
 const receipt=imports.apply('alice','target-ws',{import_id:input.import_id,expected_version:preview.version});
 assert.equal(receipt.items.filter(item=>item.status==='created').length,2);
 assert.equal(db.prepare("SELECT count(*) AS count FROM wb_memories WHERE owner_id='alice' AND workspace_id='target-ws'").get().count,2);
});

test('reusing an import id with a different source snapshot is rejected',t=>{
 const {workbench,agent,imports}=fixture(t);
 const original=workbench.saveMemory('alice','source-ws',{scope:'project',project_id:agent.project_id,content:'Source fact'});
 const document=workbench.exportMemory('alice','source-ws'),target={scope:'project',project_id:agent.project_id};
 imports.preview('alice','target-ws',{import_id:'batch-reused',document,target});
 const changed=structuredClone(document);changed.items[0].content='Forged content';changed.items[0].history.at(-1).content='Forged content';
 assert.throws(()=>imports.preview('alice','target-ws',{import_id:'batch-reused',document:changed,target}),/memory_import_id_conflict/);
 assert.equal(original.content,'Source fact');
});
