import {mkdir,readdir,symlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createNativeGitHost} from '../../../../session-adapter/native-git-host.js';
import {WorkbenchBridge} from '../../../../session-adapter/workbench.js';
import {createNativeWorkspaceAdmissionGate} from '../../../../session-adapter/native-workspace-factory.js';
import {prepareDshPreSetupRuntime} from '../../../../session-adapter/scripts/prepare-dsh-pre-setup.mjs';
let host,ctx,admission,handle,stopping=false,pauseNext=false,resume;
const stop=async()=>{if(stopping)return;stopping=true;resume?.();await host?.dispose();await handle?.dispose();await admission?.dispose();await ctx?.fiber.dispose();process.disconnect?.();};
process.on('message',async message=>{
 if(message.type==='pause-next'){pauseNext=true;process.send({type:'pause-armed'});return;}
 if(message.type==='continue'){resume?.();return;}
 if(message.type==='stop'){await stop();return;}
 if(message.type!=='start')return;
 try{
  const config=message.config,scoped=join(config.privateRoot,'native','node_modules','@deepseek-ai'),runtime=config.runtime;
  await mkdir(scoped,{recursive:true});prepareDshPreSetupRuntime(join(runtime,'dsh-agent-loop'),join(scoped,'dsh-agent-loop'),{nativeAdmission:true,pendingInputWake:true});
  for(const entry of await readdir(runtime,{withFileTypes:true}))if(entry.name!=='dsh-agent-loop'&&entry.isDirectory())await symlink(join(runtime,entry.name),join(scoped,entry.name),'junction');
  await symlink(join(dirname(runtime),'zod'),join(config.privateRoot,'native','node_modules','zod'),'junction');
  const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal'],modules={};
  for(const name of names)modules[name]=await import(pathToFileURL(join(name==='dsh-agent-loop'?scoped:runtime,name,'lib/index.js')).href);
  ctx=new modules.cordis.Context();ctx.provide('profileContext',{installAnchor:join(config.privateRoot,'native','package.json')});
  for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(config.privateRoot,'sessions'),compression:'none'}:{});
  let modelCalls=0;class Local extends modules['dsh-llm'].LlmAdapter{async *stream(){modelCalls++;throw Error('synthetic_git_fixture_must_not_call_model');}}
  ctx.llm.registerAdapter(['synthetic-git'],new Local());
  const bridge=new WorkbenchBridge({origin:config.origin,token:config.channelToken});admission=createNativeWorkspaceAdmissionGate({ctx,bridge});
  handle=await ctx.agents.create({sessionId:'ipc-native-session',meta:{cwd:config.root,agentPreset:'jot-general'},agentOptions:{provider:'synthetic-git',model:'synthetic'}});
  // This fixture-only pause observes a real kernel preparation. It is not a
  // product option, model instruction or IPC endpoint in the shipped Host.
  const {GitIndexEffects}=await import('../../../dist/src/git/index-effects.js'),prepare=GitIndexEffects.prototype.prepareIndex;
  GitIndexEffects.prototype.prepareIndex=async function(...args){const result=await prepare.apply(this,args);if(pauseNext){pauseNext=false;await new Promise(done=>{resume=done;process.send({type:'prepared'});});resume=undefined;}return result;};
  process.env.JOT_NATIVE_GIT_TEST_TOKEN=config.transportToken;
  host=await createNativeGitHost({ctx,bridge,admissionGate:admission,allowedPresets:new Set(['jot-general']),config:{databasePath:config.database,repositories:[{owner_id:'owner',project_id:'project',root:config.root}],socket:config.socket,tokenEnv:'JOT_NATIVE_GIT_TEST_TOKEN'}});
  process.send({type:'ready',modelCalls});
 }catch(error){process.send?.({type:'failed',code:'native_git_peer_failed',diagnostic:String(error?.message).slice(0,160)});await stop();process.exitCode=1;}
});
