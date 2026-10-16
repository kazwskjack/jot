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
 return {
  async readiness(){await prepared;return host&&!disposed?{ready:true}:{ready:false,reason:'memory_extraction_runtime_unavailable'};},
  async run(agent,options){await prepared;if(!host||disposed)throw Error('memory_extraction_runtime_unavailable');return host.run(agent,options);},
  async dispose(){disposed=true;await prepared;await host?.dispose();},
 };
}
