import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';

const SOURCE_SHA256='d18d8ae4c8d961e628708c1e4698e09716a0ebb80e55a672e0bde1029bec1155';
const fail=()=>{throw Error('native_model_dispatch_guard_unavailable');};

/** Keep native preparation, projections, middleware and failure/iterator ownership. */
export function installNativeModelDispatchGuard({llm,installAnchor,prepareDispatch}){
 if(typeof installAnchor!=='string'||typeof prepareDispatch!=='function')fail();
 const require=createRequire(installAnchor),entry=require.resolve('@deepseek-ai/dsh-llm');
 const source=readFileSync(entry,'utf8').replace(/\r\n/g,'\n');
 const manifest=JSON.parse(readFileSync(join(dirname(entry),'..','package.json'),'utf8'));
 const {LlmRuntime}=require('@deepseek-ai/dsh-llm');
 const runtime=llm?.[Symbol.for('cordis.original')]??llm;
 if(manifest.name!=='@deepseek-ai/dsh-llm'||manifest.version!=='0.2.1-rc.2'
  ||createHash('sha256').update(source).digest('hex')!==SOURCE_SHA256
  ||!(runtime instanceof LlmRuntime)||!Object.isExtensible(runtime))fail();
 const originals={};
 for(const method of ['adapterStream','normalizeModelInfo','forAdapter']){
  if(Object.hasOwn(runtime,method)||typeof LlmRuntime.prototype[method]!=='function'
   ||runtime[method]!==LlmRuntime.prototype[method])fail();
  originals[method]=runtime[method];
 }
 const storage=new AsyncLocalStorage(),frames=new Set();let stopped=false;
 const restore=()=>{
  if(!stopped||frames.size)return;
  for(const [method,value] of Object.entries(methods)){
   if(Object.getOwnPropertyDescriptor(runtime,method)?.value===value)delete runtime[method];
  }
  storage.disable();
 };
 const advance=async(frame,iterator,method,value)=>{
  try{
   const result=await storage.run(frame,()=>iterator[method](value));
   if(result.done){frames.delete(frame);restore();}
   return result;
  }catch(error){frames.delete(frame);restore();throw error;}
 };
 const methods={
  adapterStream(options,prepared){
   const frame={check:prepareDispatch(options),modelInfo:prepared?.modelInfo};
   const iterator=originals.adapterStream.call(this,options,prepared);
   frames.add(frame);
   // A generator runs on next/return/throw, after its factory has returned.
   return {
    [Symbol.asyncIterator](){return this;},
    next(value){return advance(frame,iterator,'next',value);},
    return(value){return advance(frame,iterator,'return',value);},
    throw(error){return advance(frame,iterator,'throw',error);},
   };
  },
  normalizeModelInfo(...args){
   const info=originals.normalizeModelInfo.apply(this,args);
   const frame=storage.getStore();
   if(frame)frame.modelInfo=info;
   return info;
  },
  forAdapter(options,adapter){
   const frame=storage.getStore();
   frame?.check?.({options,modelInfo:frame.modelInfo,stopped});
   return originals.forAdapter.call(this,options,adapter);
  },
 };
 for(const [method,value] of Object.entries(methods)){
  Object.defineProperty(runtime,method,{value,writable:true,configurable:true});
 }
 // Active native iterators retain their guard until completion or explicit close.
 return {dispose(){stopped=true;restore();}};
}
