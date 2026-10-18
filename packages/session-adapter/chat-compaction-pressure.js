import {isDeepStrictEqual} from 'node:util';
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const route=v=>v&&typeof v.provider==='string'&&v.provider.length>0&&typeof v.model==='string'&&v.model.length>0;
function cancellable(value,signal){
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(value).then(result=>{signal.removeEventListener('abort',abort);signal.aborted?reject(signal.reason):resolve(result);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  if(signal.aborted)abort();
 });
}
/** Advisory only: price the actual official effective request surface. No
 * Agent resolution, idle certification, inference, persistence or admission.
 * policy must be the host's resolved exact-target policy, not browser input.
 * The threshold mirrors pinned dsh-compaction-basic 0.2.1-rc.2: minimum of
 * window ratio and window minus effective completion reservation/headroom. */
export async function inspectChatCompactionPressure({session,expectedModel,policy,tokenMeter,llm,signal}){
 if(!(signal instanceof AbortSignal))throw Error('chat_compaction_signal_required');
 signal.throwIfAborted();
 const result=(reason,extra={})=>Object.freeze({protocol:1,decision:'skip',reason,...extra,execution_authorized:false});
 try{
  if(!route(expectedModel)||typeof session?.requestHeader!=='function')return result('ROUTE_UNCONFIRMED');
  const header=structuredClone(session.requestHeader()),config=header?.config,seq=session.seq;
  if(!route(config)||config.provider!==expectedModel.provider||config.model!==expectedModel.model)return result('ROUTE_UNCONFIRMED');
  // Require explicit resolved host policy; never guess defaults or capacity.
  if(!integer(seq)||!policy||!Number.isFinite(policy.thresholdRatio)||policy.thresholdRatio<=0||policy.thresholdRatio>1||!integer(policy.headroomTokens)
   ||typeof tokenMeter?.measure!=='function'||typeof llm?.resolveModelInfo!=='function')return result('METADATA_UNAVAILABLE');
  const resolvedPolicy=structuredClone(policy),first=structuredClone(tokenMeter.measure(session));
  if(!integer(first.totalTokens)||!integer(first.logRevision))return result('METADATA_UNAVAILABLE');
  const info=await cancellable(llm.resolveModelInfo(config.provider,config.model,signal),signal);signal.throwIfAborted();
  const second=tokenMeter.measure(session);
  if(session.seq!==seq||!isDeepStrictEqual(session.requestHeader(),header)||!isDeepStrictEqual(policy,resolvedPolicy)||!isDeepStrictEqual(first,second))return result('STATE_CHANGED');
  const window=info?.context?.contextWindow,declaredDefault=info?.defaultMaxTokens;
  if(!integer(window)||window===0||declaredDefault!==undefined&&!integer(declaredDefault)||config.maxTokens!==undefined&&!integer(config.maxTokens))return result('METADATA_UNAVAILABLE');
  const reserved=config.maxTokens??declaredDefault??0;
  const available=window-reserved-resolvedPolicy.headroomTokens;
  if(available<=0)return result('METADATA_UNAVAILABLE');
  const threshold=Math.floor(Math.min(window*resolvedPolicy.thresholdRatio,available));
  if(threshold<=0)return result('METADATA_UNAVAILABLE');
  return result(first.totalTokens<threshold?'LOW_PRESSURE':null,{decision:first.totalTokens<threshold?'skip':'needed',total_tokens:first.totalTokens,threshold_tokens:threshold,context_window:window,reserved_completion_tokens:reserved,headroom_tokens:resolvedPolicy.headroomTokens,log_revision:first.logRevision});
 }catch(error){signal.throwIfAborted();return result('METADATA_UNAVAILABLE');}
}
