import {createHash} from 'node:crypto';

const DIGEST_REVISION='jot-model-metadata-v1';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MODEL=/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const SHA256=/^[a-f0-9]{64}$/;
const own=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const safeRevision=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
const safeReason=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const unavailable=reason=>({protocol:1,state:'unavailable',reason,execution_authorized:false});
const changed=reason=>({protocol:1,state:'changed',reason,execution_authorized:false});

function canonical(value){
 return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
}

function projectMetadata(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const allowed=['context','defaultMaxTokens','id','inputModalities','name','provider','reasoning'];
 if(Object.keys(value).some(key=>!allowed.includes(key))||typeof value.provider!=='string'||!ID.test(value.provider)
  ||typeof value.id!=='string'||!MODEL.test(value.id)
  ||value.name!==undefined&&(typeof value.name!=='string'||!value.name.trim()||value.name.length>256))return;
 const result={provider:value.provider,id:value.id,name:value.name};
 if(value.name===undefined)delete result.name;
 if(value.context!==undefined){
  if(!own(value.context,['contextWindow'])||!Number.isSafeInteger(value.context.contextWindow)||value.context.contextWindow<1)return;
  result.context={contextWindow:value.context.contextWindow};
 }
 if(value.defaultMaxTokens!==undefined){
  if(!Number.isSafeInteger(value.defaultMaxTokens)||value.defaultMaxTokens<1)return;
  result.defaultMaxTokens=value.defaultMaxTokens;
 }
 if(value.reasoning!==undefined){
  if(!(own(value.reasoning,['efforts'])||own(value.reasoning,['efforts','defaultEffort']))||!Array.isArray(value.reasoning.efforts)||value.reasoning.efforts.length>64)return;
  const efforts=[];
  for(const effort of value.reasoning.efforts){
   if(!own(effort,['id'])||typeof effort.id!=='string'||!ID.test(effort.id)||efforts.some(item=>item.id===effort.id))return;
   efforts.push({id:effort.id});
  }
  const defaultEffort=value.reasoning.defaultEffort;
  if(defaultEffort!==undefined&&(typeof defaultEffort!=='string'||!efforts.some(effort=>effort.id===defaultEffort)))return;
  result.reasoning={efforts,...(defaultEffort===undefined?{}:{defaultEffort})};
 }
 if(value.inputModalities!==undefined){
  if(!Array.isArray(value.inputModalities)||value.inputModalities.length>16
   ||value.inputModalities.some(item=>typeof item!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(item))
   ||new Set(value.inputModalities).size!==value.inputModalities.length)return;
  result.inputModalities=[...value.inputModalities];
 }
 return result;
}

function validUnavailable(value){
 if(!own(value,['execution_authorized','protocol','reason','state'])||value.protocol!==1||value.execution_authorized!==false
  ||!['unavailable','changed'].includes(value.state)||!safeReason(value.reason))return;
 return value.state==='changed'?changed(value.reason):unavailable(value.reason);
}

function validate(value,route){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.protocol!==1)return unavailable('INVALID_ENVELOPE');
 if(value.state==='unavailable'||value.state==='changed')return validUnavailable(value)??unavailable('INVALID_ENVELOPE');
 const keys=['digest_revision','id','metadata','metadata_digest','protocol','provider','source_config_revision','state','upstream_revision'];
 if(!own(value,keys)&&!own(value,[...keys,'execution_authorized'])||value.execution_authorized!==undefined&&value.execution_authorized!==false
  ||value.state!=='ready'||value.digest_revision!==DIGEST_REVISION
  ||typeof value.provider!=='string'||!ID.test(value.provider)||typeof value.id!=='string'||!MODEL.test(value.id)
  ||typeof value.metadata_digest!=='string'||!SHA256.test(value.metadata_digest)
  ||value.source_config_revision!==null&&!safeRevision(value.source_config_revision)
  ||value.upstream_revision!==null&&!safeRevision(value.upstream_revision))return unavailable('INVALID_ENVELOPE');
 if(value.provider!==route.provider||value.id!==route.model)return changed('ROUTE_MISMATCH');
 const metadata=projectMetadata(value.metadata);
 if(!metadata||metadata.provider!==route.provider||metadata.id!==route.model)return unavailable('INVALID_ENVELOPE');
 const expected=createHash('sha256').update(canonical({digest_revision:DIGEST_REVISION,metadata})).digest('hex');
 if(expected!==value.metadata_digest)return unavailable('INVALID_ENVELOPE');
 return{protocol:1,state:'ready',provider:value.provider,id:value.id,metadata,metadata_digest:expected,
  digest_revision:DIGEST_REVISION,source_config_revision:value.source_config_revision,
  upstream_revision:value.upstream_revision,execution_authorized:false};
}

