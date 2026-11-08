const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const definitionId='@deepseek-ai/dsh-plan-mode';
export function isNativePlanMode(value){
 return value?.name==='plan'&&value.definition_id===definitionId;
}
export function validateNativePlanIdentity(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='name,request_id'
  ||typeof value.request_id!=='string'||!UUID.test(value.request_id)||value.name!=='plan')throw Error('native_command_query_invalid');
 return {request_id:value.request_id,name:'plan'};
}
export function validateNativePlanMode(value){
 if(!value||typeof value!=='object'||Array.isArray(value)
  ||Object.keys(value).sort().join(',')!=='definition_id,enabled,expected_catalog_sha256,name,request_id'
  ||!isNativePlanMode(value)||typeof value.enabled!=='boolean'
  ||typeof value.expected_catalog_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.expected_catalog_sha256))throw Error('native_command_query_invalid');
 return {...validateNativePlanIdentity({request_id:value.request_id,name:value.name}),definition_id:definitionId,
  enabled:value.enabled,expected_catalog_sha256:value.expected_catalog_sha256};
}
export function nativePlanModeInput(request){return request.enabled?'':' off';}
export function assertNativePlanScope(scope){
 if(scope.kind==='ordinary'&&scope.mode!=='work')throw Error('skill_catalog_scope_forbidden');
}
export const nativePlanModePolicy=Object.freeze({
 kind:'plan',
 validateRequest:validateNativePlanMode,
 validateIdentity:validateNativePlanIdentity,
 inputFor:nativePlanModeInput,
 assertScope:assertNativePlanScope,
 callbackPrefix:'native-plan-mode',
});
