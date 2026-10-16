import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {WorkbenchBudgetPolicy,taskBudgetKey} from '../../src/workbench/model-budget-policy.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import {DiscoveryPolicies} from '../../src/always-on/discovery-policy.ts';
import {maintainWorkbench} from '../../src/persistent-tasks/scheduler.ts';
const Collector=(await import('../../src/always-on/source-collector.ts').catch(()=>({}))).DiscoverySourceCollector;
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jot-source-collector-')),db=openProductDatabase(join(root,'db.sqlite'));
 const limit={tokens:5000,nano_usd:50000,model_calls:50},route={provider:'fixture',model:'bounded',revision:'rates-1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}};
 const budget=new WorkbenchBudgetPolicy(db,{revision:1,admission_route:{provider:'fixture',model:'bounded'},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(k=>[k,{...limit}]))});
 const workbench=new WorkbenchService(db,{root:join(root,'files'),workspaceIds:['ws'],modelBudgetPolicy:budget}),tasks=new PersistentTaskService(db,workbench,{modelBudgetPolicy:budget});
 const policies=new DiscoveryPolicies(db,{onChange:(owner,receipt,event)=>tasks.synchronizeDiscoveryPolicy(owner,receipt.policy_id,event)}),agent=workbench.createAgent('owner',{name:'Synthetic collector'}),scope={project_id:agent.project_id,workspace_id:'ws',agent_id:agent.agent_id};
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 const enable=()=>{policies.save('owner',scope,{expected_version:0,expected_role_version:1,expected_role_epoch:1,mode:'discover_only',cooldown_ms:300000,recent_input_ms:60000,max_cycles:null},'save');return policies.control('owner',scope,{action:'enable',expected_version:1,expected_role_version:1,expected_role_epoch:1},'enable');};
 const file=(path,version=0)=>workbench.writeFile('owner','ws',{project_id:agent.project_id,path,expected_version:version,content:'PRIVATE synthetic contents'});
 const chat=(id='input')=>workbench.enqueueAgentMessage('owner',agent.agent_id,{text:'PRIVATE synthetic input',client_message_id:id});
 const collector=(batchSize=50)=>new Collector(db,policies,{batchSize});
 const signals=()=>db.prepare('SELECT * FROM wb_discovery_signals ORDER BY revision').all();
 return{db,workbench,tasks,policies,budget,agent,scope,enable,file,chat,collector,signals};
}
test('trusted collector is available',()=>assert.equal(typeof Collector,'function'));
test('absent, off and stopped policies neither collect nor create defaults',t=>{const f=fixture(t);f.file('notes.md');const c=f.collector(),before=f.db.prepare('SELECT total_changes() n').get().n;assert.equal(c.collect('owner',f.scope).reason,'POLICY_OFF');assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);f.enable();f.policies.control('owner',f.scope,{action:'stop',expected_version:2},'stop');assert.equal(c.collect('owner',f.scope).reason,'POLICY_OFF');assert.equal(f.signals().length,0);});
test('real role chat and immutable file versions are deduplicated without creating runs or exposing text',t=>{const f=fixture(t);f.enable();f.chat();f.file('notes.md');f.file('notes.md',1);const before=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,c=f.collector(),r=c.collect('owner',f.scope);assert.equal(r.recorded,3);assert.equal(r.caught_up,true);assert.equal(r.execution_authorized,false);assert.equal(c.collect('owner',f.scope).recorded,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before);assert.deepEqual(f.signals().filter(x=>x.kind==='workspace_change').map(x=>x.source_version),[1,2]);assert.ok(!JSON.stringify([r,f.signals()]).includes('PRIVATE'));assert.ok(!JSON.stringify(f.signals()).includes('notes.md'));assert.ok(Object.isFrozen(r));});
test('bounded collection drains every version and paused policies never resume',t=>{const f=fixture(t);f.enable();for(let i=0;i<7;i++)f.file('notes.md',i);f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause');const c=f.collector(2);let total=0;for(let i=0;i<5;i++){const r=c.collect('owner',f.scope);assert.ok(r.recorded<=2);total+=r.recorded;if(r.caught_up)break;}assert.equal(total,7);assert.equal(f.policies.get('owner',f.scope).policy.state,'paused');assert.equal(f.tasks.list('owner').items[0].status,'paused');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);});
test('foreign scope and revoked role cannot contribute signals',t=>{const f=fixture(t);f.enable();f.file('notes.md');assert.throws(()=>f.collector().collect('other',f.scope),/discovery_scope_unavailable/);f.workbench.updateAgent('owner',f.agent.agent_id,{expected_version:1,instructions:'Changed'});assert.equal(f.collector().collect('owner',f.scope).reason,'ROLE_REVOKED');assert.equal(f.signals().length,0);});
test('file provenance follows the original cumulative task budget, including a derived run',t=>{const f=fixture(t);const enabled=f.enable(),binding=f.db.prepare('SELECT task_id FROM wb_discovery_task_bindings WHERE policy_id=?').get(enabled.policy_id);const original=f.chat('external');
 // Synthetic original ledger lineage, not an executed discovery/SDK cycle.
 const run='derived-output';f.db.prepare("INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES(?,?,'queued','now','now')").run(run,f.agent.conversation_id);
 const root=f.budget.ledger.createScope('owner',taskBudgetKey(binding.task_id),{tokens:5000,nano_usd:50000,model_calls:50});f.budget.ledger.bindRun('owner',run,[root.scope_id]);
 const file=f.file('generated.md');f.db.prepare('INSERT INTO wb_file_write_runs VALUES(?,?,?,?,?,?,?,?)').run(run,'owner','ws',f.agent.project_id,file.path,file.version,file.sha256,file.size);
 assert.equal(f.collector().collect('owner',f.scope).recorded,1);assert.equal(f.signals()[0].kind,'user_input');assert.equal(f.db.prepare('SELECT id FROM ga_runs WHERE id=?').get(original.run_id).id,original.run_id);
});
test('unknown recorded file producer is held instead of guessed external',t=>{const f=fixture(t);f.enable();const file=f.file('unknown.md'),run='unknown-producer';f.db.prepare("INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES(?,?,'queued','now','now')").run(run,f.agent.conversation_id);f.db.prepare('INSERT INTO wb_file_write_runs VALUES(?,?,?,?,?,?,?,?)').run(run,'owner','ws',f.agent.project_id,file.path,file.version,file.sha256,file.size);const r=f.collector().collect('owner',f.scope);assert.equal(r.recorded,0);assert.equal(r.caught_up,false);assert.equal(r.reason,'SOURCE_PROVENANCE_UNCONFIRMED');assert.equal(f.signals().length,0);});
test('journal failure rolls back the complete batch and retry reads the original sources',t=>{const f=fixture(t);f.enable();f.file('first.md');f.file('second.md');f.db.exec("CREATE TRIGGER synthetic_signal_failure BEFORE INSERT ON wb_discovery_signals WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END;");assert.throws(()=>f.collector().collect('owner',f.scope),/synthetic_failure/);assert.equal(f.signals().length,0);f.db.exec('DROP TRIGGER synthetic_signal_failure');assert.equal(f.collector().collect('owner',f.scope).recorded,2);});

test('other roles and owners do not promote their private inputs into this role policy',t=>{
 const f=fixture(t);f.enable();const peer=f.workbench.createAgent('owner',{name:'Peer',project_id:f.agent.project_id}),foreign=f.workbench.createAgent('other',{name:'Foreign'});
 f.workbench.enqueueAgentMessage('owner',peer.agent_id,{text:'PRIVATE peer input',client_message_id:'peer'});
 f.workbench.enqueueAgentMessage('other',foreign.agent_id,{text:'PRIVATE foreign input',client_message_id:'foreign'});
 f.workbench.writeFile('other','ws',{project_id:foreign.project_id,path:'foreign.md',content:'PRIVATE foreign',expected_version:0});
 assert.equal(f.collector().collect('owner',f.scope).recorded,0);assert.equal(f.signals().length,0);
});
test('an unresolved old file version holds later versions until original lineage is available',t=>{
 const f=fixture(t);f.enable();const file=f.file('ordered.md'),run='late-producer';
 f.db.prepare("INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES(?,?,'queued','now','now')").run(run,f.agent.conversation_id);
 f.db.prepare('INSERT INTO wb_file_write_runs VALUES(?,?,?,?,?,?,?,?)').run(run,'owner','ws',f.agent.project_id,file.path,file.version,file.sha256,file.size);
 f.file('ordered.md',1);const c=f.collector();assert.equal(c.collect('owner',f.scope).recorded,0);
 const scope=f.budget.ledger.createScope('owner','synthetic-ordinary-output',{tokens:5000,nano_usd:50000,model_calls:50});f.budget.ledger.bindRun('owner',run,[scope.scope_id]);
 assert.equal(c.collect('owner',f.scope).recorded,2);assert.deepEqual(f.signals().map(x=>x.source_version),[1,2]);
});
test('original maintenance journals source metadata without task admission or model attempts',async t=>{
 const f=fixture(t);f.enable();f.file('source.md');const before=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;
 const result=await maintainWorkbench(f.workbench,f.tasks,true);assert.equal(result.discovery_sources.recorded,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,0);
 // The cursor wraps without becoming a durable source watermark.
 assert.equal(f.tasks.collectDiscoverySources().recorded,0);assert.equal(f.tasks.collectDiscoverySources().recorded,0);
});
