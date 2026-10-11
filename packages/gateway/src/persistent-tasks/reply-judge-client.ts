import {openSync,closeSync,fstatSync,readSync} from 'node:fs';
import type {ModelBudgetRoute} from '../workbench/model-budget.ts';
import type {ReplyCheckRequest} from './reply-semantic.ts';
type Row=Record<string,any>;
type Fetch=(url:string,init:RequestInit)=>Promise<Response>;
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
function readBounded(path:string,limit:number){
 const fd=openSync(path,'r');try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>limit)throw new Error();const bytes=Buffer.alloc(limit+1);let length=0;while(length<bytes.length){const n=readSync(fd,bytes,length,bytes.length-length,null);if(!n)break;length+=n;}if(length>limit)throw new Error();return new TextDecoder('utf8',{fatal:true}).decode(bytes.subarray(0,length));}finally{closeSync(fd);}
}
/** Chat Completions counts prompt caches inside prompt tokens and reasoning
 * inside completion tokens. Keep these disjoint in the existing ledger.
 * Reference: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create */
function normalizedUsage(value:any,foldUnreportedWrites=false){
 if(!value||!count(value.prompt_tokens)||!count(value.completion_tokens)||!count(value.total_tokens)||value.total_tokens!==value.prompt_tokens+value.completion_tokens)return undefined;
 const read=value.prompt_tokens_details?.cached_tokens,reasoning=value.completion_tokens_details?.reasoning_tokens;
 let write=value.prompt_tokens_details?.cache_write_tokens;
 // This is an accounting bucket, not a claim of zero provider cache writes.
 // Unreported writes remain in input only under explicit equal-rate policy.
 if(write===undefined&&foldUnreportedWrites)write=0;
 if(!count(read)||!count(write)||read+write>value.prompt_tokens||(reasoning!==undefined&&(!count(reasoning)||reasoning>value.completion_tokens)))return undefined;
 return {inputTokens:value.prompt_tokens-read-write,outputTokens:value.completion_tokens,totalTokens:value.total_tokens,cacheReadTokens:read,cacheWriteTokens:write,...(reasoning===undefined?{}:{reasoningTokens:reasoning})};
}
export type ReplyJudgeClient={route:{provider:string;model:string};preflight:(request:ReplyCheckRequest)=>void;invoke:(request:ReplyCheckRequest)=>Promise<{value:unknown;usage:unknown}>};
/** Server-owned optional compatible endpoint. This is an assessor, without
 * tools/session history/recipients; DSH remains the sole task planner. */
export function createReplyJudgeClient(input:unknown,routes:ModelBudgetRoute[],options:{readSecret?:(path:string)=>string;fetch?:Fetch}={}):ReplyJudgeClient{
 let config:Row,url:URL,route:ModelBudgetRoute;
 try{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['provider','model','base_url','api_key_file','max_input_bytes','timeout_ms','response_model_ids','cache_write_policy'].includes(k)))throw new Error();
  config=structuredClone(input as Row);url=new URL(config.base_url);
  const matched=routes.find(r=>r.provider===config.provider&&r.model===config.model);if(!matched||matched.billing)throw new Error();route=structuredClone(matched);
  if(config.cache_write_policy===undefined)config.cache_write_policy='explicit';
  if(!['explicit','input-rate-equivalent'].includes(config.cache_write_policy)
   ||(config.cache_write_policy==='input-rate-equivalent'&&(!count(route.rates.input)||route.rates.cache_write!==route.rates.input)))throw new Error();
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))||!url.pathname.endsWith('/v1')||typeof config.api_key_file!=='string'||!config.api_key_file.trim()||!count(config.max_input_bytes)||config.max_input_bytes<1||config.max_input_bytes>1048576||config.max_input_bytes>route.context_window-route.max_output_tokens||!count(config.timeout_ms)||config.timeout_ms<1000||config.timeout_ms>120000)throw new Error();
  config.response_model_ids??=[config.model];if(!Array.isArray(config.response_model_ids)||config.response_model_ids.length<1||config.response_model_ids.length>16||config.response_model_ids.some((x:unknown)=>typeof x!=='string'||!x||x.length>256))throw new Error();
 }catch{throw new Error('reply_judge_config_invalid');}
 let key:string;
 try{key=(options.readSecret??(path=>readBounded(path,4096)))(config.api_key_file).replace(/[\r\n]+$/,'');}catch{throw new Error('reply_judge_secret_unavailable');}
 if(!key||key.length>4096||/[^\x21-\x7E]/.test(key))throw new Error('reply_judge_secret_invalid');
 const endpoint=`${url.toString().replace(/\/$/,'')}/chat/completions`,fetch=options.fetch??globalThis.fetch;
 const prepare=(request:ReplyCheckRequest)=>{
  const body={model:route.model,messages:[{role:'system',content:request.instructions},{role:'user',content:JSON.stringify({text:request.text,direction:request.direction,sources:request.sources,response_format:request.response_format})}],stream:false,max_completion_tokens:route.max_output_tokens,response_format:{type:'json_object'}};
  const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded,'utf8')>config.max_input_bytes)throw new Error('reply_judge_input_too_large');return encoded;
 };
 return {route:{provider:route.provider,model:route.model},preflight:request=>{prepare(request);},invoke:async request=>{
  const body=prepare(request);const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body,redirect:'error',signal:AbortSignal.timeout(config.timeout_ms)});
  if(!response.ok){await response.body?.cancel();throw new Error('reply_judge_http_failed');}
  const reader=response.body?.getReader();if(!reader)throw new Error('reply_judge_response_missing');const decoder=new TextDecoder('utf8',{fatal:true});let encoded='',bytes=0;
  try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>262144)throw new Error('reply_judge_response_too_large');encoded+=decoder.decode(chunk.value,{stream:true});}encoded+=decoder.decode();}finally{await reader.cancel();}
  let data:Row;try{data=JSON.parse(encoded);}catch{throw new Error('reply_judge_response_invalid');}
  const usage=normalizedUsage(data.usage,config.cache_write_policy==='input-rate-equivalent');let value:unknown=null;
  const choice=Array.isArray(data.choices)&&data.choices.length===1?data.choices[0]:undefined,message=choice?.message;
  if(config.response_model_ids.includes(data.model)&&choice?.finish_reason==='stop'&&message?.role==='assistant'&&!message.refusal&&!message.tool_calls&&!message.function_call&&typeof message.content==='string'&&Buffer.byteLength(message.content,'utf8')<=65536){try{value=JSON.parse(message.content);}catch{/* A billed malformed answer is still not eligible. */}}
  return {value,usage};
 }};
}
export function loadReplyJudgeClient(env:Record<string,string|undefined>,routes:ModelBudgetRoute[],options:{readConfig?:(path:string)=>string;readSecret?:(path:string)=>string;fetch?:Fetch}={}):ReplyJudgeClient|undefined{
 const file=env.GENERAL_AGENT_TASK_REPLY_JUDGE_FILE?.trim();if(!file)return undefined;
 let input:unknown;try{const text=(options.readConfig??(path=>readBounded(path,32768)))(file);if(Buffer.byteLength(text,'utf8')>32768)throw new Error();input=JSON.parse(text);}catch{throw new Error('reply_judge_config_unavailable');}
 return createReplyJudgeClient(input,routes,options);
}
