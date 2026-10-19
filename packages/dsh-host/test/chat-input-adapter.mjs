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
import {createNativeInvariantReplay} from '../../session-adapter/native-invariant-replay.js';
import {installChatCompactionProbe} from './chat-compaction-probe.mjs';
import {installChatAccountingProbe} from './chat-accounting-probe.mjs';
export const name='jot-chat-native-fixture';
export const inject=[...adapterInject,'jotChatPresetReady','agentPresets','tools','web','tokenMeter'];
export async function apply(ctx,config){
 const {chatFixture,...adapterConfig}=config,require=createRequire(ctx.get('profileContext').installAnchor);
 if(chatFixture.webReceipt){
  const receipt={search:[],fetch:[],active:0,peak:0,events:[]},save=()=>writeFileSync(chatFixture.webReceipt,JSON.stringify(receipt));save();
  ctx.on('session/event',(session,event)=>{if(session.header.agentPreset!=='jot-chat')return;if(['user/message','assistant/message','tool/call','tool/result'].includes(event.type)){receipt.events.push({seq:event.seq,type:event.type,keys:Object.keys(event.data),turn:event.data.turn,step:event.data.step,source:event.data.source,call:event.data.callId,result:event.type==='tool/result'?event.data.message.content:undefined});save();}});
  const run=async(kind,value,signal,body)=>{signal.throwIfAborted();receipt[kind].push(value);receipt.active++;receipt.peak=Math.max(receipt.peak,receipt.active);save();try{await new Promise(done=>setTimeout(done,40));signal.throwIfAborted();return body();}finally{receipt.active--;save();}};
  ctx.web.registerSearchProvider({id:'jot-web-fixture',available:()=>true,search:async(request,signal)=>run('search',request.query,signal,()=>({sources:[{url:'https://example.com/source',title:'Synthetic fixture',snippet:'Synthetic source text.'}],truncated:false}))});
  ctx.web.registerFetchProvider({id:'jot-web-fixture',available:()=>true,fetch:async(request,signal)=>run('fetch',request.url,signal,()=>{if(request.url.includes('/failed'))throw Error('synthetic fetch failure');return{url:request.url,statusCode:200,body:{kind:'text',content:'Synthetic page text.'},truncated:false};})});
 }
 const {scopeOf}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')).href);
 const artifacts=await Promise.all(['chat-preset.mjs','chat-tools-policy.mjs',...(chatFixture.compaction?['chat-compaction.mjs','chat-maintenance-runtime.mjs','../session-adapter/chat-compaction-engine.js','../session-adapter/chat-compaction-runtime.js','../session-adapter/chat-compaction-manager.js','../session-adapter/chat-compaction-checkpoint.js']:[]),...(chatFixture.recovery?['../session-adapter/chat-checkpoint-recovery.js']:[]),...(chatFixture.automaticReceipt?['../session-adapter/chat-post-answer.js']:[])].map(async name=>{const path=fileURLToPath(new URL('../'+name,import.meta.url));return{id:'artifact-'+name.replaceAll(/[^A-Za-z0-9-]/g,'-'),path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')};}));
 const facts=agent=>({preset:ctx.agentPresets.composedPreset(agent.ctx),tools:ctx.tools.schemas(scopeOf(agent.ctx)).map(tool=>tool.name).sort(),
  mounted:ctx.agentPresets.inspectCompositions(agent.ctx).some(row=>row.id==='jot-chat'&&row.modules.length>0&&row.leakedServices.length===0)});
 const profile=createNativeReplayProfile({id:'actual-chat-fixture',presetId:'jot-chat',auditId:'local-chat-fixture',
  artifacts,
  verifyComposition:async({agent})=>{const actual=facts(agent);return{verified:ctx.agents.get(agent.id)===agent&&actual.preset==='jot-chat'&&actual.mounted&&JSON.stringify(actual.tools)===JSON.stringify(['web_fetch','web_search'])};}});
 ctx.on('agent/created',async({agent})=>{if(agent.session.header.agentPreset==='jot-chat')await writeFile(chatFixture.receipt,JSON.stringify(facts(agent)));});
 const history={contexts:[],user_rpcs:[],replace_generation:0};
 if(chatFixture.history)ctx.on('session/event',(session,event)=>{if(session.header.agentPreset!=='jot-chat')return;if(event.type==='user/message'){const source=event.data.source;if(source.kind==='jot-chat-context')history.contexts.push({message_id:event.data.id,run_id:source.run_id,context_sha256:source.context_sha256});if(source.kind==='user')history.user_rpcs.push(source.rpcId);}history.replace_generation=session.surface.replaceGeneration;writeFileSync(chatFixture.history,JSON.stringify(history));});
 const admissions=createOrdinaryInputAdmissions({root:chatFixture.admissions});let maintenance={};if(chatFixture.maintenance){const {Session}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href);maintenance={ordinaryRunHistory:{Session,validateLog:createNativeInvariantReplay({Session})},ordinaryChatMaintenanceObservation:{thresholdRatio:.8,headroomTokens:1000}};}
 if(chatFixture.accounting)installChatAccountingProbe(ctx,{requestPath:chatFixture.accounting.request,receiptPath:chatFixture.accounting.receipt,origin:adapterConfig.workbenchOrigin,admissions,kit:maintenance.ordinaryRunHistory});
 const applied=await applyAdapter(ctx,{...adapterConfig,...maintenance,...(chatFixture.compaction?{ordinaryChatCompaction:true}:{}),...(chatFixture.recovery?{ordinaryChatCompactionRecovery:true}:{}),...(chatFixture.automaticReceipt?{ordinaryChatCompactionAuto:true}:{}),ordinaryModelSelection:true,ordinaryInputAdmission:{admissions,profile}});
 if(chatFixture.automaticReceipt){const records=[];ctx.on('jot/chat-post-answer-settled',value=>{records.push(value);writeFileSync(chatFixture.automaticReceipt,JSON.stringify(records));});}
 if(chatFixture.compaction)installChatCompactionProbe(ctx,chatFixture.compaction);
 return applied;
}
