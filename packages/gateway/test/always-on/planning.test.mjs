import test from 'node:test';import assert from 'node:assert/strict';import Fastify from 'fastify';
import {fixture} from './discovery-fixture.mjs';import {registerWorkbenchExecution} from '../../src/workbench/execution.ts';
const Planning=(await import('../../src/always-on/planning.ts').catch(()=>({}))).DiscoveryPlanning;
async function setup(t,before){const f=fixture(t);f.file();if(before)await before(f);await f.controller().admit('owner',f.scope);const occurrence=f.db.prepare('SELECT * FROM wb_task_occurrences').get(),lease=f.coordinator.claimNext('planning-worker',30000);f.coordinator.start(lease);f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(occurrence.conversation_id,'owner','planning-session','now','now');const app=Fastify();app.setErrorHandler((error,request,reply)=>reply.code(409).send({error:error.message}));registerWorkbenchExecution(app,f.db,f.workbench,f.tasks,'test-11df6da2abd14f9b',f.budget.ledger);t.after(()=>app.close());let seq=0;const tool=(operation,args={},call_id='planning-'+(++seq))=>app.inject({method:'POST',url:'/internal/v1/workbench/tool',headers:{authorization:'Bearer test-11df6da2abd14f9b'},payload:{run_id:occurrence.run_id,session_ref:'planning-session',execution_lease:{owner:'planning-worker',generation:lease.generation},operation,arguments:args,call_id}});const identity={run_id:occurrence.run_id,session_ref:'planning-session',execution_lease:{owner:'planning-worker',generation:lease.generation}};const internal=(name,payload)=>app.inject({method:'POST',url:'/internal/v1/workbench/'+name,headers:{authorization:'Bearer test-11df6da2abd14f9b'},payload:{...identity,...payload}});return{...f,occurrence,lease,tool,identity,internal};}
test('structured discovery planning is available',()=>assert.equal(typeof Planning,'function'));
test('original task metadata can be updated while project writes remain forbidden',async t=>{const f=await setup(t),step=await f.tool('tasks.upsert',{title:'Review sources',acceptance:'Cite actual source material',status:'running'});assert.equal(step.statusCode,200,step.body);const write=await f.tool('files.write',{path:'forbidden.md',content:'no',expected_version:0});assert.equal(write.json().error,'discovery_planning_read_only');});
test('context and pinned source reads are scoped, receipted and feed an immutable structured proposal',async t=>{
 const f=await setup(t),context=await f.tool('discovery.context');assert.equal(context.statusCode,200,context.body);assert.equal(context.json().sources.length,1);
 const read=await f.tool('discovery.source',{revision:1});assert.equal(read.statusCode,200,read.body);assert.equal(read.json().text,'PRIVATE fixture');assert.ok(read.json().execution_receipt);
 const args={summary:'Improve source clarity',rationale:'The inspected source can be clarified',changes:[{path:'source.md',description:'Clarify the source',steps:['Review wording'],verification:['Compare the result to the inspected source']}],evidence:[read.json().execution_receipt]};
 const plan=await f.tool('discovery.plan',args,'plan-once');assert.equal(plan.statusCode,200,plan.body);assert.equal(plan.json().accepted,false);const retry=await f.tool('discovery.plan',args,'plan-once');assert.deepEqual(retry.json(),plan.json());assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_plans').get().n,1);
 assert.throws(()=>f.db.exec('DELETE FROM wb_discovery_plans'),/discovery_planning_immutable/);
});
test('a report needs completed original steps and real evidence; recording it does not accept the task',async t=>{
 const f=await setup(t),read=await f.tool('discovery.source',{revision:1}),proof=read.json().execution_receipt;
 const args={outcome:'no_plan',summary:'No supported improvement found',limitations:[],plan_ids:[],evidence:[proof]};
 const early=await f.tool('discovery.report',args);assert.equal(early.json().error,'discovery_report_steps_incomplete');
 const step=await f.tool('tasks.upsert',{title:'Inspect sources',acceptance:'Use actual source material',status:'completed',evidence:[proof]});assert.equal(step.statusCode,200,step.body);
 const report=await f.tool('discovery.report',args);assert.equal(report.statusCode,200,report.body);assert.equal(report.json().accepted,false);assert.equal(f.db.prepare('SELECT business_state FROM wb_task_occurrences').get().business_state,'queued');
 const saved=new Planning(f.db,f.workbench).completion(f.occurrence.run_id);assert.equal(saved.outcome,'no_plan');assert.equal(saved.report_id,report.json().report_id);
});
test('forged evidence and source drift cannot become a plan or report',async t=>{
 const f=await setup(t),bad=await f.tool('discovery.plan',{summary:'Unsupported',rationale:'No actual source',changes:[{path:'source.md',description:'Change',steps:['change'],verification:['check']}],evidence:[{kind:'tool_receipt',reference:'proof-forged',hash:'a'.repeat(64)}]});assert.equal(bad.json().error,'discovery_evidence_required');
 f.workbench.writeFile('owner','ws',{project_id:f.agent.project_id,path:'source.md',content:'Changed',expected_version:1});f.tasks.collectDiscoverySources();const current=await f.tool('discovery.context');assert.equal(current.json().error,'discovery_source_changed');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_plans').get().n,0);
});

