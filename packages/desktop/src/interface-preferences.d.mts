// Types adapt PilotDeck 783499ff interfacePreferences; AGPL-3.0.
export type InterfacePreferences={reducedMotion:'system'|'on'|'off';hardwareAcceleration:boolean};
export const INTERFACE_PREFERENCES_KEY:string;
export function normalizeInterfacePreferences(value?:unknown):InterfacePreferences;
