// Test-only retention override of the installed Work declaration; no child list copy.
import {readOfficialStandard} from '../standard-preset.mjs';
export const name='jot-work-compaction-fixture-preset';
export const inject=['agentPresets','profileContext'];
export async function apply(ctx){
 const original=await readOfficialStandard(ctx);let patched=0;
 function visit(items){for(const item of items){if(item.id==='compaction-basic'){item.config={...item.config,retainTokens:64,headroomTokens:1024,maxTokens:128,compactionRetries:0};delete item.config.retainRatio;patched++;}if(Array.isArray(item.config))visit(item.config);}}
 visit(original.plugins);if(patched!==1)throw Error('fixture_work_compaction_source_changed');
 const remove=await ctx.agentPresets.register({...original,id:'jot-general',name:'Jot Work compaction fixture'});ctx.effect(()=>remove);ctx.provide('jotHostReady',Object.freeze({presetId:'jot-general',presetIds:Object.freeze(['jot-general'])}));
}
