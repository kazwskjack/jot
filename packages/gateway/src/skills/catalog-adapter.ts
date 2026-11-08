import type {SkillCatalogHost,SkillCatalogScope} from './catalog.ts';
/** Reuses operator-configured adapter transport. The bearer is transport
 * authentication; the Host still checks the original Workbench guard. */
export class SkillCatalogAdapterClient implements SkillCatalogHost{
 #origin:string;#token:string;#fetch:typeof fetch;
 constructor(baseUrl:string,token:string,fetchImpl:typeof fetch=globalThis.fetch){
  const url=new URL(baseUrl);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/'||url.username||url.password||url.search||url.hash
   ||typeof token!=='string'||token.length<32||token.length>512||/[\r\n]/.test(token)||typeof fetchImpl!=='function')throw Error('skill_catalog_adapter_configuration_invalid');
  this.#origin=url.origin;this.#token=token;this.#fetch=fetchImpl;
 }
 async read({scope,signal,include_commands}:{scope:SkillCatalogScope;signal?:AbortSignal;include_commands?:true}):Promise<unknown>{
  const combined=AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]);combined.throwIfAborted();
  const response=await this.#fetch(this.#origin+'/v1/skills/catalog',{method:'POST',redirect:'error',cache:'no-store',
   headers:{authorization:`Bearer ${this.#token}`,'content-type':'application/json'},
   body:JSON.stringify({protocol:1,scope,...(include_commands?{include_commands:true}:{})}),signal:combined});
  combined.throwIfAborted();
  if(response.status===404)throw Error('skill_catalog_scope_forbidden');
  if(response.status===409)throw Error('skill_catalog_scope_changed');
  if(!response.ok)throw Error('skill_catalog_adapter_unavailable');
  const reader=response.body?.getReader();if(!reader)throw Error('skill_catalog_adapter_invalid');
  const chunks:Uint8Array[]=[];let length=0,done=false;
  try{for(;;){const next=await reader.read();combined.throwIfAborted();if(next.done){done=true;break;}length+=next.value.byteLength;
    if(length>8*1024*1024)throw Error('skill_catalog_adapter_invalid');chunks.push(next.value);}}
  finally{if(!done)await reader.cancel().catch(()=>{});reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('skill_catalog_adapter_invalid');}
 }
 async readDefinition({scope,name,signal,include_source_manifest}:{scope:SkillCatalogScope;name:string;signal?:AbortSignal;include_source_manifest?:true}):Promise<unknown>{
  const combined=AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]);combined.throwIfAborted();
  const response=await this.#fetch(this.#origin+'/v1/skills/read',{method:'POST',redirect:'error',cache:'no-store',
   headers:{authorization:`Bearer ${this.#token}`,'content-type':'application/json'},
   body:JSON.stringify({protocol:1,scope,name,include_manifest:true,...(include_source_manifest?{include_source_manifest:true}:{})}),signal:combined});
  combined.throwIfAborted();
  if(response.status===404)throw Error('skill_not_found');
  if(response.status===409)throw Error('skill_catalog_scope_changed');
  if(response.status===413)throw Error('skill_resource_too_large');
  if(response.status===422)throw Error(include_source_manifest?'skill_source_manifest_unavailable':'skill_resource_provider_unsupported');
  if(!response.ok)throw Error('skill_catalog_adapter_unavailable');
  const reader=response.body?.getReader();if(!reader)throw Error('skill_catalog_adapter_invalid');
  const chunks:Uint8Array[]=[];let length=0,done=false;
  try{for(;;){const next=await reader.read();combined.throwIfAborted();if(next.done){done=true;break;}
    length+=next.value.byteLength;if(length>8*1024*1024)throw Error('skill_catalog_adapter_invalid');chunks.push(next.value);}}
  finally{if(!done)await reader.cancel().catch(()=>{});reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('skill_catalog_adapter_invalid');}
 }
 async executeCommandQuery(packet:Record<string,unknown>):Promise<unknown>{
  const response=await this.#fetch(this.#origin+'/v1/commands/query',{method:'POST',redirect:'error',cache:'no-store',
   headers:{authorization:`Bearer ${this.#token}`,'content-type':'application/json'},body:JSON.stringify(packet),signal:AbortSignal.timeout(35000)});
  if(!response.ok)throw Error('native_command_query_response_unknown');
  return response.json();
 }
 async reconcileCommandQuery(packet:Record<string,unknown>):Promise<unknown>{
  const response=await this.#fetch(this.#origin+'/v1/commands/query/reconcile',{method:'POST',redirect:'error',cache:'no-store',
   headers:{authorization:`Bearer ${this.#token}`,'content-type':'application/json'},body:JSON.stringify(packet),signal:AbortSignal.timeout(35000)});
  if(!response.ok)throw Error('native_command_query_audit_unavailable');
  return response.json();
 }
 async readResource({scope,skill_name,relative_path,signal}:{scope:SkillCatalogScope;skill_name:string;relative_path:string;signal?:AbortSignal}):Promise<unknown>{
  const combined=AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]);combined.throwIfAborted();
  const response=await this.#fetch(this.#origin+'/v1/skills/resource',{method:'POST',redirect:'error',cache:'no-store',
   headers:{authorization:`Bearer ${this.#token}`,'content-type':'application/json'},
   body:JSON.stringify({protocol:1,scope,skill_name,relative_path}),signal:combined});
  combined.throwIfAborted();
  if(response.status===404)throw Error('skill_catalog_scope_forbidden');
  if(response.status===409)throw Error('skill_catalog_scope_changed');
  if(!response.ok)throw Error('skill_catalog_adapter_unavailable');
  const reader=response.body?.getReader();if(!reader)throw Error('skill_catalog_adapter_invalid');
  const chunks:Uint8Array[]=[];let length=0,done=false;
  try{for(;;){const next=await reader.read();combined.throwIfAborted();if(next.done){done=true;break;}length+=next.value.byteLength;
    if(length>512*1024)throw Error('skill_catalog_adapter_invalid');chunks.push(next.value);}}
  finally{if(!done)await reader.cancel().catch(()=>{});reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('skill_catalog_adapter_invalid');}
 }
}
