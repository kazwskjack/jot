// Adapts PilotDeck 783499ff interfacePreferences; AGPL-3.0.
export const INTERFACE_PREFERENCES_KEY='jot-interface-preferences-v1';
export function normalizeInterfacePreferences(value){
 const v=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
 return {reducedMotion:v.reducedMotion==='on'||v.reducedMotion==='off'?v.reducedMotion:'system',hardwareAcceleration:v.hardwareAcceleration!==false};
}