test('native completion proposal requires a current discovery report before Goal completion',async t=>{
 const f=await setup(t),read=await f.tool('discovery.source',{revision:1}),proof=read.json().execution_receipt;
 await f.tool('tasks.upsert',{title:'Inspect sources',acceptance:'Cite actual source',status:'completed',evidence:[proof]});
 const goal={goal_id:'planning-goal',goal_revision:1};assert.equal((await f.internal('goal-binding',{...goal,action:'save'})).statusCode,200);
 const response=await f.internal('goal-proposal',{...goal,call_id:'complete-without-report',intent:'complete',summary:'Finished'});
 assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error,'discovery_report_required');
});
test('no-plan reports cannot claim coverage from an unpinned ordinary read alone',async t=>{
 const f=await setup(t),read=await f.tool('files.read',{path:'source.md'}),proof=read.json().execution_receipt;
 await f.tool('tasks.upsert',{title:'Inspect sources',acceptance:'Cite source',status:'completed',evidence:[proof]});
 const report=await f.tool('discovery.report',{outcome:'no_plan',summary:'Nothing to improve',limitations:[],plan_ids:[],evidence:[proof]});
 assert.equal(report.statusCode,409,report.body);assert.equal(report.json().error,'discovery_report_source_coverage_required');
});
test('report proof enters the original native completion candidate rather than a parallel acceptance flow',async t=>{
 const f=await setup(t),read=await f.tool('discovery.source',{revision:1}),proof=read.json().execution_receipt;
 await f.tool('tasks.upsert',{title:'Inspect sources',acceptance:'Use source evidence',status:'completed',evidence:[proof]});
 const report=await f.tool('discovery.report',{outcome:'no_plan',summary:'No supported change',limitations:[],plan_ids:[],evidence:[proof]});assert.equal(report.statusCode,200,report.body);
 const run=f.occurrence.run_id,goal={goal_id:'planning-goal',goal_revision:1};await f.internal('goal-binding',{...goal,action:'save'});
 f.budget.ledger.reserve('owner',run,{attempt_id:'synthetic-spend',provider:'fixture',model:'bounded'});f.budget.ledger.dispatch('owner',run,'synthetic-spend');f.budget.ledger.settle('owner',run,'synthetic-spend',{inputTokens:5,outputTokens:5,totalTokens:10});
 const proposal=await f.internal('goal-proposal',{...goal,call_id:'complete-with-report',intent:'complete',summary:'Review the discovery report'});assert.equal(proposal.statusCode,200,proposal.body);assert.equal(proposal.json().proposal.accepted,true);
 await f.internal('goal-binding',{...goal,goal_revision:2,action:'save'});
 f.coordinator.recordCheckpoint(f.lease,'planning-session',{session_ref:'planning-session',seq_exclusive:3,turn_end_seq:2,goal_id:goal.goal_id,goal_revision:2,log_sha256:'a'.repeat(64)});
 f.coordinator.waitForTask(f.lease,{goal_id:goal.goal_id,goal_revision:2,phase:'paused',turn_end_seq:2},'SESSION_GOAL_WAITING_APPROVAL',{text:'No supported improvement was found in the inspected sources.'});
 const candidate=f.db.prepare('SELECT snapshot_json FROM wb_task_completion_candidates WHERE run_id=?').get(run);assert.ok(candidate);assert.equal(JSON.parse(candidate.snapshot_json).discovery_report.report_id,report.json().report_id);assert.equal(f.db.prepare('SELECT business_state FROM wb_task_occurrences').get().business_state,'waiting_approval');
});

