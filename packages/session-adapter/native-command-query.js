import {isDeepStrictEqual} from 'node:util';
import {normalizeSkillReadScope,createSkillReadBinding} from './skill-read-scope.js';
import {readSkillCatalogView} from '../skills/catalog-view.js';
import {commandManifest} from '../skills/catalog-contract.js';
import {validateNativeCommandQuery,validateNativeCommandQueryResult} from '../skills/command-query.js';
import {observeNativeCommandStart} from './native-command-audit.js';
import {readNativeCommandAudit} from './native-command-audit-reader.js';

/** Native query handlers keep their command/run and command/done audit owner. */
export function createNativeCommandQueryHost({agents,sessions,persistence,bridge,ordinaryPresets}){
 const lifetime=new AbortController(),jobs=new Set();let closed=false;
 async function execute(packet,signal){
  const scope=normalizeSkillReadScope(packet.scope),request=validateNativeCommandQuery(packet.request);
  if(typeof packet.grant_token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(packet.grant_token))throw Error('native_command_query_invalid');
  const original={scope,request,grant_token:packet.grant_token},binding={runId:scope.run_id,sessionRef:scope.session_ref};
  const active=AbortSignal.any([lifetime.signal,AbortSignal.timeout(30000),...(signal?[signal]:[])]);
  const settle=(state,result)=>bridge.request('native-command-query-settle',binding,{...original,state,...(result?{result}:{})});
  let claimAttempted=false;
  try{
   const source=createSkillReadBinding({scope,signal:active,agents,sessions,bridge,ordinaryPresets});
   await source.authorize();
   const commands=source.agent.ctx.get('commands',false);
   if(typeof commands?.find!=='function'||typeof commands.execute!=='function')throw Error('native_command_query_unavailable');
   const catalog=await readSkillCatalogView({skills:source.agent.ctx.get('skills'),cwd:source.cwd,scope:source.agent,signal:active,includeCommands:true,commands});
   if(catalog.catalogSha256!==request.expected_catalog_sha256)throw Error('native_command_query_catalog_changed');
   const descriptor=catalog.commands.items.find(value=>value.name===request.name),definition=commands.find(source.agent,request.name);
   if(!descriptor||!definition||definition.definitionId!==request.definition_id
    ||!isDeepStrictEqual(commandManifest(definition),descriptor))throw Error('native_command_query_catalog_changed');
   await source.authorize();
   claimAttempted=true;
   const grant=await bridge.request('native-command-query-claim',binding,original,active);
   if(grant?.dispatch!==true)return {request_id:request.request_id,accepted:true};
   await source.authorize();
   if(commands.find(source.agent,request.name)!==definition)throw Error('native_command_query_catalog_changed');
   active.throwIfAborted();
   const execution=observeNativeCommandStart(source.agent,request.name,()=>commands.execute(source.agent,'/'+request.name,[],active));
   if(execution.audit){
    try{
     if(await sessions.flush(source.session)===true)await bridge.request('native-command-query-bind',binding,{...original,audit:execution.audit});
    }catch{}
   }
   const result=validateNativeCommandQueryResult(await execution.running);
   if(execution.audit&&result.commandId!==execution.audit.command_id)throw Error('native_command_query_audit_changed');
   if(await sessions.flush(source.session)!==true)throw Error('native_command_query_flush_unconfirmed');
   await settle('settled',result);
   return {request_id:request.request_id,accepted:true};
  }catch{
   await settle(claimAttempted?'unknown':'rejected').catch(()=>{});
   return {request_id:request.request_id,accepted:true};
  }
 }
 return Object.freeze({execute(packet,signal){
  if(closed)return Promise.reject(Error('native_command_query_host_closed'));
  const job=execute(packet,signal);jobs.add(job);job.then(()=>jobs.delete(job),()=>jobs.delete(job));return job;
 },reconcile(packet,signal){
  if(closed)return Promise.reject(Error('native_command_query_host_closed'));
  const active=AbortSignal.any([lifetime.signal,AbortSignal.timeout(30000),...(signal?[signal]:[])]);
  const job=readNativeCommandAudit({packet,persistence,sessions,bridge,signal:active});jobs.add(job);job.then(()=>jobs.delete(job),()=>jobs.delete(job));return job;
 },async close(){closed=true;lifetime.abort(Error('native_command_query_host_closed'));await Promise.allSettled([...jobs]);}});
}
