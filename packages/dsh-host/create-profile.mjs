import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createBudgetModelSelector} from '../session-adapter/budget-model-selection.js';

import {validateHostPolicyBootstrapRuntimeConfig} from '../session-adapter/host-policy-bootstrap-runtime.js';
import {normalizeMcpHttpPolicy} from '../session-adapter/mcp-host-http.js';
import {validateHostCredentialRefs} from '../session-adapter/host-credentials-owner-route.js';
import {writeOwnerBoundDshProfile} from '../session-adapter/dsh-profile-binding.js';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const HASH=/^[a-f0-9]{64}$/;
function profileHostSettings(value,gatewayOrigin){
 if(value===undefined)return undefined;
 try{
  if(!(exact(value,['ownerId','bootstrap','productSchema','writeNamespace'])||exact(value,['ownerId','bootstrap','productSchema','writeNamespace','credentialRefs']))||!record(value.bootstrap)||!record(value.productSchema))throw Error();
  validateHostPolicyBootstrapRuntimeConfig(value.bootstrap);
  if(typeof value.ownerId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.ownerId)||value.bootstrap.gatewayOrigin!==gatewayOrigin||!value.bootstrap.namespaces.includes(value.writeNamespace)
   ||value.writeNamespace!=='jot-session-adapter'
   ||!exact(value.productSchema,['schema_fingerprint','schema_version'])||!Number.isSafeInteger(value.productSchema.schema_version)
   ||value.productSchema.schema_version<1||!HASH.test(value.productSchema.schema_fingerprint??''))throw Error();
  return{ownerId:value.ownerId,bootstrap:{...value.bootstrap,namespaces:[...value.bootstrap.namespaces]},writeNamespace:value.writeNamespace,
   productSchema:{...value.productSchema},credentialRefs:validateHostCredentialRefs(value.credentialRefs??[])};
 }catch{throw Error('host_profile_settings_invalid');}
}

