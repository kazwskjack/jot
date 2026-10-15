import test from 'node:test';
import assert from 'node:assert/strict';
import {consolidationCommand,consolidationMatches,consolidationPreview} from './memory-consolidation.mjs';
const batch={consolidation_id:'stage-a',project_id:'project-a',scope:'private',agent_id:'agent-a',version:2,status:'proposed',sources:[{memory_id:'a',content:'Before',version:1},{memory_id:'b',content:'Repeated',version:1}],proposal:{changes:[{action:'rewrite',memory_id:'a',content:'After'},{action:'supersede',memory_id:'b',replacement_id:'a'}]}};
test('only the reviewed state can produce an explicit apply, reject or rollback command',()=>{
 assert.deepEqual(consolidationCommand(batch,'apply'),{expected_version:2});assert.deepEqual(consolidationCommand(batch,'reject'),{expected_version:2});
 for(const status of ['draft','applied','rolled_back','rejected'])assert.throws(()=>consolidationCommand({...batch,status},'apply'));
 assert.deepEqual(consolidationCommand({...batch,status:'applied',version:3},'rollback'),{expected_version:3});
 for(const action of ['propose','delete','stop'])assert.throws(()=>consolidationCommand(batch,action));
});
test('scope switches cannot display a prior private-role or project proposal',()=>{
 const selection={project_id:'project-a',scope:'private',agent_id:'agent-a'};assert.equal(consolidationMatches(batch,selection),true);
 for(const change of [{agent_id:'agent-b'},{project_id:'project-b'},{scope:'project'}])assert.equal(consolidationMatches(batch,{...selection,...change}),false);
});
test('preview shows frozen before, actual rewrite and the retained replacement source',()=>{
 const items=consolidationPreview(batch);assert.equal(items[0].before,'Before');assert.equal(items[0].after,'After');assert.equal(items[1].before,'Repeated');assert.equal(items[1].replacement_id,'a');assert.equal(items[1].replacement_content,'After');
 assert.throws(()=>consolidationPreview({...batch,proposal:{changes:[{action:'rewrite',memory_id:'foreign',content:'Forged'}]}}));
});
