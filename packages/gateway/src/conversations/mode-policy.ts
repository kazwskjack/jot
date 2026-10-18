import {createHash} from 'node:crypto';
import {canonicalModelJson} from './model-policy.ts';
export type ConversationMode='chat'|'work';
export type ChatModePolicy={protocol:1;mode:'chat';model:{provider:string;model:string};thinking:'disabled';preset_id:'jot-chat';preset_revision:string;context_revision:string};
export interface ConversationModeClient{
 conversationModeReadiness(signal:AbortSignal):Promise<unknown>;
 conversationGoal?(sessionId:string,body?:Record<string,unknown>,signal?:AbortSignal):Promise<Record<string,unknown>>;
 observeNativeIdle?(sessionId:string,signal?:AbortSignal):Promise<unknown>;
}
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export function conversationMode(value:unknown):ConversationMode{if(value!=='chat'&&value!=='work')throw Error('conversation_mode_invalid');return value;}
export function chatModePolicy(value:unknown):ChatModePolicy{
 if(!plain(value)||Object.keys(value).sort().join(',')!=='context_revision,mode,model,preset_id,preset_revision,protocol,thinking'
  ||value.protocol!==1||value.mode!=='chat'||value.thinking!=='disabled'||value.preset_id!=='jot-chat'
  ||typeof value.context_revision!=='string'||!ID.test(value.context_revision)||typeof value.preset_revision!=='string'||!ID.test(value.preset_revision)
  ||!plain(value.model)||Object.keys(value.model).sort().join(',')!=='model,provider'||typeof value.model.provider!=='string'||!ID.test(value.model.provider)
  ||typeof value.model.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(value.model.model))throw Error('chat_mode_unavailable');
 return structuredClone(value) as ChatModePolicy;
}
export const policyHash=(value:string)=>createHash('sha256').update(value).digest('hex');
export type ExecutionPolicy=Record<string,unknown>&{protocol:1;mode:ConversationMode;preset_id:string;preset_revision:string;context_revision:string;thinking:'provider'|'disabled';conversation_version:number;model_policy_sha256:string};
export function executionPolicy(value:unknown,modelPolicy?:string):ExecutionPolicy{
 const invalid=():never=>{throw Error('conversation_mode_policy_invalid');};
 if(!plain(value)||value.protocol!==1||!Number.isSafeInteger(value.conversation_version)||Number(value.conversation_version)<1||typeof value.model_policy_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.model_policy_sha256))return invalid();
 const {conversation_version,model_policy_sha256,...base}=value;
 if(base.mode==='chat')chatModePolicy(base);
 else if(Object.keys(base).sort().join(',')!=='context_revision,mode,preset_id,preset_revision,protocol,thinking'||base.mode!=='work'||base.thinking!=='provider'||['preset_id','preset_revision','context_revision'].some(key=>typeof base[key]!=='string'||!ID.test(base[key] as string)))return invalid();
 if(modelPolicy!==undefined){
  if(policyHash(modelPolicy)!==model_policy_sha256)return invalid();
  const model=JSON.parse(modelPolicy);if(model?.conversation_version!==conversation_version||base.mode==='chat'&&canonicalModelJson(model.model)!==canonicalModelJson(base.model))return invalid();
 }
 return structuredClone(value) as ExecutionPolicy;
}
export function acceptedExecutionPolicy(mode:ConversationMode,version:number,modelPolicy:string,workPreset:string,chat?:ChatModePolicy){
 if(mode==='chat')return canonicalModelJson({...chatModePolicy(chat),conversation_version:version,model_policy_sha256:policyHash(modelPolicy)});
 if(!ID.test(workPreset))throw Error('conversation_mode_policy_invalid');
 return canonicalModelJson({protocol:1,mode:'work',thinking:'provider',preset_id:workPreset,preset_revision:'official-standard-v1',context_revision:'work-native-v1',conversation_version:version,model_policy_sha256:policyHash(modelPolicy)});
}
export async function readChatModePolicy(client:ConversationModeClient|undefined,signal?:AbortSignal):Promise<ChatModePolicy|undefined>{
 if(!client)return;
 const bounded=AbortSignal.any([AbortSignal.timeout(2000),...(signal?[signal]:[])]);let abort:(()=>void)|undefined;
 try{
  bounded.throwIfAborted();const pending=Promise.resolve().then(()=>{bounded.throwIfAborted();return client.conversationModeReadiness(bounded);});
  const timeout=new Promise<never>((_resolve,reject)=>{abort=()=>reject(bounded.reason);bounded.addEventListener('abort',abort,{once:true});});
  const value=await Promise.race([pending,timeout]);bounded.throwIfAborted();
  if(!plain(value)||Object.keys(value).sort().join(',')!=='policy,protocol,ready'||value.protocol!==1||value.ready!==true)return;
  return chatModePolicy(value.policy);
 }catch{return;}finally{if(abort)bounded.removeEventListener('abort',abort);}
}
