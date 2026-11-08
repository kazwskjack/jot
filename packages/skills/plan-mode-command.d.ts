export interface NativePlanIdentity{
 request_id:string;
 name:'plan';
}
export interface NativePlanMode extends NativePlanIdentity{
 definition_id:'@deepseek-ai/dsh-plan-mode';
 enabled:boolean;
 expected_catalog_sha256:string;
}
export function isNativePlanMode(value:unknown):boolean;
export function validateNativePlanIdentity(value:unknown):NativePlanIdentity;
export function validateNativePlanMode(value:unknown):NativePlanMode;
export function nativePlanModeInput(request:NativePlanMode):string;
export function assertNativePlanScope(scope:unknown):void;
export const nativePlanModePolicy:Readonly<{
 kind:'plan';
 validateRequest:typeof validateNativePlanMode;
 validateIdentity:typeof validateNativePlanIdentity;
 inputFor:typeof nativePlanModeInput;
 assertScope:typeof assertNativePlanScope;
 callbackPrefix:'native-plan-mode';
}>;
