// Adapts PilotDeck 783499ff useInterfacePreferences/capabilities; AGPL-3.0.
import {useEffect,useLayoutEffect,useState} from 'react';
import type {useAppearancePreferences} from './useAppearancePreferences';
import './interface-appearance.css';
function motionQuery(){try{return window.matchMedia?.('(prefers-reduced-motion: reduce)')??null;}catch{return null;}}
export function prefersReducedMotion(){
 const resolved=document.documentElement.dataset.jotReducedMotion;
 return resolved==='on'||resolved!=='off'&&!!motionQuery()?.matches;
}
export function useInterfaceAppearance(preferences:ReturnType<typeof useAppearancePreferences>){
 const value=preferences.value.interfacePreferences,[hardwareActive,setHardwareActive]=useState<boolean|null>(null),[capabilitiesFailed,setCapabilitiesFailed]=useState(false),[retry,setRetry]=useState(0);
 useLayoutEffect(()=>{
  const root=document.documentElement,query=motionQuery();
  const apply=()=>{root.dataset.jotReducedMotion=value.reducedMotion==='on'||value.reducedMotion==='system'&&!!query?.matches?'on':'off';};
  apply();query?.addEventListener('change',apply);
  return()=>{query?.removeEventListener('change',apply);root.removeAttribute('data-jot-reduced-motion');};
 },[value.reducedMotion]);
 useEffect(()=>{
  if(!preferences.native)return;let active=true;setHardwareActive(null);setCapabilitiesFailed(false);
  const bridge=(window as Window&{jotDesktop?:{getAppearanceCapabilities?:()=>Promise<unknown>}}).jotDesktop;
  void Promise.resolve().then(()=>{if(typeof bridge?.getAppearanceCapabilities!=='function')throw Error('desktop_appearance_unavailable');return bridge.getAppearanceCapabilities();}).then(result=>{
   if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).sort().join(',')!=='hardwareAcceleration,protocol')throw Error('desktop_appearance_invalid');
   const v=result as Record<string,unknown>;if(v.protocol!==1||v.hardwareAcceleration!==null&&typeof v.hardwareAcceleration!=='boolean')throw Error('desktop_appearance_invalid');
   if(active){setHardwareActive(v.hardwareAcceleration as boolean|null);setCapabilitiesFailed(v.hardwareAcceleration===null);}
  }).catch(()=>{if(active)setCapabilitiesFailed(true);});
  return()=>{active=false;};
 },[preferences.native,retry]);
 return {value,update:preferences.updateInterface,available:preferences.interfaceAvailable,hardwareActive,capabilitiesFailed,retryCapabilities:()=>setRetry(n=>n+1),native:preferences.native,restartRequired:hardwareActive!==null&&hardwareActive!==preferences.savedInterfacePreferences.hardwareAcceleration};
}
