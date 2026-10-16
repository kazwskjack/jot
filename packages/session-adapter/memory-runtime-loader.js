import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Optional, fixed-version runtime only. No installation, global setup or
 * fallback to another model/Agent. Callers can keep ordinary work available
 * while reporting extraction readiness as false when this loader rejects.
 */
export async function loadMemoryExtractionRuntime(modulesRoot){
 if(typeof modulesRoot!=='string'||!isAbsolute(modulesRoot))throw Error('memory_extraction_runtime_unavailable');
 const pluginRoot=join(modulesRoot,'@dsh-external/dsh-memory');
 let hashes;
 try{hashes=JSON.parse(await readFile(new URL('./runtime-patches/dsh-memory-0.5.0-sha256.json',import.meta.url),'utf8'));}
 catch{throw Error('memory_extraction_runtime_integrity');}
 for(const [name,digest]of Object.entries(hashes)){
  let bytes;try{bytes=await readFile(join(pluginRoot,name));}catch{throw Error('memory_extraction_runtime_unavailable');}
  if(createHash('sha256').update(bytes).digest('hex')!==digest)throw Error('memory_extraction_runtime_integrity');
 }
 try{
  const cordisRoot=join(modulesRoot,'@deepseek-ai/cordis'),llmRoot=join(modulesRoot,'@deepseek-ai/dsh-llm');
  const [cordisManifest,llmManifest]=await Promise.all([cordisRoot,llmRoot].map(async root=>JSON.parse(await readFile(join(root,'package.json'),'utf8'))));
  if(cordisManifest.name!=='@deepseek-ai/cordis'||cordisManifest.version!=='4.0.4'||llmManifest.name!=='@deepseek-ai/dsh-llm'||llmManifest.version!=='0.2.0-rc.2')throw Error('unsupported_sdk');
  const [cordis,llm,plugin]=await Promise.all([cordisRoot,llmRoot,pluginRoot].map(root=>import(pathToFileURL(join(root,'lib/index.js')).href)));
  if(typeof cordis.Context!=='function'||typeof llm.BlockAssembler!=='function'||typeof llm.createUserMessage!=='function'||plugin.name!=='dsh-memory'||typeof plugin.apply!=='function')throw Error('unsupported_exports');
  return Object.freeze({Context:cordis.Context,BlockAssembler:llm.BlockAssembler,createUserMessage:llm.createUserMessage,plugin});
 }catch{throw Error('memory_extraction_runtime_unavailable');}
}
