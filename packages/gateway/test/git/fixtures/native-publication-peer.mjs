import {mkdir,readdir,symlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createNativeGitHost} from '../../../../session-adapter/native-git-host.js';
import {WorkbenchBridge} from '../../../../session-adapter/workbench.js';
import {createNativeWorkspaceAdmissionGate} from '../../../../session-adapter/native-workspace-factory.js';
import {prepareDshPreSetupRuntime} from '../../../../session-adapter/scripts/prepare-dsh-pre-setup.mjs';

let ctx,modules,admission,host,calls=0,pauseNext=false,resume,exitAfterApplied=false,stopping=false;
const send=(type,value={})=>process.send?.({type,...value});
const stop=async()=>{if(stopping)return;stopping=true;resume?.();await host?.dispose();await admission?.dispose();await ctx?.fiber.dispose();process.disconnect?.();};

async function initialize(config){
 const install=join(config.privateRoot,'peer-runtime-'+randomUUID()),scoped=join(install,'node_modules','@deepseek-ai'),runtime=config.runtime;await mkdir(scoped,{recursive:true});
 prepareDshPreSetupRuntime(join(runtime,'dsh-agent-loop'),join(scoped,'dsh-agent-loop'),{nativeAdmission:true,pendingInputWake:true});
 for(const entry of await readdir(runtime,{withFileTypes:true}))if(entry.name!=='dsh-agent-loop'&&entry.isDirectory())await symlink(join(runtime,entry.name),join(scoped,entry.name),'junction');
 await symlink(join(dirname(runtime),'zod'),join(install,'node_modules','zod'),'junction');
 const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal'];modules={};
 for(const name of names)modules[name]=await import(pathToFileURL(join(name==='dsh-agent-loop'?scoped:runtime,name,'lib/index.js')).href);
 ctx=new modules.cordis.Context();ctx.provide('profileContext',{installAnchor:join(install,'package.json')});
 for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:config.persistenceRoot,compression:'none'}:{});
 class Local extends modules['dsh-llm'].LlmAdapter{async *stream(){calls++;throw Error('synthetic_publication_peer_must_not_call_model')}}ctx.llm.registerAdapter(['publication-wire'],new Local());
 const bridge=new WorkbenchBridge({origin:config.origin,token:config.channelToken});admission=createNativeWorkspaceAdmissionGate({ctx,bridge});
 // Reopen the exact persistence left by the original completed native Host.
 // No replacement Agent, task, Goal or model turn is constructed here.
 send('initialized',{modelCalls:calls});
}

process.on('message',async message=>{
 try{
  if(message.type==='initialize'){await initialize(message.config);return;}
  if(message.type==='pause-next'){pauseNext=true;send('pause-armed');return;}
  if(message.type==='continue'){resume?.();return;}
  if(message.type==='exit-after-apply'){exitAfterApplied=true;send('exit-armed');return;}
  if(message.type==='status'){send('status',{modelCalls:calls});return;}
  if(message.type==='stop'){await stop();return;}
  if(message.type!=='mount')return;
  const config=message.config,{GitPublicationEffects}=await import('../../../dist/src/git/publication-effects.js'),prepare=GitPublicationEffects.prototype.preparePublication,apply=GitPublicationEffects.prototype.applyPublication;
  // Faults belong only to this synthetic peer. The shipped Host exposes no
  // pause, process-exit, module selector or arbitrary execution endpoint.
  GitPublicationEffects.prototype.preparePublication=async function(...args){const result=await prepare.apply(this,args);if(pauseNext){pauseNext=false;await new Promise(done=>{resume=done;send('prepared')});resume=undefined;}return result;};
  GitPublicationEffects.prototype.applyPublication=async function(...args){const result=await apply.apply(this,args);if(exitAfterApplied)process.exit(73);return result;};
  process.env.JOT_NATIVE_PUBLICATION_TEST_TOKEN=config.transportToken;
  host=await createNativeGitHost({ctx,bridge:new WorkbenchBridge({origin:config.origin,token:config.channelToken}),admissionGate:admission,allowedPresets:new Set(['jot-workbench-budgeted']),config:{databasePath:config.database,repositories:[{owner_id:'owner',project_id:config.project,root:config.root}],socket:config.socket,tokenEnv:'JOT_NATIVE_PUBLICATION_TEST_TOKEN'}});
  send('mounted',{modelCalls:calls});
 }catch(error){send('failed',{diagnostic:String(error?.message).slice(0,160)});await stop();process.exitCode=1;}
});
