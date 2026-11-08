import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryDreamTools} from '../../src/workbench/memory-dream-tools.ts';

const identity={owner_id:'alice',workspace_id:'ws-1',project_id:'project-1',agent_id:'agent-1',policy_version:4,epoch:9,cadence_slot:'2026-10-22T10:00:00.000Z'};
const source={memory_id:'memory-1',owner_id:'alice',workspace_id:'ws-1',project_id:'project-1',scope:'project',agent_id:null,version:2,source_revision:'rev-2',content:'Synthetic project fact'};
const consolidation={consolidation_id:'consolidation-1',owner_id:'alice',workspace_id:'ws-1',project_id:'project-1',scope:'project',agent_id:null,run_id:'run-1',status:'draft',version:1};

function fixture(overrides={}){
 const calls=[];
 const ports={
  list:async(scope,input)=>{calls.push(['list',scope,input]);return [source];},
  stage:async(scope,runId,input)=>{calls.push(['stage',scope,runId,input]);return consolidation;},
  propose:async(scope,runId,id,input)=>{calls.push(['propose',scope,runId,id,input]);return {...consolidation,consolidation_id:id,status:'proposed',version:2};},
  ...overrides,
 };
 let checks=0;
 const tools=createMemoryDreamTools(identity,'run-1',ports,()=>{checks++;});
 return {tools,calls,checks:()=>checks};
}

test('Dream exposes only project list, stage, and propose bound to the original run',async()=>{
 const f=fixture();
 assert.deepEqual(Object.keys(f.tools).sort(),['list','propose','stage']);
 assert.deepEqual(await f.tools.list({q:'design'}),[source]);
 const staged=await f.tools.stage({memory_ids:['memory-1']});
 const proposed=await f.tools.propose(staged.consolidation_id,{expected_version:1,summary:'Synthetic proposal',changes:[]});
 assert.equal(proposed.status,'proposed');
 assert.deepEqual(f.calls.map(([name])=>name),['list','stage','propose']);
 assert.equal(f.calls[0][1].scope,'project');
 assert.equal(f.calls[0][1].agent_id,null);
 assert.equal(f.calls[1][2],'run-1');
 assert.deepEqual(f.calls[1][3],{memory_ids:['memory-1']});
 assert.equal(f.calls[2][2],'run-1');
 assert.equal(f.checks(),6);
});

test('Dream rejects caller-selected private scope and extra authority fields before reaching memory ports',async()=>{
 const f=fixture();
 await assert.rejects(f.tools.list({q:'secret',scope:'private',agent_id:'agent-1'}),/memory_dream_tool_forbidden/);
 await assert.rejects(f.tools.stage({scope:'private',memory_ids:['memory-1']}),/memory_dream_tool_forbidden/);
 await assert.rejects(f.tools.propose('consolidation-1',{owner_id:'alice',expected_version:1,summary:'No',changes:[]}),/memory_dream_tool_forbidden/);
 assert.deepEqual(f.calls,[]);
});

test('Dream refuses project list results carrying private or cross-project provenance',async()=>{
 for(const invalid of [
  {...source,scope:'private',agent_id:'agent-1'},
  {...source,project_id:'project-2'},
  {...source,owner_id:'bob'},
  {...source,workspace_id:'ws-2'},
 ]){
  const f=fixture({list:async()=>[invalid]});
  await assert.rejects(f.tools.list(),/memory_dream_source_forbidden/);
 }
});

test('Dream stops before a tool operation when its policy epoch is stale',async()=>{
 let calls=0;
 const tools=createMemoryDreamTools(identity,'run-1',{
  list:async()=>{calls++;return [source];},stage:async()=>{calls++;return consolidation;},propose:async()=>{calls++;return consolidation;},
 },()=>{throw new Error('memory_dream_policy_stale');});
 await assert.rejects(tools.list(),/memory_dream_policy_stale/);
 assert.equal(calls,0);
});
