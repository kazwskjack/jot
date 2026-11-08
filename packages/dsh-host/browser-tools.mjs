import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../../src/store.mjs';
import {createTools,readArtifact} from '../../src/tools.mjs';
import {assertNoBrowserPathSymlink,assertPrivateBrowserDirectory,ensurePrivateBrowserDirectory} from '../../src/browser-private-directory.mjs';

function normalize(config){
 const keys=['dataRoot','executablePath','origins','ownerId','privateRoot','profileRoot'];
 if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(key=>!keys.includes(key))
  ||typeof config.privateRoot!=='string'||!isAbsolute(config.privateRoot)||resolve(config.privateRoot)===parse(resolve(config.privateRoot)).root
  ||typeof config.dataRoot!=='string'||!isAbsolute(config.dataRoot)||typeof config.profileRoot!=='string'||!isAbsolute(config.profileRoot)
  ||config.ownerId!==undefined&&(typeof config.ownerId!=='string'||!config.ownerId||config.ownerId.length>512)||!Array.isArray(config.origins)||config.origins.length<1||config.origins.length>100
  ||config.executablePath!==undefined&&(typeof config.executablePath!=='string'||!isAbsolute(config.executablePath)))throw Error('jot_browser_tools_config_invalid');
 const origins=[];
 for(const value of config.origins){
  try{const url=new URL(value);if(typeof value!=='string'||url.protocol!=='https:'||url.origin!==value||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error();}
  catch{throw Error('jot_browser_tools_origins_invalid');}
  origins.push(value);
 }
 if(new Set(origins).size!==origins.length)throw Error('jot_browser_tools_origins_invalid');
 const privateRoot=resolve(config.privateRoot),dataRoot=resolve(config.dataRoot),profileRoot=resolve(config.profileRoot);
 const isChild=(root,path)=>{const child=relative(root,path);return child!==''&&child!=='..'&&!child.startsWith('..'+sep)&&!isAbsolute(child);};
 if(!isChild(privateRoot,dataRoot)||!isChild(privateRoot,profileRoot))throw Error('jot_browser_tools_config_invalid');
 return Object.freeze({privateRoot,dataRoot,profileRoot,origins:Object.freeze(origins),...(config.executablePath?{executablePath:resolve(config.executablePath)}:{})});
}

export function browserToolsConfigFromEnvironment(env=process.env){
 const keys=['JOT_BROWSER_PRIVATE_ROOT','JOT_BROWSER_ORIGINS','JOT_BROWSER_EXECUTABLE_PATH'];
 if(!env||typeof env!=='object'||Array.isArray(env))throw Error('jot_browser_tools_config_invalid');
 if(!keys.some(key=>Object.hasOwn(env,key)))return undefined;
 const privateRoot=env.JOT_BROWSER_PRIVATE_ROOT,originsJson=env.JOT_BROWSER_ORIGINS,executablePath=env.JOT_BROWSER_EXECUTABLE_PATH;
 if(typeof privateRoot!=='string'||!privateRoot||!isAbsolute(privateRoot)||resolve(privateRoot)===parse(resolve(privateRoot)).root
  ||typeof originsJson!=='string'||!originsJson||originsJson.length>8192
  ||executablePath!==undefined&&(typeof executablePath!=='string'||!executablePath||!isAbsolute(executablePath)))throw Error('jot_browser_tools_config_invalid');
 let origins;try{origins=JSON.parse(originsJson);}catch{throw Error('jot_browser_tools_config_invalid');}
 if(!Array.isArray(origins))throw Error('jot_browser_tools_config_invalid');
 const root=resolve(privateRoot);
 return Object.freeze({privateRoot:root,dataRoot:join(root,'state'),profileRoot:join(root,'profiles'),origins:Object.freeze(origins),...(executablePath?{executablePath:resolve(executablePath)}:{})});
}

function ensureConversation(store,id){
 if(store.conversation(id))return;
 store.db.prepare('INSERT OR IGNORE INTO conversations(id,title,created_at,mode,version) VALUES(?,?,?,\'work\',1)').run(id,'DSH session',new Date().toISOString());
}

function ensureRun(store,id,conversationId,requestId){
 const prior=store.run(id);
 if(prior){
  if(prior.conversation_id!==conversationId)throw Error('jot_browser_run_scope_conflict');
  // The current Gateway lease admits each call, including later calls in the same run.
  return prior.status==='running'?prior:store.state(id,'running');
 }
 store.db.prepare('INSERT INTO runs(id,conversation_id,request_id,input,status,error,created_at,mode,conversation_version) VALUES(?,?,?,?,?,NULL,?,\'work\',1)')
  .run(id,conversationId,requestId,'DSH browser tool invocation','running',new Date().toISOString());
 return store.run(id);
}

