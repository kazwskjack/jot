import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

/** Prepare an unused official DSH profile. No install, launch, credential read or SDK patch. */
export async function createHostProfile({home,name='jot',adapter=fileURLToPath(new URL('../session-adapter/index.js',import.meta.url))}){
 if(typeof home!=='string'||!isAbsolute(home)||typeof name!=='string'||!/^[a-z][a-z0-9-]{0,47}$/.test(name)||name==='desktop'||typeof adapter!=='string'||!isAbsolute(adapter))throw Error('host_profile_config_invalid');
 if(!(await stat(adapter)).isFile())throw Error('host_profile_adapter_invalid');
 const preset=fileURLToPath(new URL('./standard-preset.mjs',import.meta.url));
 const patch=[
  {id:'session-log-deepseek',disabled:true},
  {id:'session-telemetry-otel',disabled:true},
  {id:'session-title-llm',disabled:true},
  {id:'hmr',disabled:true},
  {id:'session-controller',config:{nativeOpen:false}},
  {id:'sandbox-policy',config:{mode:'workspace-write'}},
  {id:'approval',config:{policy:'ask'}},
  {id:'agent-preset-registry',config:{default:'jot-general'}},
  {insert:[
   {id:'preset-jot-general',name:pathToFileURL(preset).href},
   {id:'jot-session-adapter',name:pathToFileURL(adapter).href,inject:['jotHostReady'],config:{host:'127.0.0.1',port:18841,tokenEnv:'JOT_SESSION_ADAPTER_TOKEN',workbenchTokenEnv:'GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN',workbenchOrigin:'http://127.0.0.1:18831',nativeContinuation:false,nativeRoles:false,webBudgetEnabled:false,voiceEnabled:false}},
  ]},
 ];
 // Preserve the official lazy expression. JSON is valid YAML; this one value
 // must remain a Loader expression, never a stale preparation-time directory.
 const yaml=JSON.stringify(patch,null,2).replace('"mode": "workspace-write"','"mode": "workspace-write",\n      "workspaceRoot": !!js process.cwd()')+'\n';
 const manifest={name:'jot-dsh-host-profile',version:'0.1.0',private:true,type:'module',dependencies:{'@deepseek-ai/dsh':'0.2.0-rc.2'},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'],patchReload:'startup'}}};
 const lock=await readFile(new URL('./runtime-package-lock.json',import.meta.url),'utf8');
 const parent=join(home,'profiles');await mkdir(parent,{recursive:true});const directory=join(parent,name);await mkdir(directory);
 await writeFile(join(directory,'package.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 await writeFile(join(directory,'package-lock.json'),lock,{flag:'wx'});
 await writeFile(join(directory,'cordis.yml'),'[]\n',{flag:'wx'});
 await writeFile(join(directory,'cordis.patch.yml'),yaml,{flag:'wx'});
 await writeFile(join(directory,'.gitignore'),'.env\nnode_modules/\n',{flag:'wx'});
 return Object.freeze({directory,profile:name,runtimeVersion:'0.2.0-rc.2'});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=process.argv.slice(2);if(args.length<1||args.length>2)throw Error('usage');const result=await createHostProfile({home:args[0],name:args[1]??'jot'});console.log(JSON.stringify(result));}
 catch{console.error('Jot host preparation failed. Use: node create-profile.mjs <absolute-private-home> [profile-name]. The profile must not already exist.');process.exitCode=1;}
}
