import assert from 'node:assert/strict';
import {mkdir,readdir,symlink} from 'node:fs/promises';import {join,dirname} from 'node:path';import {pathToFileURL} from 'node:url';
import {prepareDshPreSetupRuntime} from '../../../session-adapter/scripts/prepare-dsh-pre-setup.mjs';
import {captureSessionCheckpoint} from '../../../session-adapter/checkpoint.js';
import {WorkbenchBridge} from '../../../session-adapter/workbench.js';
import {createNativeWorkspaceAdmissionGate} from '../../../session-adapter/native-workspace-factory.js';

/** Synthetic balanced native turn, actual installed Session/Goal/persistence and
 * original Gateway completion receipts. No model or production Session is used. */
export function nativePublicationRuntime(t,runtime){
 let ctx,handle,modules,admissionGate,calls=0,closed=false;
 const close=async()=>{if(closed)return;closed=true;await admissionGate?.dispose();await handle?.dispose();if(ctx)await ctx.fiber.dispose();};t.after(close);
 return{get ctx(){return ctx},get agent(){return handle.agent},get modules(){return modules},get admissionGate(){return admissionGate},get calls(){return calls},close,
  async lifecycle(f){
   const base=join(f.root,'original-native-host'),scoped=join(base,'node_modules','@deepseek-ai');await mkdir(scoped,{recursive:true});
   prepareDshPreSetupRuntime(join(runtime,'dsh-agent-loop'),join(scoped,'dsh-agent-loop'),{nativeAdmission:true,pendingInputWake:true});
   for(const entry of await readdir(runtime,{withFileTypes:true}))if(entry.name!=='dsh-agent-loop'&&entry.isDirectory())await symlink(join(runtime,entry.name),join(scoped,entry.name),'junction');
   await symlink(join(dirname(runtime),'zod'),join(base,'node_modules','zod'),'junction');
   const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal'];modules={};
   for(const name of [...names,'dsh-session-persistence'])modules[name]=await import(pathToFileURL(join(name==='dsh-agent-loop'?scoped:runtime,name,'lib/index.js')).href);
   ctx=new modules.cordis.Context();for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(base,'sessions'),compression:'none'}:{});
   class Local extends modules['dsh-llm'].LlmAdapter{async *stream(){calls++;assert.fail('native publication fixture must not call a model');}}ctx.llm.registerAdapter(['publication-custody'],new Local());
   const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-history-11df6da2',fetchImpl:async(url,init)=>{
    const response=await f.server.app.inject({method:init.method,url:new URL(url).pathname,headers:init.headers,payload:JSON.parse(init.body)});return new Response(response.body,{status:response.statusCode,headers:response.headers});
   }});
   admissionGate=createNativeWorkspaceAdmissionGate({ctx,bridge});
   handle=await ctx.agents.create({sessionId:'work-test-session',meta:{agentPreset:'jot-workbench-budgeted',cwd:f.prepared.snapshot.isolated_root},agentOptions:{provider:'publication-custody',model:'synthetic'}});
   const agent=handle.agent,objective=f.resolver.context(f.admission.run_id,f.lease).objective,goal=ctx.goals.create(agent,{objective,maxGoalRounds:1});
   agent.session.append('turn/start',{turn:1});const end=agent.session.append('turn/end',{turn:1,reason:{kind:'completed'}}),turnEndSeq=typeof end==='number'?end:end.seq;
   const boundary=()=>{const g=ctx.goals.get(agent);return{host_status:'idle',goal:{goal_id:g.id,goal_revision:g.revision,phase:g.phase,activation:g.activation,rounds_started:g.roundsStarted,max_goal_rounds:g.maxGoalRounds}}};
   const snapshot=()=>captureSessionCheckpoint(agent,ctx.sessions,ctx.sessionPersistence,turnEndSeq);
   return{goal_id:goal.id,async pause(){ctx.goals.pause(agent,{id:goal.id,revision:1});return{boundary:boundary(),checkpoint:await snapshot()}},async complete(){ctx.goals.complete(agent,{id:goal.id,revision:2});return{...boundary(),checkpoint:await snapshot()}}};
  }
 };
}
