// Test-only assembly proof. Production readiness remains disabled until the
// context, turn allowance and post-answer compaction contracts are implemented.
import {readFile,writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {apply as applyAdapter,inject as adapterInject} from '../../session-adapter/index.js';
import {createOrdinaryInputAdmissions} from '../../session-adapter/ordinary-input-admissions.js';
import {createNativeReplayProfile} from '../../session-adapter/native-replay-profile.js';
export const name='jot-chat-native-fixture';
export const inject=[...adapterInject,'jotChatPresetReady','agentPresets','tools'];
export async function apply(ctx,config){
 const {chatFixture,...adapterConfig}=config,require=createRequire(ctx.get('profileContext').installAnchor);
 const {scopeOf}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')).href);
 const artifacts=await Promise.all(['chat-preset.mjs','chat-tools-policy.mjs'].map(async name=>{const path=fileURLToPath(new URL('../'+name,import.meta.url));return{id:name.replaceAll('.','-'),path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')};}));
 const facts=agent=>({preset:ctx.agentPresets.composedPreset(agent.ctx),tools:ctx.tools.schemas(scopeOf(agent.ctx)).map(tool=>tool.name).sort(),
  mounted:ctx.agentPresets.inspectCompositions(agent.ctx).some(row=>row.id==='jot-chat'&&row.modules.length>0&&row.leakedServices.length===0)});
 const profile=createNativeReplayProfile({id:'actual-chat-fixture',presetId:'jot-chat',auditId:'local-chat-fixture',
  artifacts,
  verifyComposition:async({agent})=>{const actual=facts(agent);return{verified:ctx.agents.get(agent.id)===agent&&actual.preset==='jot-chat'&&actual.mounted&&JSON.stringify(actual.tools)===JSON.stringify(['web_fetch','web_search'])};}});
 ctx.on('agent/created',async({agent})=>{if(agent.session.header.agentPreset==='jot-chat')await writeFile(chatFixture.receipt,JSON.stringify(facts(agent)));});
 const history={contexts:[],user_rpcs:[],replace_generation:0};
 if(chatFixture.history)ctx.on('session/event',(session,event)=>{if(session.header.agentPreset!=='jot-chat')return;if(event.type==='user/message'){const source=event.data.source;if(source.kind==='jot-chat-context')history.contexts.push({message_id:event.data.id,run_id:source.run_id,context_sha256:source.context_sha256});if(source.kind==='user')history.user_rpcs.push(source.rpcId);}history.replace_generation=session.surface.replaceGeneration;writeFileSync(chatFixture.history,JSON.stringify(history));});
 return applyAdapter(ctx,{...adapterConfig,ordinaryModelSelection:true,ordinaryInputAdmission:{admissions:createOrdinaryInputAdmissions({root:chatFixture.admissions}),profile}});
}
