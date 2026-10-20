import {publicationNativeHostFixture} from '../../support/publication-native-host-fixture.mjs';
import {join} from 'node:path';
const phase=process.env.JOT_PUBLICATION_CRASH_PHASE;
if(!['before','after'].includes(phase))throw Error('synthetic_crash_phase_invalid');
try{
 const f=await publicationNativeHostFixture({after(){}}),kernel=f.workbench.indexEffects('owner',f.scope.project_id),apply=kernel.applyPublication.bind(kernel);
 await new Promise((resolve,reject)=>process.send({type:'ready',root:f.root,database:join(f.root,'db.sqlite'),target:f.rootTarget,project_id:f.scope.project_id,execution_id:f.accepted.execution_id,base:f.base},error=>error?reject(error):resolve()));
 kernel.applyPublication=(plan,authority,signal)=>apply(plan,{...authority,apply(step,operation){
  if(step.phase!=='publish')return authority.apply(step,operation);
  return authority.apply(step,()=>{if(phase==='before')process.exit(73);operation();process.exit(73);});
 }},signal);
 await f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id);
 throw Error('synthetic_crash_was_not_reached');
}catch(error){process.send?.({type:'error',message:error.message});process.exitCode=1;process.disconnect?.();}