function readWithSignal(reader,route,signal){
 signal?.throwIfAborted();
 const pending=Promise.resolve().then(()=>reader(route,signal));
 if(!signal)return pending;
 return new Promise((resolve,reject)=>{
  const cleanup=()=>signal.removeEventListener('abort',abort);
  const abort=()=>{cleanup();reject(signal.reason??new Error('trusted_model_metadata_aborted'));};
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted){abort();pending.catch(()=>{});return;}
  pending.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
 });
}

/** Private consumer seam. It validates a trusted envelope but never authorizes a model call. */
export function createTrustedModelMetadataConsumer({readTrustedModelMetadata,enabled=false}={}){
 return async(route,signal)=>{
  if(!enabled||typeof readTrustedModelMetadata!=='function')return unavailable('PRODUCER_UNAVAILABLE');
  if(!own(route,['model','provider'])||typeof route.provider!=='string'||!ID.test(route.provider)
   ||typeof route.model!=='string'||!MODEL.test(route.model))return unavailable('ROUTE_INVALID');
  try{
   const value=await readWithSignal(readTrustedModelMetadata,Object.freeze({provider:route.provider,model:route.model}),signal);
   signal?.throwIfAborted();
   return validate(value,route);
  }catch(error){
   if(signal?.aborted)throw(signal.reason??error);
   return unavailable('PRODUCER_UNAVAILABLE');
  }
 };
}

/** Reads only DSH's resolved model metadata. The digest is the content revision;
 * this SDK seam exposes no independently verifiable provider-config revision. */
export function createTrustedModelMetadataProducer({llm,enabled=false}={}){
 return async(route,signal)=>{
  if(!enabled)return unavailable('FEATURE_DISABLED');
  if(typeof llm?.resolveModelInfo!=='function')return unavailable('PRODUCER_UNAVAILABLE');
  if(!own(route,['model','provider'])||typeof route.provider!=='string'||!ID.test(route.provider)
   ||typeof route.model!=='string'||!MODEL.test(route.model))return unavailable('ROUTE_INVALID');
  const bounded=AbortSignal.any([AbortSignal.timeout(2000),...(signal?[signal]:[])]);
  try{
   const info=await readWithSignal((_route,currentSignal)=>llm.resolveModelInfo(route.provider,route.model,currentSignal),route,bounded);
   bounded.throwIfAborted();
   if(info?.provider!==route.provider||info?.id!==route.model)return changed('ROUTE_MISMATCH');
   // Project known SDK fields before validation; never serialize adapter config,
   // credentials, transport settings or other unrelated runtime metadata.
   const candidate={provider:info.provider,id:info.id,
    ...(info.name===undefined?{}:{name:info.name}),
    ...(info.context===undefined?{}:{context:info.context}),
    ...(info.defaultMaxTokens===undefined?{}:{defaultMaxTokens:info.defaultMaxTokens}),
    ...(info.reasoning===undefined?{}:{reasoning:{efforts:Array.isArray(info.reasoning?.efforts)
     ?info.reasoning.efforts.map(effort=>({id:effort?.id})):info.reasoning?.efforts,
     ...(info.reasoning?.defaultEffort===undefined?{}:{defaultEffort:info.reasoning.defaultEffort})}}),
    ...(info.inputModalities===undefined?{}:{inputModalities:info.inputModalities})};
   const metadata=projectMetadata(candidate);if(!metadata)return unavailable('INVALID_METADATA');
   return validate({protocol:1,state:'ready',provider:route.provider,id:route.model,metadata,
    metadata_digest:createHash('sha256').update(canonical({digest_revision:DIGEST_REVISION,metadata})).digest('hex'),
    digest_revision:DIGEST_REVISION,source_config_revision:null,upstream_revision:null},route);
  }catch(error){
   if(bounded.aborted)throw(bounded.reason??error);
   return unavailable('PRODUCER_UNAVAILABLE');
  }
 };
}
