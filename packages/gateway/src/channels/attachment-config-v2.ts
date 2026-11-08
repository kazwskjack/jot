export function channelAttachmentIntakeConfiguration(env:NodeJS.ProcessEnv){
 const flag=env.GENERAL_AGENT_CHANNEL_ATTACHMENTS_ENABLED;
 if(flag!==undefined&&flag!=='true'&&flag!=='false')throw Error('channel_attachment_configuration_invalid');
 if(flag==='true'&&env.GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED!=='true')throw Error('channel_attachment_original_recovery_required');
 return Object.freeze({channelAttachmentIntakeV2:flag==='true'});
}
/** Observe the existing native history protocol; a function-shaped stub or
 * enabled ingress flag alone is not recovery readiness. */
export function assertChannelAttachmentInputClient(client:unknown){
 if(!client||typeof client!=='object'||Array.isArray(client))throw Error('channel_attachment_native_recovery_unavailable');
 const source=client as Record<string,unknown>;
 if(typeof source.stageVerifiedFile!=='function'||typeof source.recoverInput!=='function'||typeof source.ordinaryRunHistoryReadiness!=='function')throw Error('channel_attachment_native_recovery_unavailable');
 return source as Record<string,unknown>&{ordinaryRunHistoryReadiness:(signal:AbortSignal)=>Promise<unknown>};
}
export async function requireChannelAttachmentInputReadiness(client:unknown){
 const source=assertChannelAttachmentInputClient(client);
 try{
  const value:unknown=await source.ordinaryRunHistoryReadiness.call(client,AbortSignal.timeout(5000));
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='execution_authorized,protocol,ready'||!('protocol' in value)||value.protocol!==1||!('ready' in value)||value.ready!==true||!('execution_authorized' in value)||value.execution_authorized!==false)throw Error();
 }catch{throw Error('channel_attachment_native_recovery_unavailable');}
}
