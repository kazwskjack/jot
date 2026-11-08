const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MODEL=/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const MAX_ROUTES=4096,MAX_FALLBACKS=3,DEFAULT_MAX_AGE_MS=60_000;
const keyOf=(provider,model)=>JSON.stringify([provider,model]);
function route(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='model,provider'
  ||typeof value.provider!=='string'||!ID.test(value.provider)||typeof value.model!=='string'||!MODEL.test(value.model))return;
 return Object.freeze({provider:value.provider,model:value.model});
}
function routePolicy(primaryValue,fallbackValues){
 const primary=route(primaryValue);
 if(!primary||!Array.isArray(fallbackValues)||fallbackValues.length>MAX_FALLBACKS)throw Error('model_route_policy_invalid');
 const seen=new Set([keyOf(primary.provider,primary.model)]),fallbacks=[];
 for(const value of fallbackValues){
  const candidate=route(value),key=candidate&&keyOf(candidate.provider,candidate.model);
  if(!candidate||seen.has(key))throw Error('model_route_policy_invalid');
  seen.add(key);fallbacks.push(candidate);
 }
 return{primary,fallbacks};
}

/** Passive health comes only from complete native DSH model-stream outcomes. */
export function createModelRouteHealth({ctx,now=Date.now,maxAgeMs=DEFAULT_MAX_AGE_MS}={}){
 if(typeof ctx?.on!=='function'||typeof now!=='function'||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1||maxAgeMs>10*60_000)
  throw Error('model_route_health_config_invalid');
 const entries=new Map();
 const observe=(selected,status)=>{
  const instant=now();if(!Number.isSafeInteger(instant)||instant<0)return;
  const key=keyOf(selected.provider,selected.model);
  if(!entries.has(key)&&entries.size>=MAX_ROUTES)entries.delete(entries.keys().next().value);
  entries.delete(key);entries.set(key,Object.freeze({status,observed_at:instant,expires_at:instant+maxAgeMs}));
 };
 const read=(provider,model)=>{
  const selected=route({provider,model});if(!selected)return Object.freeze({status:'unknown',observed_at:null,expires_at:null});
  const saved=entries.get(keyOf(selected.provider,selected.model));if(!saved)return Object.freeze({status:'unknown',observed_at:null,expires_at:null});
  const instant=now();if(!Number.isSafeInteger(instant)||instant<0||instant<saved.observed_at||instant>=saved.expires_at)
   return Object.freeze({status:'stale',observed_at:saved.observed_at,expires_at:saved.expires_at});
  return saved;
 };
 const select=(primaryValue,fallbackValues=[])=>{
  const{primary,fallbacks}=routePolicy(primaryValue,fallbackValues);
  if(read(primary.provider,primary.model).status!=='unhealthy')return primary;
  return fallbacks.find(candidate=>read(candidate.provider,candidate.model).status!=='unhealthy')??null;
 };
 const listener=(options,next)=>{
  const selected=route({provider:options?.provider,model:options?.model});
  if(!selected||typeof next!=='function')return next();
  return(async function*(){
   let finish;
   try{
    for await(const chunk of next()){
     if(chunk?.type==='finish')finish=chunk.reason;
     yield chunk;
    }
    if(options.signal?.aborted||finish?.kind==='aborted')return;
    if(finish?.kind==='error')observe(selected,'unhealthy');
    else if(['stop','tool-calls','max-tokens'].includes(finish?.kind))observe(selected,'healthy');
    else observe(selected,'unhealthy');
   }catch(error){
    if(!options.signal?.aborted)observe(selected,'unhealthy');
    throw error;
   }
  })();
 };
 const remove=ctx.on('llm/stream',listener);
 let disposed=false;
 return Object.freeze({read,select,dispose(){if(disposed)return;disposed=true;if(typeof remove==='function')remove();entries.clear();}});
}