export function createBrowserToolsPlugin({browserFactory,approvalForAgent,privateDirectoryValidator}={}){
 if(approvalForAgent!==undefined&&typeof approvalForAgent!=='function'||privateDirectoryValidator!==undefined&&typeof privateDirectoryValidator!=='function')throw Error('jot_browser_tools_config_invalid');
 // Private test seam only; Session Adapter always uses the OS-backed default.
 const validatePrivateDirectory=privateDirectoryValidator??assertPrivateBrowserDirectory;
 return {
  name:'jot-browser-tools',
  inject:['profileContext','tools','approval'],
  async apply(ctx,rawConfig={}){
   const config=normalize(rawConfig),anchor=ctx.get('profileContext')?.installAnchor;
   if(typeof anchor!=='string')throw Error('jot_host_installation_missing');
   const require=createRequire(anchor),moduleUrl=pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href,{defineTool}=await import(moduleUrl);
   if(typeof defineTool!=='function')throw Error('jot_browser_tools_runtime_incompatible');
   await ensurePrivateBrowserDirectory(config.privateRoot,{validator:validatePrivateDirectory});
   await ensurePrivateBrowserDirectory(config.dataRoot,{validator:validatePrivateDirectory});
   await ensurePrivateBrowserDirectory(config.profileRoot,{validator:validatePrivateDirectory});
   const filesRoot=join(config.dataRoot,'files');await ensurePrivateBrowserDirectory(filesRoot,{validator:validatePrivateDirectory});
   const storePath=join(config.dataRoot,'browser-operations.sqlite');await assertNoBrowserPathSymlink(storePath);
   const store=new Store(storePath),recoveredRunIds=new Set(store.recover()),processInstanceId=randomUUID();
   const driverFactory=browserFactory??(async({userDataDir,contextOptions})=>{
    const {chromium}=await import('playwright');
    const context=await chromium.launchPersistentContext(userDataDir,{headless:true,...(config.executablePath?{executablePath:config.executablePath}:{}),...contextOptions});
    return{persistentContext:context};
   });
   const tools=createTools({store,root:filesRoot,browserProfilesRoot:config.profileRoot,origins:new Set(config.origins),browserEnabled:true,browserPrivateDirectoryValidator:validatePrivateDirectory,browserFactory:async options=>{
    try{return await driverFactory(options);}
    catch{throw Error('browser_driver_unavailable');}
   }});
   const source=tools.definitions.find(item=>item.function.name==='browser_action')?.function;
   if(!source){await tools.close();store.close();throw Error('jot_browser_tool_definition_missing');}
   let closed=false;const mounts=new Set();
   const approvalFor=agent=>approvalForAgent?.(agent)??ctx.approval;
   const readScope=(agent,scopeForAgent)=>{
    if(typeof scopeForAgent!=='function')throw Error('workbench_browser_scope_forbidden');
    const scope=scopeForAgent(agent),keys=scope&&typeof scope==='object'&&!Array.isArray(scope)?Object.keys(scope).sort():[];
    if(!scope||Object.getPrototypeOf(scope)!==Object.prototype||!Object.isFrozen(scope)
     ||!['assertCurrent,execution_lease,owner_id,protocol,run_id,session_ref','assertCurrent,execution_lease,owner_id,protocol,run_id,session_ref,workspace_id'].includes(keys.join(','))||scope.protocol!==1
     ||![scope.owner_id,scope.run_id,scope.session_ref].every(value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value))
     ||scope.session_ref!==agent?.id||typeof scope.assertCurrent!=='function')throw Error('workbench_browser_scope_forbidden');
    const lease=scope.execution_lease,leaseKeys=lease&&typeof lease==='object'&&!Array.isArray(lease)?Object.keys(lease).sort():[];
    if(!lease||Object.getPrototypeOf(lease)!==Object.prototype||!Object.isFrozen(lease)||leaseKeys.join(',')!=='generation,owner'
     ||typeof lease.owner!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(lease.owner)||!Number.isSafeInteger(lease.generation)||lease.generation<1)throw Error('workbench_browser_scope_forbidden');
    return scope;
   };
   const driverScope=scope=>({owner_id:scope.owner_id,workspace_id:scope.workspace_id,run_id:scope.run_id,session_id:scope.session_ref,lease_owner:scope.execution_lease.owner,lease_generation:scope.execution_lease.generation});
   const rememberDriverBinding=scope=>{
    ensureConversation(store,scope.session_ref);const bound=driverScope(scope),rows=store.db.prepare("SELECT data FROM events WHERE conversation_id=? AND type='browser.driver.bound' ORDER BY seq").all(scope.session_ref);
    const prior=rows.map(row=>JSON.parse(row.data)).filter(item=>item.run_id===scope.run_id).at(-1);
    if(prior&&prior.instance_id===processInstanceId&&Object.keys(bound).every(key=>prior[key]===bound[key]))return;
    store.event(scope.session_ref,'browser.driver.bound',{...bound,instance_id:processInstanceId});
   };
   const observeQuiescence=async({agent,scopeForAgent,expected,signal}={})=>{
    const unknown=reason=>({protocol:1,scope:structuredClone(expected),status:'unknown',required:true,observed_at:new Date().toISOString(),reason:reason??'driver_binding_unconfirmed',execution_authorized:false});
    try{
     signal?.throwIfAborted();if(closed||!expected||Object.keys(expected).sort().join(',')!=='lease_generation,lease_owner,owner_id,run_id,session_id,workspace_id')return unknown();
     const current=readScope(agent,scopeForAgent),bound=driverScope(current);
     if(Object.keys(bound).some(key=>bound[key]!==expected[key]))return unknown();
     const rows=store.db.prepare("SELECT data FROM events WHERE conversation_id=? AND type='browser.driver.bound' ORDER BY seq").all(expected.session_id).map(row=>JSON.parse(row.data)).filter(item=>item.run_id===expected.run_id);
     if(!rows.length)return unknown('browser_driver_binding_missing');
     if(rows.some(item=>item.instance_id!==processInstanceId||item.owner_id!==expected.owner_id||item.workspace_id!==expected.workspace_id||item.session_id!==expected.session_id))return unknown('browser_driver_instance_mismatch');
     const fingerprints=rows.map(item=>JSON.stringify(item));if(new Set(fingerprints).size!==fingerprints.length)return unknown('browser_driver_journal_duplicate');
     const last=rows.at(-1);if(Object.keys(expected).some(key=>last[key]!==expected[key]))return unknown('browser_driver_scope_mismatch');
     if(recoveredRunIds.has(expected.run_id))return unknown('browser_host_restarted');
     const proof=await tools.observeBrowserQuiescence(bound,{hostBindingObserved:true});signal?.throwIfAborted();
     const after=driverScope(readScope(agent,scopeForAgent));if(Object.keys(bound).some(key=>bound[key]!==after[key]))return unknown('browser_driver_scope_changed');
     return{protocol:1,scope:bound,status:proof.status,required:true,observed_at:proof.observed_at??new Date().toISOString(),...(proof.reason?{reason:proof.reason}:{}),execution_authorized:false};
    }catch{return unknown('browser_driver_quiescence_unconfirmed');}
   };
   const registrar=Object.freeze({protocol:1,async revokeProfile({agent,scopeForAgent,expectedGeneration,signal}){
    signal?.throwIfAborted();if(closed)throw Error('jot_browser_tools_closed');
    const scope=readScope(agent,scopeForAgent);
    if(!Number.isSafeInteger(expectedGeneration)||expectedGeneration<1)throw Error('browser_profile_generation_invalid');
    if(await scope.assertCurrent(signal)!==true)throw Error('workbench_browser_scope_forbidden');
    signal?.throwIfAborted();const current=readScope(agent,scopeForAgent),bound=driverScope(scope),fresh=driverScope(current);
    if(Object.keys(bound).some(key=>bound[key]!==fresh[key]))throw Error('workbench_browser_scope_forbidden');
    return tools.revokeBrowserProfile(scope.owner_id,expectedGeneration);
   },async observeDriver({agent,scopeForAgent,expected,signal}){
    const unknown=()=>({protocol:1,scope:structuredClone(expected),status:'unknown',required:true,observed_at:new Date().toISOString(),reason:'driver_binding_unconfirmed',execution_authorized:false});
    try{
     signal.throwIfAborted();if(closed)return unknown();const before=readScope(agent,scopeForAgent),bound=driverScope(before);
     if(Object.keys(bound).some(key=>bound[key]!==expected[key]))return unknown();
     await before.assertCurrent(signal);signal.throwIfAborted();const fact=tools.observeBrowserConnection(bound);
     await before.assertCurrent(signal);signal.throwIfAborted();const after=driverScope(readScope(agent,scopeForAgent));
     if(closed||Object.keys(bound).some(key=>bound[key]!==after[key]))return unknown();
     const finalFact=tools.observeBrowserConnection(bound);
     if(fact.status!=='ready'||finalFact.status!=='ready')return unknown();
     return{protocol:1,scope:bound,status:'ready',required:true,observed_at:finalFact.observed_at,execution_authorized:false};
    }catch{return unknown();}
   },async observeQuiescence(args){return observeQuiescence(args);},mount({agent,scopeForAgent,publishScreenshot}={}){
    if(closed||!agent||typeof agent.id!=='string'||typeof scopeForAgent!=='function'||typeof agent.ctx?.tools?.register!=='function'||publishScreenshot!==undefined&&typeof publishScreenshot!=='function')throw Error('jot_browser_tool_mount_invalid');
    let approval;try{approval=approvalFor(agent);}catch{return undefined;}
    if(typeof approval?.request!=='function')return undefined;
    try{rememberDriverBinding(readScope(agent,scopeForAgent));}catch{}
    let active=true;
    const registered=agent.ctx.tools.register(defineTool({
    name:source.name,
    description:source.description,
    parameters:{
     url:{type:'string',description:'Exact HTTPS URL in an allowed origin. Omit only for profile_revoke.'},
    action:{type:'string',required:true,enum:['read','click','fill','scroll','screenshot','profile_revoke']},
    candidate_id:{type:'string',description:'Candidate ID from the current page revision.'},
     page_revision:{type:'string',description:'Exact revision returned by the latest page read.'},
     text:{type:'string',description:'Text to fill into the identified textbox.'},
    },
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],presentationMeta:(_args,value)=>({status:value?.browser_profile_receipt?.status??value?.browser_receipt?.status??'unknown',action:value?.browser_profile_receipt?.kind??value?.browser_receipt?.action??'browser_action'})},
    async execute(args,exec){
     if(!active)throw Error('jot_browser_tool_unmounted');
     const agent=exec?.agent,scope=readScope(agent,scopeForAgent),signal=exec.signal,callId=exec.callId,rootCallId=exec.rootCallId;
     if(typeof callId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(callId)||typeof rootCallId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(rootCallId))throw Error('jot_browser_call_invalid');
     const assertCurrent=async()=>{if(await scope.assertCurrent(signal)!==true)throw Error('workbench_browser_scope_forbidden');};
     await assertCurrent();
     rememberDriverBinding(scope);
     const sessionId=scope.session_ref,runId=scope.run_id;
     ensureConversation(store,sessionId);ensureRun(store,runId,sessionId,rootCallId);
     // Individual operation receipts settle calls. The Gateway owns the shared run lifecycle.
     const result=await tools.execute('browser_action',args,{run:{id:runId,conversation_id:sessionId,owner_id:scope.owner_id},driverScope:typeof scope.workspace_id==='string'?driverScope(scope):undefined,signal,callId,assertCurrent,approve:async(description,actionPayload)=>{
       await assertCurrent();
       const approval=approvalFor(agent);if(typeof approval?.request!=='function')throw Error('approval_unavailable');
       const outcome=await approval.request({agent,toolName:'browser_action',callId,reason:description,signal,action_payload:actionPayload});
       if(outcome==='allowed-once'){await assertCurrent();return;}
       throw Error(outcome==='rejected'?'user_denied':outcome==='cancelled'?'cancelled':'approval_unavailable');
     }});
     await assertCurrent();
     if(args.action==='screenshot'&&result.browser_receipt?.status==='succeeded'&&publishScreenshot){
      const artifact=store.getArtifact(result.artifact_id);
      if(!artifact||artifact.run_id!==runId||artifact.conversation_id!==sessionId)throw Error('browser_artifact_scope_invalid');
      const content=await readArtifact(artifact.path,filesRoot);
      if(content.length!==result.size||createHash('sha256').update(content).digest('hex')!==result.sha256)throw Error('browser_artifact_content_changed');
      await assertCurrent();
      const published=await publishScreenshot(result,content,signal);
      if(published?.artifact_id!==result.artifact_id||published.sha256!==result.sha256||published.size_bytes!==result.size
        ||published.media_type!=='image/png'||published.version!==1)throw Error('browser_artifact_publication_unconfirmed');
      await assertCurrent();
     }
     return result;
    },
   }));
    if(typeof registered!=='function')throw Error('jot_browser_tool_registration_invalid');
    const dispose=()=>{if(!active)return;active=false;mounts.delete(dispose);registered();};mounts.add(dispose);return dispose;
   }});
   ctx.provide?.('jotBrowserToolRegistrar',registrar);
   ctx.effect(()=>async()=>{closed=true;for(const dispose of [...mounts])dispose();await tools.close();store.close();});
   return registrar;
  },
 };
}

const plugin=createBrowserToolsPlugin();
export const name=plugin.name;
export const inject=plugin.inject;
export const apply=plugin.apply;
