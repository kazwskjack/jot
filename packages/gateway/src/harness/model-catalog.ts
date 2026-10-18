import type {Capabilities} from '../../contracts/types.ts';
export interface ModelCatalogClient{modelCatalog(signal:AbortSignal):Promise<unknown>}
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** A slow/unavailable directory cannot stall all capability discovery indefinitely. */
export async function readHostModelCatalog(client:ModelCatalogClient|undefined,signal?:AbortSignal):Promise<Capabilities['models']>{
 if(!client)return[];
 const bounded=AbortSignal.any([AbortSignal.timeout(2000),...(signal?[signal]:[])]);
 let abort:(()=>void)|undefined;
 try{
  bounded.throwIfAborted();
  const pending=Promise.resolve().then(()=>{bounded.throwIfAborted();return client.modelCatalog(bounded);});
  const expired=new Promise<never>((_resolve,reject)=>{abort=()=>reject(bounded.reason);bounded.addEventListener('abort',abort,{once:true});});
  const value=await Promise.race([pending,expired]);bounded.throwIfAborted();
  if(!plain(value)||Object.keys(value).sort().join(',')!=='models,protocol,ready'||value.protocol!==1||value.ready!==true||!Array.isArray(value.models)||value.models.length>4096)return[];
  const seen=new Set<string>(),result:Capabilities['models']=[];
  for(const row of value.models){
   if(!plain(row)||Object.keys(row).sort().join(',')!=='model,provider,reasoning_output,supported_reasoning_efforts'
    ||typeof row.provider!=='string'||!ID.test(row.provider)||typeof row.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(row.model)
    ||typeof row.reasoning_output!=='string'||!['provider','summary','none'].includes(row.reasoning_output)||!Array.isArray(row.supported_reasoning_efforts)||row.supported_reasoning_efforts.length>64
    ||row.supported_reasoning_efforts.some(id=>typeof id!=='string'||!ID.test(id))||new Set(row.supported_reasoning_efforts).size!==row.supported_reasoning_efforts.length)return[];
   const key=JSON.stringify([row.provider,row.model]);if(seen.has(key))return[];seen.add(key);
   result.push({provider:row.provider,model:row.model,reasoning_output:row.reasoning_output as 'provider'|'summary'|'none',supported_reasoning_efforts:[...row.supported_reasoning_efforts] as string[]});
  }
  return result;
 }catch{return[];}finally{if(abort)bounded.removeEventListener('abort',abort);}
}
