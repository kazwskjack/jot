import {readFile,lstat} from 'node:fs/promises';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const profiles=new Set(['standalone','gateway','host']);
const stages=new Set(['source','runtime']);
const defaultRoot=fileURLToPath(new URL('../',import.meta.url));
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
async function file(path){try{const info=await lstat(path);return info.isFile()&&!info.isSymbolicLink()&&info.size>0;}catch{return false;}}
async function directory(path){try{return isAbsolute(path)&&(await lstat(path)).isDirectory();}catch{return false;}}
async function json(path){try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>4*1024*1024)return null;const value=JSON.parse(await readFile(path,'utf8'));return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}}
async function sourceText(path){try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>256*1024)return '';return await readFile(path,'utf8');}catch{return '';}}
function oneLiteral(source,pattern){const matches=[...source.matchAll(pattern)];return matches.length===1?matches[0][1]:undefined;}
async function hostSourceVersion(root){
 // Parse only these existing literal contracts. Never import/evaluate the
 // inspected checkout or operator profile; changed source shapes fail closed.
 const preparer=await sourceText(join(root,'packages/dsh-host/create-profile.mjs')),preset=await sourceText(join(root,'packages/dsh-host/standard-preset.mjs'));
 const dependency=oneLiteral(preparer,/["']@deepseek-ai\/dsh["']\s*:\s*["']([^"']+)["']/g),returned=oneLiteral(preparer,/runtimeVersion\s*:\s*["']([^"']+)["']/g),guard=oneLiteral(preset,/manifest\.version\s*!==\s*["']([^"']+)["']/g);
 return dependency&&dependency===returned&&dependency===guard?dependency:undefined;
}
const present=value=>typeof value==='string'&&value.trim().length>0;
function webUrl(value,{loopback=false,origin=false}={}){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hash&&(!origin||url.pathname==='/'&&!url.search)&&(!loopback||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.pathname==='/'&&!url.search);}catch{return false;}}
function engineMatch(range,version){
 const minimum=typeof range==='string'&&range.match(/^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/),actual=typeof version==='string'&&version.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
 if(!minimum)return null;if(!actual)return false;
 for(let index=1;index<=3;index++){const wanted=Number(minimum[index]??0),current=Number(actual[index]);if(current!==wanted)return current>wanted;}return true;
}
const validArguments=options=>profiles.has(options.profile??'standalone')&&stages.has(options.stage??'source')&&typeof(options.root??defaultRoot)==='string';

/** Read-only structural checks. Never import runtime modules or parse private env/token files. */
export async function inspectRelease(options={}){
 if(!validArguments(options))throw Error('INVALID_ARGUMENTS');
 const profile=options.profile??'standalone',stage=options.stage??'source',root=resolve(options.root??defaultRoot),env=options.env??process.env,checks=[];
 const add=(id,ok,success,failure)=>checks.push({id,status:ok?'pass':'fail',code:ok?success:failure});
 const requiredFile=async(id,path)=>add(id,await file(path),'FILE_PRESENT','FILE_MISSING_OR_EMPTY');
 const manifestRelative=profile==='standalone'?'package.json':`packages/${profile==='gateway'?'gateway':'dsh-host'}/package.json`;
 const manifest=await json(join(root,manifestRelative));add('source.manifest',!!manifest,'MANIFEST_READABLE','MANIFEST_INVALID');
 const matches=engineMatch(manifest?.engines?.node,options.nodeVersion??process.versions.node);
 add('node.engine',matches===true,'ENGINE_MATCH',matches===null?'ENGINE_CONTRACT_UNSUPPORTED':'ENGINE_MISMATCH');
 const prefix=profile==='gateway'?'packages/gateway/':'';
 let hostLock;
 if(profile==='host'){
  hostLock=await json(join(root,'packages/dsh-host/runtime-package-lock.json'));
  const version=await hostSourceVersion(root);
  add('source.lock',!!version&&hostLock?.packages?.['node_modules/@deepseek-ai/dsh']?.version===version&&hostLock?.packages?.['']?.dependencies?.['@deepseek-ai/dsh']===version&&hostLock.lockfileVersion===3,'LOCK_SOURCE_CONTRACT_MATCH','LOCK_SOURCE_CONTRACT_MISMATCH');
  await requiredFile('source.entry',join(root,'packages/dsh-host/create-profile.mjs'));
  await requiredFile('source.preset',join(root,'packages/dsh-host/standard-preset.mjs'));
  await requiredFile('source.adapter',join(root,'packages/session-adapter/index.js'));
 }else{
  const lock=await json(join(root,prefix+'package-lock.json')),locked=lock?.packages?.[''];
  add('source.lock',!!manifest&&!!locked&&lock.lockfileVersion===3&&locked.name===manifest.name&&locked.version===manifest.version&&canonical(locked.dependencies??{})===canonical(manifest.dependencies??{}),'LOCK_MANIFEST_MATCH','LOCK_MANIFEST_MISMATCH');
  await requiredFile('source.entry',join(root,profile==='standalone'?'src/server.mjs':'packages/gateway/src/main.ts'));
  if(profile==='gateway'){await requiredFile('source.worker',join(root,'packages/gateway/src/harness/main.ts'));await requiredFile('source.contract',join(root,'packages/gateway/contracts/openapi.json'));}
 }
 if(stage==='runtime'){
  add('runtime.cwd',typeof options.cwd==='string'&&await directory(options.cwd),'DIRECTORY_PRESENT','ABSOLUTE_DIRECTORY_REQUIRED');
  if(profile!=='host'){
   let index=0;for(const [name,version]of Object.entries(manifest?.dependencies??{}).sort(([a],[b])=>a.localeCompare(b))){
    // Package names must not turn a manifest entry into an arbitrary file read.
    const safe=/^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/.test(name),installed=safe?await json(join(root,prefix+'node_modules',name,'package.json')):null;
    add(`dependency.${++index}`,!!installed&&installed.version===version,'DIRECT_DEPENDENCY_VERSION_MATCH','DIRECT_DEPENDENCY_MISSING_OR_MISMATCH');
   }
  }
  if(profile==='standalone'){
   await requiredFile('build.web',join(root,'dist/index.html'));
   add('config.model_url',webUrl(env.JOT_MODEL_URL),'CONFIG_SHAPE_VALID','MODEL_URL_REQUIRED');
   add('config.model',present(env.JOT_MODEL),'CONFIG_PRESENT','MODEL_REQUIRED');
  }else if(profile==='gateway'){
   for(const [id,path]of [['build.api','dist/src/main.js'],['build.worker','dist/src/harness/main.js'],['build.schema','dist/src/db/schema.sql'],['build.contract','dist/contracts/openapi.json']])await requiredFile(id,join(root,'packages/gateway',path));
   add('config.csrf',typeof env.GENERAL_AGENT_CSRF_TOKEN==='string'&&env.GENERAL_AGENT_CSRF_TOKEN.trim().length>=16,'CONFIG_SHAPE_VALID','CSRF_MINIMUM_REQUIRED');
   add('config.internal_token',present(env.GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN),'CONFIG_PRESENT','INTERNAL_TOKEN_REQUIRED');
   add('config.workspaces',present(env.GENERAL_AGENT_WORKSPACES)&&env.GENERAL_AGENT_WORKSPACES.split(',').some(value=>value.trim()),'CONFIG_PRESENT','WORKSPACES_REQUIRED');
   add('config.origins',present(env.GENERAL_AGENT_ALLOWED_ORIGINS)&&env.GENERAL_AGENT_ALLOWED_ORIGINS.split(',').every(value=>webUrl(value.trim(),{origin:true})),'CONFIG_SHAPE_VALID','ORIGINS_REQUIRED');
   add('config.adapter_url',webUrl(env.GENERAL_AGENT_SESSION_ADAPTER_URL??'http://127.0.0.1:18841',{loopback:true}),'CONFIG_SHAPE_VALID','LOOPBACK_ADAPTER_REQUIRED');
   add('config.database_parent',present(env.GENERAL_AGENT_DB)&&isAbsolute(env.GENERAL_AGENT_DB)&&await directory(dirname(env.GENERAL_AGENT_DB)),'DIRECTORY_PRESENT','EXPLICIT_DATABASE_PARENT_REQUIRED');
   add('config.file_root',present(env.GENERAL_AGENT_FILE_ROOT)&&await directory(env.GENERAL_AGENT_FILE_ROOT),'DIRECTORY_PRESENT','EXPLICIT_FILE_ROOT_REQUIRED');
   add('config.harness_cwd',present(env.GENERAL_AGENT_HARNESS_CWD)&&await directory(env.GENERAL_AGENT_HARNESS_CWD),'DIRECTORY_PRESENT','EXPLICIT_HARNESS_CWD_REQUIRED');
   add('config.adapter_token_file',present(env.GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE)&&isAbsolute(env.GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE)&&await file(env.GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE),'TOKEN_FILE_PRESENT_UNREAD','EXPLICIT_TOKEN_FILE_REQUIRED');
   const recovery=env.GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED==='true',steering=env.GENERAL_AGENT_ORDINARY_STEERING_ENABLED==='true',reconciliation=env.GENERAL_AGENT_ORDINARY_STEERING_RECONCILIATION_ENABLED==='true',finalReconciliation=env.GENERAL_AGENT_ORDINARY_FINAL_RECONCILIATION_ENABLED==='true';
   add('config.recovery_switches',(!steering||recovery)&&(!reconciliation||steering)&&(!finalReconciliation||recovery&&steering),'RECOVERY_SWITCH_DEPENDENCIES_MATCH','RECOVERY_SWITCH_DEPENDENCIES_INVALID');
  }else{
   const host=options.hostProfileDir,valid=typeof host==='string'&&await directory(host);add('host.profile_directory',valid,'DIRECTORY_PRESENT','ABSOLUTE_PROFILE_DIRECTORY_REQUIRED');
   if(valid){
    const prepared=await json(join(host,'package.json')),lock=await json(join(host,'package-lock.json')),expected=hostLock?.packages?.['node_modules/@deepseek-ai/dsh'];
    add('host.prepared_version',!!expected&&prepared?.dependencies?.['@deepseek-ai/dsh']===expected.version,'PINNED_PROFILE_MATCH','PINNED_PROFILE_MISMATCH');
    add('host.lock',!!hostLock&&!!lock&&canonical(lock)===canonical(hostLock),'PINNED_LOCK_MATCH','PINNED_LOCK_MISMATCH');
    await requiredFile('host.config',join(host,'cordis.yml'));await requiredFile('host.patch',join(host,'cordis.patch.yml'));
    const installed=await json(join(host,'node_modules/@deepseek-ai/dsh/package.json'));
    add('host.installed_version',!!expected&&installed?.version===expected.version&&installed?.bin?.dsh===expected.bin?.dsh,'PINNED_LAUNCHER_MATCH','PINNED_LAUNCHER_MISMATCH');
    const bin=expected?.bin?.dsh,safe=typeof bin==='string'&&bin.split('/').every(part=>/^[A-Za-z0-9_.-]+$/.test(part)&&part!=='.'&&part!=='..');
    add('host.launcher',safe&&await file(join(host,'node_modules/@deepseek-ai/dsh',bin)),'FILE_PRESENT','LAUNCHER_MISSING');
   }
   add('config.adapter_token',typeof env.JOT_SESSION_ADAPTER_TOKEN==='string'&&env.JOT_SESSION_ADAPTER_TOKEN.length>=32,'CONFIG_SHAPE_VALID','ADAPTER_TOKEN_MINIMUM_REQUIRED');
  }
 }
 return {protocol:1,profile,stage,scope:'offline_structure_only',ready:checks.every(check=>check.status==='pass'),checks};
}

export async function main(args=process.argv.slice(2)){
 const options={},seen=new Set();let jsonOutput=false;
 try{
  for(let index=0;index<args.length;index++){
   const flag=args[index];if(seen.has(flag))throw Error();seen.add(flag);
   if(flag==='--json'){jsonOutput=true;continue;}
   const key={'--profile':'profile','--stage':'stage','--root':'root','--cwd':'cwd','--host-profile-dir':'hostProfileDir'}[flag];
   if(!key||!args[index+1]||args[index+1].startsWith('--'))throw Error();options[key]=args[++index];
  }
  if(!validArguments(options))throw Error();
 }catch{console.log(JSON.stringify({protocol:1,error:'INVALID_ARGUMENTS'}));return 2;}
 try{const result=await inspectRelease(options);if(jsonOutput)console.log(JSON.stringify(result));else{console.log(`Release preflight: ${result.profile}/${result.stage} (${result.scope})`);for(const check of result.checks)console.log(`${check.status} ${check.id} ${check.code}`);console.log(result.ready?'Offline checks passed; live acceptance remains separate.':'Offline checks incomplete.');}return result.ready?0:1;}
 catch{console.log(JSON.stringify({protocol:1,error:'INSPECTION_FAILED'}));return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main();