test('long pinned sources require contiguous chunks and retain complete Unicode text',async t=>{
 const content='a'.repeat(32767)+'😀'+'b'.repeat(32770),f=await setup(t,f=>f.workbench.writeFile('owner','ws',{project_id:f.agent.project_id,path:'long.md',content,expected_version:0}));
 const late=await f.tool('discovery.source',{revision:1,offset:32769}),proof=late.json().execution_receipt;
 await f.tool('tasks.upsert',{title:'Inspect sources',acceptance:'Read pinned sources',status:'completed',evidence:[proof]});
 const args={outcome:'no_plan',summary:'No supported changes',limitations:[],plan_ids:[],evidence:[proof]};
 assert.equal((await f.tool('discovery.report',args)).json().error,'discovery_report_source_coverage_required');
 let offset=0,joined='';do{const response=await f.tool('discovery.source',{revision:1,offset});assert.equal(response.statusCode,200,response.body);const result=response.json();assert.ok(!/[\uD800-\uDBFF]$/.test(result.text),'chunk cannot split a surrogate pair');joined+=result.text;offset=result.next_offset;}while(offset!==null);
 assert.equal(joined,content);await f.tool('discovery.source',{revision:2});const report=await f.tool('discovery.report',args);assert.equal(report.statusCode,200,report.body);assert.deepEqual(new Planning(f.db,f.workbench).completion(f.occurrence.run_id).coverage,{signal_count:2,fully_read:2});
});
test('new proposals invalidate an older report instead of hiding them from review',async t=>{
 const f=await setup(t),read=await f.tool('discovery.source',{revision:1}),proof=read.json().execution_receipt;
 await f.tool('tasks.upsert',{title:'Inspect sources',acceptance:'Read source',status:'completed',evidence:[proof]});
 assert.equal((await f.tool('discovery.report',{outcome:'no_plan',summary:'No supported changes',limitations:[],plan_ids:[],evidence:[proof]})).statusCode,200);
 const plan=await f.tool('discovery.plan',{summary:'New improvement',rationale:'Found evidence',changes:[{path:'source.md',description:'Clarify',steps:['Review'],verification:['Compare']}],evidence:[proof]});assert.equal(plan.statusCode,200,plan.body);
 assert.throws(()=>new Planning(f.db,f.workbench).completion(f.occurrence.run_id),/discovery_report_stale/);
});
test('proposal dedup follows normalized work and source hashes rather than call IDs or titles',async t=>{
 const f=await setup(t),first=await f.tool('discovery.source',{revision:1}),second=await f.tool('discovery.source',{revision:1});
 const args={summary:'Clarify source',rationale:'Observed evidence',changes:[{path:'source.md',description:'Clarify wording',steps:['Review wording'],verification:['Compare source']}],evidence:[first.json().execution_receipt]};
 const a=await f.tool('discovery.plan',args,'plan-first'),b=await f.tool('discovery.plan',{...args,summary:'Different title',evidence:[second.json().execution_receipt]},'plan-second');
 assert.equal(a.statusCode,200,a.body);assert.equal(b.statusCode,200,b.body);assert.equal(b.json().plan_id,a.json().plan_id);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_plans').get().n,1);
});
test('reports derive the complete proposal manifest instead of trusting an omitted caller list',async t=>{
 const f=await setup(t),read=await f.tool('discovery.source',{revision:1}),proof=read.json().execution_receipt;
 await f.tool('tasks.upsert',{title:'Inspect sources',acceptance:'Read source',status:'completed',evidence:[proof]});
 const plan=await f.tool('discovery.plan',{summary:'Improve',rationale:'Source supports it',changes:[{path:'source.md',description:'Clarify',steps:['Review'],verification:['Compare']}],evidence:[proof]});
 const report=await f.tool('discovery.report',{outcome:'proposals',summary:'One proposal',limitations:[],plan_ids:[],evidence:[proof]});assert.equal(report.statusCode,200,report.body);
 assert.deepEqual(new Planning(f.db,f.workbench).completion(f.occurrence.run_id).plan_ids,[plan.json().plan_id]);
});
test('owned user text can be read on demand without fetching image blocks',async t=>{
 const f=await setup(t,f=>{const input=f.workbench.enqueueAgentMessage('owner',f.agent.agent_id,{text:'PRIVATE typed source',client_message_id:'source-input'});f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(input.run_id);const row=f.db.prepare('SELECT content_json FROM ga_messages WHERE id=?').get(input.message_id),content=JSON.parse(row.content_json);content.blocks.push({kind:'image',url:'https://fixture.invalid/not-fetched.png'});f.db.prepare('UPDATE ga_messages SET content_json=? WHERE id=?').run(JSON.stringify(content),input.message_id);});
 const read=await f.tool('discovery.source',{revision:1});assert.equal(read.statusCode,200,read.body);assert.equal(read.json().text,'PRIVATE typed source');assert.equal(read.json().images_omitted,true);assert.ok(!JSON.stringify(read.json()).includes('not-fetched'));
});
test('a report manifest can cover more than the bounded explicit-ID input list',async t=>{
 const f=await setup(t),read=await f.tool('discovery.source',{revision:1}),proof=read.json().execution_receipt,p=new Planning(f.db,f.workbench);
 await f.tool('tasks.upsert',{title:'Inspect sources',acceptance:'Read source',status:'completed',evidence:[proof]});
 let last;for(let i=0;i<33;i++)last=p.plan(f.occurrence.run_id,'bulk-plan-'+i,{summary:'Proposal '+i,rationale:'Observed source',changes:[{path:'new-'+i+'.md',description:'Clarify',steps:['Review'],verification:['Compare']}],evidence:[proof]});
 const detail=await f.tool('discovery.context',{plan_id:last.plan_id});assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().plan.summary,'Proposal 32');
 const report=await f.tool('discovery.report',{outcome:'proposals',summary:'Review all proposals',limitations:[],plan_ids:[],evidence:[proof]});assert.equal(report.statusCode,200,report.body);assert.equal(p.completion(f.occurrence.run_id).plan_ids.length,33);
});
