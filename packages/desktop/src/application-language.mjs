// Adapts PilotDeck 783499ff appearance/i18n supported language semantics; AGPL-3.0.
export const APPLICATION_LANGUAGE_KEY='jot-language-preference-v1',LEGACY_APPLICATION_LANGUAGE_KEY='userLanguage';
export const isApplicationLanguage=value=>value==='en'||value==='zh-CN';
export function applicationLanguage(value,locale='en'){
 return isApplicationLanguage(value)?value:typeof locale==='string'&&locale.toLowerCase().startsWith('zh')?'zh-CN':'en';
}
