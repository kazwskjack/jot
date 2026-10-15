// Test-only observer of real services. It neither supplies nor replaces them.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {writeFileSync} from 'node:fs';
export const name='jot-host-inspection';
export const inject=['jotHostReady','agentPresets','sessionController','permissionPresets','sandboxPolicy','approval','tools'];
export async function apply(ctx,{receipt}){
 const require=createRequire(ctx.get('profileContext').installAnchor);
 const {scopeOf}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')).href);
 const {standingMountFor}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent-preset-registry')).href);
 ctx.on('agent/created',({agent})=>{
  if(agent.id!=='host-canary')return;
  writeFileSync(receipt,JSON.stringify({
   preset:ctx.agentPresets.composedPreset(agent.ctx),mounted:!!standingMountFor(agent.ctx),
   permission:ctx.permissionPresets.current(agent.session),sandbox:ctx.sandboxPolicy.resolve({session:agent.session}),
   approval:ctx.approval.overrideOf(agent.session)??ctx.approval.config.policy??'ask',
   model:ctx.sessionController.agents.selectionFor(agent).current,
   tools:ctx.tools.schemas(scopeOf(agent.ctx)).map(tool=>tool.name).sort(),
  }));
 });
 ctx.provide('jotHostInspectionReady',true);
}
