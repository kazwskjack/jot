import {isAbsolute} from 'node:path';
import {loadMemoryExtractionRuntime} from './memory-runtime-loader.js';
import {createMemoryExtractionHost} from './memory-extraction-host.js';

/** Optional feature failure must not take ordinary Sessions offline. */
export function createOptionalMemoryExtractionHost({config,bridge,llm,route}={}){
 if(config===undefined)return undefined;
 let host,disposed=false;
 const prepared=(async()=>{
  try{
   if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(key=>!['root','modulesRoot','maxOutputTokens'].includes(key))
    ||typeof config.root!=='string'||!isAbsolute(config.root)||typeof config.modulesRoot!=='string'||!isAbsolute(config.modulesRoot)
    ||!Number.isSafeInteger(config.maxOutputTokens)||config.maxOutputTokens<1)throw Error('invalid_config');
   const runtime=await loadMemoryExtractionRuntime(config.modulesRoot);
   if(disposed)return;
   host=createMemoryExtractionHost({runtime,root:config.root,bridge,llm,route:{...route,max_output_tokens:config.maxOutputTokens}});
  }catch{/* Readiness exposes a fixed reason, never package paths or contents. */}
 })();
 async function ready(){
  await prepared;
  if(!host||disposed||typeof llm?.resolveCallConfig!=='function')return false;
  try{
   const resolved=await llm.resolveCallConfig({provider:route.provider,model:route.model,reasoningEffort:'high',maxTokens:config.maxOutputTokens});
   return !disposed&&resolved.provider===route.provider&&resolved.model===route.model&&resolved.reasoningEffort==='high'&&resolved.maxTokens===config.maxOutputTokens;
  }catch{return false;}
 }
 return {
  async readiness(){return await ready()?{ready:true}:{ready:false,reason:'memory_extraction_runtime_unavailable'};},
  async run(agent,options){if(!await ready())throw Error('memory_extraction_runtime_unavailable');return host.run(agent,options);},
  async dispose(){disposed=true;await prepared;await host?.dispose();},
 };
}
