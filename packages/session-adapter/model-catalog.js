const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MODEL=/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const unavailable=()=>({protocol:1,ready:false,models:[]});
function wait(operation,signal){
 const pending=Promise.resolve(operation);if(signal.aborted){pending.catch(()=>{});signal.throwIfAborted();}
 return new Promise((resolve,reject)=>{const abort=()=>{cleanup();reject(signal.reason);},cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});pending.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});});
}
async function batches(items,read){const rows=[];for(let i=0;i<items.length;i+=8)rows.push(...await Promise.all(items.slice(i,i+8).map(read)));return rows;}
/** Detached advisory metadata only. A catalog entry never authorizes a model call. */
export function createModelCatalogReader({llm,enabled=false}){
 return async(signal)=>{
  if(!enabled)return unavailable();
  const bounded=AbortSignal.any([AbortSignal.timeout(2000),...(signal?[signal]:[])]);
  try{
   if(typeof llm?.listProviders!=='function'||typeof llm?.listModels!=='function'||typeof llm?.resolveModelInfo!=='function')return unavailable();
   const providers=await wait(llm.listProviders(),bounded);
   if(!Array.isArray(providers)||providers.length>64||providers.some(row=>typeof row?.id!=='string'||!ID.test(row.id))||new Set(providers.map(row=>row.id)).size!==providers.length)return unavailable();
   const groups=await batches(providers,async provider=>{
    bounded.throwIfAborted();const rows=await wait(llm.listModels(provider.id),bounded);
    if(!Array.isArray(rows)||rows.length>4096)throw Error('catalog_invalid');
    return rows.map(row=>{if(typeof row?.id!=='string'||!MODEL.test(row.id)||row.provider!==undefined&&row.provider!==provider.id)throw Error('catalog_invalid');return{provider:provider.id,model:row.id};});
   });
   const models=groups.flat();if(models.length>4096||new Set(models.map(row=>JSON.stringify(row))).size!==models.length)return unavailable();
   const result=await batches(models,async row=>{
    bounded.throwIfAborted();const resolved=await wait(llm.resolveModelInfo(row.provider,row.model,bounded),bounded);
    if(resolved?.provider!==row.provider||resolved.id!==row.model)throw Error('catalog_invalid');
    const efforts=resolved.reasoning?.efforts?.map(effort=>effort.id)??[];
    if(!Array.isArray(efforts)||efforts.length>64||efforts.some(id=>typeof id!=='string'||!ID.test(id))||new Set(efforts).size!==efforts.length)throw Error('catalog_invalid');
    // Effort metadata alone does not prove that reasoning deltas are exposed.
    return{...row,reasoning_output:'none',supported_reasoning_efforts:efforts};
   });
   bounded.throwIfAborted();return{protocol:1,ready:true,models:result};
  }catch{return unavailable();}
 };
}
