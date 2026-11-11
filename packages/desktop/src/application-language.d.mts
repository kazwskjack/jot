// Types adapt PilotDeck 783499ff appearance/i18n languages; AGPL-3.0.
export type ApplicationLanguage='en'|'zh-CN';
export const APPLICATION_LANGUAGE_KEY:string,LEGACY_APPLICATION_LANGUAGE_KEY:string;
export function isApplicationLanguage(value:unknown):value is ApplicationLanguage;
export function applicationLanguage(value?:unknown,locale?:string):ApplicationLanguage;
