// Test-only observer of real services. It neither supplies nor replaces them.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
export const name='jot-host-inspection';
export const inject=['jotHostReady','agentPresets','sessionController','permissionPresets','sandboxPolicy','approval','tools'];
export async function apply(ctx,{receipt,sessionPrefix}){
 const require=createRequire(ctx.get('profileContext').installAnchor);
 const {scopeOf}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')).href);
 const matches=id=>id==='host-canary'||typeof sessionPrefix==='string'&&id.startsWith(sessionPrefix);
 const sessions=existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')).sessions??{}:{};
 const sessionRecord=id=>sessions[id]??(sessions[id]={events:[],goals:[]});
 let facts,events=[];const save=()=>writeFileSync(receipt,JSON.stringify({...facts,events,sessions}));
 ctx.on('session/event',(session,event)=>{if(!matches(session.id))return;const reduced={seq:event.seq,type:event.type,...(event.data?.reason?{reason:event.data.reason}:{}),...(event.type==='goal/change'&&Number.isSafeInteger(event.data?.roundsStarted)?{goalRound:event.data.roundsStarted}:{}),...(event.type==='user/message'&&event.data?.source?.rpcId?{sourceRpcId:event.data.source.rpcId}:{})};events.push(reduced);sessionRecord(session.id).events.push(reduced);save();});
 ctx.on('goal/changed',({agent,change})=>{if(!matches(agent.id))return;const record=sessionRecord(agent.id),goal=agent.ctx.get('goals').get(agent);record.goals.push({operation:change.operation,goal:goal?JSON.parse(JSON.stringify(goal)):null});save();});
 ctx.on('agent/created',({agent})=>{
  if(!matches(agent.id))return;
  facts={sessionId:agent.id,header:JSON.parse(JSON.stringify(agent.session.header)),
   preset:ctx.agentPresets.composedPreset(agent.ctx),mounted:ctx.agentPresets.inspectCompositions(agent.ctx).some(composition=>composition.id===ctx.agentPresets.composedPreset(agent.ctx)&&composition.modules.length>0&&composition.leakedServices.length===0),
   permission:ctx.permissionPresets.current(agent.session),sandbox:ctx.sandboxPolicy.resolve({session:agent.session}),
   approval:ctx.approval.overrideOf(agent.session)??ctx.approval.config.policy??'ask',
   model:ctx.sessionController.agents.selectionFor(agent).current,
   tools:ctx.tools.schemas(scopeOf(agent.ctx)).map(tool=>tool.name).sort(),
  };Object.assign(sessionRecord(agent.id),facts);save();
 });
 ctx.provide('jotHostInspectionReady',true);
}
