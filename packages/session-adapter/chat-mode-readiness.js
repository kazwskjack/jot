import {normalizeChatExecutionPolicy} from './ordinary-execution-policy.js';
/** Trusted configured capability only; this read never authenticates a provider
 * or grants native admission, model execution or additional tools. */
export function createChatModeReadiness({enabled=false,policy,mounted,context,web,modelSelection,admission}={}){
 if(typeof enabled!=='boolean')throw Error('chat_mode_readiness_config_invalid');
 if(!enabled)return()=>({protocol:1,ready:false,policy:null});
 let accepted;try{
  accepted=normalizeChatExecutionPolicy(policy);
  if(context!==true||web!==true||modelSelection!==true||admission!==true||mounted?.presetId!==accepted.preset_id||mounted.revision!==accepted.preset_revision)throw Error();
 }catch{throw Error('chat_mode_readiness_config_invalid');}
 return()=>({protocol:1,ready:true,policy:structuredClone(accepted)});
}