/** Prepare an unused official DSH profile. No install, launch, credential read or SDK patch. */
export async function createHostProfile({home,name='jot',adapter=fileURLToPath(new URL('../session-adapter/index.js',import.meta.url)),workbench,hostSettings,mcpHttpPolicy}){
 if(typeof home!=='string'||!isAbsolute(home)||typeof name!=='string'||!/^[a-z][a-z0-9-]{0,47}$/.test(name)||name==='desktop'||typeof adapter!=='string'||!isAbsolute(adapter))throw Error('host_profile_config_invalid');
 if(!(await stat(adapter)).isFile())throw Error('host_profile_adapter_invalid');
 let route,origin='http://127.0.0.1:18831';
 if(workbench!==undefined){try{
  if(!workbench||typeof workbench!=='object'||Array.isArray(workbench)||Object.keys(workbench).some(key=>!['provider','model','origin'].includes(key)))throw Error();
  route={provider:workbench.provider,model:workbench.model};createBudgetModelSelector({route});
  if(workbench.origin!==undefined){const url=new URL(workbench.origin);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error();origin=url.origin;}
 }catch{throw Error('host_profile_workbench_invalid');}}
 const configuredHostSettings=profileHostSettings(hostSettings,origin);
 const configuredMcpHttpPolicy=mcpHttpPolicy===undefined?undefined:normalizeMcpHttpPolicy(mcpHttpPolicy);
 if(configuredHostSettings&&configuredMcpHttpPolicy&&configuredHostSettings.ownerId!==configuredMcpHttpPolicy.owner_id)throw Error('host_profile_owner_conflict');
 const ownerId=configuredHostSettings?.ownerId??configuredMcpHttpPolicy?.owner_id;
 const preset=fileURLToPath(new URL('./standard-preset.mjs',import.meta.url));
 const mcpProvider=fileURLToPath(new URL('../session-adapter/mcp-host-provider.js',import.meta.url));
 if(!(await stat(mcpProvider)).isFile())throw Error('host_profile_mcp_provider_invalid');
 const policyEntry=join(home,'profiles',name,'jot-host-policy-config-entry.mjs');
 const hostPolicyModule=pathToFileURL(join(dirname(adapter),'host-policy-config.js')).href;
 if(configuredHostSettings&&!(await stat(join(dirname(adapter),'host-policy-config.js'))).isFile())throw Error('host_profile_policy_schema_source_invalid');
 const policySource=`import z from '@deepseek-ai/schemastery';\nimport {createHostPolicyConfig} from ${JSON.stringify(hostPolicyModule)};\n\nexport const Config=createHostPolicyConfig(z);\n\nexport function apply(){}\n`;
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
   {id:'preset-jot-general',name:pathToFileURL(preset).href,...(route?{config:{budgeted:true}}:{})},
   ...(configuredHostSettings?[{id:'jot-host-policy',name:pathToFileURL(policyEntry).href,config:{}}]:[]),
   {id:'jot-mcp-runtime-provider',name:pathToFileURL(mcpProvider).href,...(configuredMcpHttpPolicy?{config:{httpPolicy:configuredMcpHttpPolicy}}:{})},
   {id:'jot-session-adapter',name:pathToFileURL(adapter).href,inject:['jotHostReady'],config:{host:'127.0.0.1',port:18841,tokenEnv:'JOT_SESSION_ADAPTER_TOKEN',workbenchTokenEnv:'GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN',workbenchOrigin:origin,nativeContinuation:!!route,nativeRoles:false,webBudgetEnabled:false,voiceEnabled:false,...(route?{workbenchModel:route}:{}),
    ...(configuredHostSettings?{hostSettingsBootstrap:configuredHostSettings.bootstrap,hostSettingsOwnerRoutesEnabled:true,hostSettingsWriteEnabled:true,hostSettingsWriteNamespace:configuredHostSettings.writeNamespace,hostSettingsProductSchema:configuredHostSettings.productSchema,hostCredentialRefs:configuredHostSettings.credentialRefs}:{})}},
  ]},
 ];
 // Preserve the official lazy expression. JSON is valid YAML; this one value
 // must remain a Loader expression, never a stale preparation-time directory.
 const yaml=JSON.stringify(patch,null,2).replace('"mode": "workspace-write"','"mode": "workspace-write",\n      "workspaceRoot": !!js process.cwd()')+'\n';
 const manifest={name:'jot-dsh-host-profile',version:'0.1.0',license:'Apache-2.0',private:true,type:'module',dependencies:{'@deepseek-ai/dsh':'0.2.1-rc.2'},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'],patchReload:'startup'}}};
 const lock=await readFile(new URL('./runtime-package-lock.json',import.meta.url),'utf8');
 const parent=join(home,'profiles');await mkdir(parent,{recursive:true});const directory=join(parent,name);await mkdir(directory);
 await writeFile(join(directory,'package.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 await writeFile(join(directory,'package-lock.json'),lock,{flag:'wx'});
 await writeFile(join(directory,'cordis.yml'),'[]\n',{flag:'wx'});
 await writeFile(join(directory,'cordis.patch.yml'),yaml,{flag:'wx'});
 if(configuredHostSettings){
  await writeFile(join(directory,'jot-host-policy-config-entry.mjs'),policySource,{flag:'wx'});
 }
 if(ownerId)writeOwnerBoundDshProfile(directory,ownerId);
 await writeFile(join(directory,'.gitignore'),'.env\nnode_modules/\n',{flag:'wx'});
 return Object.freeze({directory,profile:name,runtimeVersion:'0.2.1-rc.2'});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);
  if(args.length<1||args.length>5)throw Error('usage');
  const workbench=args[2]===undefined?undefined:JSON.parse(await readFile(args[2],'utf8'))??undefined;
  const hostSettings=args[3]===undefined?undefined:JSON.parse(await readFile(args[3],'utf8'))??undefined;
  const mcpHttpPolicy=args[4]===undefined?undefined:JSON.parse(await readFile(args[4],'utf8'));
  const result=await createHostProfile({home:args[0],name:args[1]??'jot',workbench,hostSettings,mcpHttpPolicy});
  console.log(JSON.stringify(result));
 }
 catch{console.error('Jot host preparation failed. Use: node create-profile.mjs <absolute-private-home> [profile-name] [private-workbench-route.json] [private-host-settings-config.json] [private-mcp-http-policy.json]. The profile must not already exist.');process.exitCode=1;}
}
