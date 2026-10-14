import {randomUUID} from 'node:crypto';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const kinds={universe_read_page:'read_page',universe_browse:'browse',universe_execute:'execute'};
/** Read original execution facts through the existing scoped leaf bridge.
 * Never dispatch a new browser action or accept scope from tool arguments. */
export function createNativeOperationObserver({origin,authorize,fetchImpl=globalThis.fetch}){
 let url;try{url=new URL(origin);}catch{throw Error('native_operation_config_invalid');}
 if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!=='/'||url.search||url.hash||url.username||url.password
  ||typeof authorize!=='function'||typeof fetchImpl!=='function')throw Error('native_operation_config_invalid');
 const endpoint=url.origin+'/v2/native/tool';
 return async function observe(input){
  if(!input||!ID.test(input.sessionRef??'')||!ID.test(input.callId??'')||!Object.hasOwn(kinds,input.toolName??''))throw Error('native_operation_identity_invalid');
  const scope=Object.freeze({sessionRef:input.sessionRef,callId:input.callId,toolName:input.toolName,signal:input.signal});
  const signal=scope.signal?AbortSignal.any([scope.signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000);
  try{
   signal.throwIfAborted();await authorize(scope);signal.throwIfAborted();
   const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},
    body:JSON.stringify({tool:'universe_get_state',arguments:{request_id:scope.callId,after_revision:0,event_limit:100},
     execution:{session_ref:scope.sessionRef,call_id:'closure-'+randomUUID()}}),signal});
   if(!response.ok)throw Error('native_operation_unresolved');
   const value=await response.json();
   if(!value||value.kind!==kinds[scope.toolName]||!Array.isArray(value.items)||value.items.length>100)throw Error('native_operation_unresolved');
   await authorize(scope);signal.throwIfAborted();
   // The registry resolves the original call under the trusted Session scope;
   // its native response uses an operation ID rather than echoing request scope.
   return {session_ref:scope.sessionRef,request_id:scope.callId,operation_id:value.operation_id,revision:value.revision,
    status:value.status,accepted_count:value.accepted_count,items:value.items.map(item=>({item_id:item?.item_id,position:item?.position,status:item?.status}))};
  }catch{scope.signal?.throwIfAborted();throw Error('native_operation_unresolved');}
 };
}
