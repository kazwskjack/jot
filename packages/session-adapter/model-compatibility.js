import {observePreparedModelMetadata} from './trusted-model-metadata.js';
const positive=value=>Number.isSafeInteger(value)&&value>0;
const fail=()=>{throw Error('model_compatibility_unconfirmed');};

/** Check the captured native model and raw inputs before native projections dispatch. */
export function assertPreparedModelCompatibility({route,metadata,session,tokenMeter,options,originalOptions,modelInfo}){
 if(options.sessionId!==session.id||options.provider!==route.provider||options.model!==route.model
  ||options.reasoningEffort!==route.reasoning_effort)fail();
 const observed=observePreparedModelMetadata(modelInfo,{provider:options.provider,model:options.model});
 if(observed.state!=='ready'||observed.metadata_digest!==metadata?.metadata_digest
  ||observed.digest_revision!==metadata?.digest_revision)fail();
 if(!Array.isArray(originalOptions.messages))fail();
 const has=type=>originalOptions.messages.some(message=>Array.isArray(message?.content)&&message.content.some(block=>block?.type===type));
 if(has('image')&&!observed.metadata.inputModalities?.includes('image')
  ||has('text')&&observed.metadata.inputModalities&&!observed.metadata.inputModalities.includes('text'))fail();
 const measured=tokenMeter.measure(session),limit=observed.metadata.context?.contextWindow;
 const output=options.maxTokens??observed.metadata.defaultMaxTokens;
 if(!Number.isSafeInteger(measured?.totalTokens)||measured.totalTokens<0||!positive(limit)||!positive(output)
  ||!Number.isSafeInteger(measured.totalTokens+output)||measured.totalTokens+output>limit)fail();
}
