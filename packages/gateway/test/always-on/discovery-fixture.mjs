import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {openProductDatabase} from '../../src/db/database.ts';import {EventStore} from '../../src/events/event-store.ts';import {RunRepository} from '../../src/runs/repository.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';import {WorkbenchBudgetPolicy} from '../../src/workbench/model-budget-policy.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {DiscoveryPolicies} from '../../src/always-on/discovery-policy.ts';import {ProjectActivityObserver} from '../../src/always-on/project-activity.ts';


import {DiscoveryAdmissionController as Controller} from '../../src/always-on/admission.ts';
export function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jot-discovery-admission-')),db=openProductDatabase(join(root,'db.sqlite')),events=new EventStore(db),runs=new RunRepository(db,events);
 const limits={tokens:5000,nano_usd:50000,model_calls:50},route={provider:'fixture',model:'bounded',revision:'rates-1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}};
 const budget=new WorkbenchBudgetPolicy(db,{revision:1,admission_route:{provider:'fixture',model:'bounded'},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(k=>[k,{...limits}]))});
 const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'workspace'),modelBudgetPolicy:budget}),tasks=new PersistentTaskService(db,workbench,{modelBudgetPolicy:budget});
 const policies=new DiscoveryPolicies(db,{onChange:(owner,receipt,event)=>tasks.synchronizeDiscoveryPolicy(owner,receipt.policy_id,event)}),agent=workbench.createAgent('owner',{name:'Synthetic discovery'}),scope={project_id:agent.project_id,workspace_id:'ws',agent_id:agent.agent_id};
 workbench.projectRoot('owner','ws',agent.project_id);db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(agent.conversation_id,'owner','synthetic-session','now','now');
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 policies.save('owner',scope,{expected_version:0,expected_role_version:1,expected_role_epoch:1,mode:'discover_only',cooldown_ms:0,recent_input_ms:0,max_cycles:null},'save');const enabled=policies.control('owner',scope,{action:'enable',expected_version:1,expected_role_version:1,expected_role_epoch:1},'enable');
 const coordinator=new HarnessCoordinator(db,runs,events),native={nativeIdleObservationReadiness:async()=>({protocol:1,ready:true,execution_authorized:false}),observeNativeIdle:async id=>({protocol:1,session_id:id,basis:'live',native_idle:'idle',reason:null,observed_at:Date.now(),execution_authorized:false})};
 const activity=new ProjectActivityObserver({db,workbench,native,maxAgeMs:5000}),controller=(extra={})=>new Controller({db,workbench,tasks,policies,coordinator,activity,budgetPolicy:budget,maxAgeMs:5000,...extra});
 const file=()=>workbench.writeFile('owner','ws',{project_id:agent.project_id,path:'source.md',content:'PRIVATE fixture',expected_version:0});
 return{db,workbench,tasks,policies,scope,enabled,agent,native,controller,file,coordinator,budget,runs,events,root};
}
