import {createHash,timingSafeEqual} from 'node:crypto';

export interface TrustedModelMetadataClient{
 trustedModelMetadata?(route:{provider:string;model:string},signal:AbortSignal):Promise<unknown>
 trustedModelMetadataReadiness?(signal:AbortSignal):Promise<unknown>
 modelCatalog?(signal:AbortSignal):Promise<unknown>
}
export type TrustedModelMetadataBinding=Readonly<{
 provider:string;model:string;digest_revision:'jot-model-metadata-v1';metadata_digest:string;
 source_config_revision:string|null;upstream_revision:string|null
}>;
const DIGEST_REVISION='jot-model-metadata-v1';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MODEL=/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const HASH=/^[a-f0-9]{64}$/;
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:unknown,keys:string[])=>plain(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const safeRevision=(value:unknown)=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
function canonical(value:unknown){return JSON.stringify(value,(_key,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);}

/** Explicit readiness avoids probing every model when ordinary model selection is disabled. */
export async function readHostTrustedModelMetadataEnabled(client:TrustedModelMetadataClient|undefined,signal?:AbortSignal):Promise<boolean|undefined>{
 if(!client||typeof client.trustedModelMetadataReadiness!=='function')return;
 const bounded=AbortSignal.any([AbortSignal.timeout(2000),...(signal?[signal]:[])]);let abort:(()=>void)|undefined;
 try{
  bounded.throwIfAborted();const read=client.trustedModelMetadataReadiness.bind(client),pending=Promise.resolve().then(()=>{bounded.throwIfAborted();return read(bounded);});
  const timeout=new Promise<never>((_resolve,reject)=>{abort=()=>reject(bounded.reason);bounded.addEventListener('abort',abort,{once:true});});
  let value:unknown;
  try{value=await Promise.race([pending,timeout]);}
  catch(error){
   if((error as {status?:unknown})?.status!==404||typeof client.modelCatalog!=='function')throw error;
   const legacy=await client.modelCatalog(bounded);bounded.throwIfAborted();
   if(plain(legacy)&&exact(legacy,['models','protocol','ready'])&&legacy.protocol===1&&legacy.ready===false&&Array.isArray(legacy.models)&&legacy.models.length===0)return false;
   throw Error('model_metadata_unavailable');
  }
  bounded.throwIfAborted();
  if(!plain(value)||!exact(value,['enabled','execution_authorized','protocol'])||value.protocol!==1||value.execution_authorized!==false||typeof value.enabled!=='boolean')throw Error('model_metadata_invalid');
  return value.enabled;
 }catch(error){
  if(signal?.aborted)throw signal.reason??error;
  if(error instanceof Error&&['model_metadata_invalid','model_metadata_unavailable'].includes(error.message))throw error;
  throw Error('model_metadata_unavailable');
 }finally{if(abort)bounded.removeEventListener('abort',abort);}
}
function validateMetadata(value:unknown,route:{provider:string;model:string}){
 if(!plain(value)||Object.keys(value).some(key=>!['context','defaultMaxTokens','id','inputModalities','name','provider','reasoning'].includes(key))
  ||value.provider!==route.provider||value.id!==route.model)return;
 const result:Record<string,unknown>={provider:route.provider,id:route.model};
 if(value.name!==undefined){if(typeof value.name!=='string'||!value.name.trim()||value.name.length>256)return;result.name=value.name;}
 if(value.context!==undefined){const context=value.context;if(!plain(context)||!exact(context,['contextWindow'])||!Number.isSafeInteger(context.contextWindow)||Number(context.contextWindow)<1)return;result.context={contextWindow:context.contextWindow};}
 if(value.defaultMaxTokens!==undefined){if(!Number.isSafeInteger(value.defaultMaxTokens)||Number(value.defaultMaxTokens)<1)return;result.defaultMaxTokens=value.defaultMaxTokens;}
 if(value.reasoning!==undefined){
  const reasoning=value.reasoning;if(!plain(reasoning)||!(exact(reasoning,['efforts'])||exact(reasoning,['efforts','defaultEffort']))||!Array.isArray(reasoning.efforts)||reasoning.efforts.length>64)return;
  const efforts:string[]=[];for(const effort of reasoning.efforts){if(!exact(effort,['id'])||typeof effort.id!=='string'||!ID.test(effort.id)||efforts.includes(effort.id))return;efforts.push(effort.id);}
  const defaultEffort=reasoning.defaultEffort;
  if(defaultEffort!==undefined&&(typeof defaultEffort!=='string'||!efforts.includes(defaultEffort)))return;
  result.reasoning={efforts:efforts.map(id=>({id})),...(defaultEffort===undefined?{}:{defaultEffort})};
 }
 if(value.inputModalities!==undefined){
  if(!Array.isArray(value.inputModalities)||value.inputModalities.length>16||value.inputModalities.some(item=>typeof item!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(item))||new Set(value.inputModalities).size!==value.inputModalities.length)return;
  result.inputModalities=[...value.inputModalities];
 }
 return result;
}

/** Validates the authenticated DSH snapshot and returns only immutable route identity plus its content digest. */
export async function readHostTrustedModelMetadata(client:TrustedModelMetadataClient|undefined,route:{provider:string;model:string},signal?:AbortSignal):Promise<TrustedModelMetadataBinding|undefined>{
 if(!client||typeof client.trustedModelMetadata!=='function')throw Error('model_metadata_unavailable');
 if(!plain(route)||Object.keys(route).sort().join(',')!=='model,provider'||typeof route.provider!=='string'||!ID.test(route.provider)||typeof route.model!=='string'||!MODEL.test(route.model))throw Error('model_metadata_invalid');
 const bounded=AbortSignal.any([AbortSignal.timeout(2000),...(signal?[signal]:[])]);
 let abort:(()=>void)|undefined;
 try{
  bounded.throwIfAborted();const read=client.trustedModelMetadata.bind(client),pending=Promise.resolve().then(()=>{bounded.throwIfAborted();return read({provider:route.provider,model:route.model},bounded);});
  const timeout=new Promise<never>((_resolve,reject)=>{abort=()=>reject(bounded.reason);bounded.addEventListener('abort',abort,{once:true});});
  const value=await Promise.race([pending,timeout]);bounded.throwIfAborted();
  if(!plain(value))throw Error('model_metadata_invalid');
  if(value.state==='unavailable'){
   if(exact(value,['execution_authorized','protocol','reason','state'])&&value.protocol===1&&value.execution_authorized===false&&value.reason==='FEATURE_DISABLED')return undefined;
   throw Error('model_metadata_unavailable');
  }
  if(value.state==='changed')throw Error('model_metadata_changed');
  const keys=['digest_revision','execution_authorized','id','metadata','metadata_digest','protocol','provider','source_config_revision','state','upstream_revision'];
  if(!exact(value,keys)||value.protocol!==1||value.state!=='ready'||value.execution_authorized!==false||value.digest_revision!==DIGEST_REVISION
   ||value.provider!==route.provider||value.id!==route.model||typeof value.metadata_digest!=='string'||!HASH.test(value.metadata_digest)
   ||value.source_config_revision!==null&&!safeRevision(value.source_config_revision)||value.upstream_revision!==null&&!safeRevision(value.upstream_revision))throw Error('model_metadata_invalid');
  const metadata=validateMetadata(value.metadata,route);if(!metadata)throw Error('model_metadata_invalid');
  const digest=createHash('sha256').update(canonical({digest_revision:DIGEST_REVISION,metadata})).digest('hex');
  if(!timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(value.metadata_digest,'hex')))throw Error('model_metadata_invalid');
  return Object.freeze({provider:route.provider,model:route.model,digest_revision:DIGEST_REVISION,metadata_digest:digest,
   source_config_revision:value.source_config_revision as string|null,upstream_revision:value.upstream_revision as string|null});
 }catch(error){
  if(signal?.aborted)throw signal.reason??error;
  const message=error instanceof Error?error.message:'';
  if(message==='model_metadata_changed'||message==='model_metadata_invalid')throw error;
  throw Error('model_metadata_unavailable');
 }finally{if(abort)bounded.removeEventListener('abort',abort);}
}

export function acceptedModelMetadataBindings(value:unknown,routes:Array<{provider:string;model:string}>):TrustedModelMetadataBinding[]{
 if(!Array.isArray(value)||value.length!==routes.length)throw Error('model_metadata_invalid');
 const normalized=value.map((item,index)=>{
  const route=routes[index];if(!route||!plain(item)||Object.keys(item).sort().join(',')!=='digest_revision,metadata_digest,model,provider,source_config_revision,upstream_revision'
   ||item.provider!==route.provider||item.model!==route.model||item.digest_revision!==DIGEST_REVISION||typeof item.metadata_digest!=='string'||!HASH.test(item.metadata_digest)
   ||item.source_config_revision!==null&&!safeRevision(item.source_config_revision)||item.upstream_revision!==null&&!safeRevision(item.upstream_revision))throw Error('model_metadata_invalid');
  return Object.freeze({provider:route.provider,model:route.model,digest_revision:DIGEST_REVISION,metadata_digest:item.metadata_digest,
   source_config_revision:item.source_config_revision as string|null,upstream_revision:item.upstream_revision as string|null});
 });
 const keys=normalized.map(item=>JSON.stringify([item.provider,item.model]));if(new Set(keys).size!==keys.length)throw Error('model_metadata_invalid');
 return normalized;
}
