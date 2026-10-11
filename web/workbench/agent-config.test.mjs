import test from 'node:test';
import assert from 'node:assert/strict';
import * as config from './agent-config.mjs';
const agent={name:'Reader',instructions:'Read verified sources',allowed_tools:['read'],workspace_id:'shared',project_id:'owned-project',agent_id:'original',conversation_id:'old-chat',owner_id:'private-owner',version:9,capability_epoch:4,status:'disabled',private_memory:'secret note',credential:'not exported'};
test('copy prepares a new editable role in the owned project without inheriting identity, authority or memories',()=>{
 const value=config.copyAgentConfig(agent);assert.deepEqual(value,{name:'Reader 副本',instructions:'Read verified sources',allowed_tools:['read'],workspace_id:'shared',project_id:'owned-project'});
 value.allowed_tools.push('other');assert.deepEqual(agent.allowed_tools,['read']);assert.equal(config.copyAgentConfig({...agent,name:'x'.repeat(100)}).name.length,100);
});
test('portable configuration export explicitly includes only role instructions and requested tools',()=>{
 assert.deepEqual(config.exportAgentConfig(agent),{format:'jot-agent-config',version:1,role:{name:'Reader',instructions:'Read verified sources',allowed_tools:['read']}});
});
test('status mutation requires a confirmed active or disabled role and its exact version',()=>{
 assert.deepEqual(config.agentStatusInput(agent),{expected_version:9,status:'active'});
 assert.deepEqual(config.agentStatusInput({...agent,status:'active'}),{expected_version:9,status:'disabled'});
 for(const value of [{...agent,status:'deleting'},{...agent,version:0},{...agent,version:1.1}])assert.throws(()=>config.agentStatusInput(value));
});
