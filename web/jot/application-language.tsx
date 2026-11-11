// Adapts PilotDeck 783499ff languageChanged render semantics using existing React; AGPL-3.0.
import {createContext,useContext,useCallback} from 'react';
import type {ApplicationLanguage} from '../../packages/desktop/src/application-language.mjs';
export const ApplicationLanguageContext=createContext<ApplicationLanguage>('zh-CN');
export const ApplicationLanguageProvider=ApplicationLanguageContext.Provider;
export const applicationText=(language:ApplicationLanguage)=>(zh:string,en:string)=>language==='zh-CN'?zh:en;
export function useApplicationLanguage(){return useContext(ApplicationLanguageContext);}
export function useApplicationText(){
 const language=useApplicationLanguage();return useCallback((zh:string,en:string)=>language==='zh-CN'?zh:en,[language]);
}
