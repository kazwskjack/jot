import {observePreparedModelMetadata} from './trusted-model-metadata.js';
const positive=value=>Number.isSafeInteger(value)&&value>0;
const fail=()=>{throw Error('model_compatibility_unconfirmed');};

/** Check the captured native model and raw inputs before native projections dispatch. */
export function assertPreparedModelCapabilities({route,metadata,sessionId,options,originalOptions,modelInfo}){
 if(options.sessionId!==sessionId||options.provider!==route.provider||options.model!==route.model
  ||options.reasoningEffort!==route.reasoning_effort)fail();
 const observed=observePreparedModelMetadata(modelInfo,{provider:options.provider,model:options.model});
 if(observed.state!=='ready'||observed.metadata_digest!==metadata?.metadata_digest
  ||observed.digest_revision!==metadata?.digest_revision)fail();
 if(!Array.isArray(originalOptions.messages))fail();
 const has=type=>originalOptions.messages.some(message=>Array.isArray(message?.content)&&message.content.some(block=>block?.type===type));
 const hasText=has('text')||typeof originalOptions.system==='string'&&originalOptions.system.length>0;
 if(has('image')&&!observed.metadata.inputModalities?.includes('image')
  ||hasText&&observed.metadata.inputModalities&&!observed.metadata.inputModalities.includes('text'))fail();
 const limit=observed.metadata.context?.contextWindow,output=options.maxTokens??observed.metadata.defaultMaxTokens;
 if(!positive(limit)||!positive(output)||output>limit)fail();
 return observed.metadata;
}

/** Main calls use the native Session meter; auxiliary prefix sizing stays native. */
export function assertPreparedModelCompatibility({route,metadata,session,tokenMeter,options,originalOptions,modelInfo}){
 const info=assertPreparedModelCapabilities({route,metadata,sessionId:session.id,options,originalOptions,modelInfo});
 const measured=tokenMeter.measure(session),output=options.maxTokens??info.defaultMaxTokens;
 if(!Number.isSafeInteger(measured?.totalTokens)||measured.totalTokens<0
  ||!Number.isSafeInteger(measured.totalTokens+output)||measured.totalTokens+output>info.context.contextWindow)fail();
}
