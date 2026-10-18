import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChatPreset} from '../chat-preset.mjs';
import {apply as installToolPolicy} from '../chat-tools-policy.mjs';
test('Chat derives only official persona/web modules and retains an unchanged Work declaration',()=>{
 const original={id:'standard',plugins:[{id:'persona',name:'@deepseek-ai/dsh-persona',config:{prefix:'Work'}},{id:'tool-web',name:'@deepseek-ai/dsh-tool-web',config:{fetch:true}},{id:'tool-fs',name:'@deepseek-ai/dsh-tool-fs'},{id:'compaction',name:'cordis:group',config:[{id:'compact',name:'@deepseek-ai/dsh-compaction-basic'}]}]},before=structuredClone(original);
 const chat=buildChatPreset(original);assert.deepEqual(original,before);assert.equal(chat.id,'jot-chat');
 assert.deepEqual(chat.plugins.map(item=>item.id),['persona','tool-web','chat-tools-policy']);assert.match(chat.plugins[0].config.prefix,/solution/i);
 assert.doesNotMatch(chat.plugins[0].config.prefix,/\{\{model\}\}|\d{4}-\d\d-\d\d/);
 assert.equal(chat.plugins[1].config.search,true);assert.equal(chat.plugins[1].config.fetch,true);
 assert.equal(chat.plugins[1].config.searchTimeoutMs,10000);assert.equal(chat.plugins[1].config.fetchTimeoutMs,10000);
 assert.equal(chat.plugins[1].config.fetchMaxOutputChars,24000);
});
test('missing, duplicate or changed official module identity refuses Chat instead of copying an unknown capability',()=>{
 const good={id:'standard',plugins:[{id:'persona',name:'@deepseek-ai/dsh-persona'},{id:'tool-web',name:'@deepseek-ai/dsh-tool-web'}]};
 for(const value of [null,{}, {...good,id:'other'},{...good,plugins:good.plugins.slice(0,1)},{...good,plugins:[...good.plugins,good.plugins[1]]},{...good,plugins:[good.plugins[0],{id:'tool-web',name:'unreviewed'}]}])assert.throws(()=>buildChatPreset(value),/jot_chat_preset_source_invalid/);
});

test('scoped Chat presentation and monotonic execution guard reject Work and late-added tools',()=>{
 let guard;const calls=[];installToolPolicy({tools:{restrict:filter=>calls.push(['restrict',filter]),presentAs:mode=>calls.push(['mode',mode]),guard:fn=>{guard=fn;}}});
 assert.deepEqual(calls,[['restrict',{deny:['working_directory']}],['mode','native']]);
 for(const name of ['web_search','web_fetch'])assert.equal(guard({name}),undefined);
 for(const name of ['working_directory','write','edit','bash','run_code','subagent','late-added-tool'])assert.equal(guard({name}),'CHAT_READ_ONLY_TOOLS_ONLY');
});
