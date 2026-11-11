// Display preferences adapt PilotDeck 783499ff useUiPreferences/ToolRenderer.
// Adapted portions retain AGPL-3.0; see THIRD_PARTY_NOTICES.md.
import {useEffect,useState,useSyncExternalStore} from 'react';
import {subscribeTaskDraftScope,taskDraftScope} from './client';

type Preference<T>={scope:string;value:T;persisted:boolean};
const sync='jot:tool-display-preference',toolDefaults={autoExpandTools:false};
const messageDefaults={showThinking:true,inlineThinking:false,sendByCtrlEnter:false};
// Only the two declared namespaces retain one account-scoped storage-failure fallback each.
const volatile=new Map<string,Preference<Record<string,boolean>>>();
function load<T extends Record<string,boolean>>(namespace:string,scope:string,defaults:T):Preference<T>{
 const fallback={scope,value:defaults,persisted:false};
 if(!/^[a-f0-9]{64}$/.test(scope))return fallback;
 const cached=volatile.get(namespace);if(cached?.scope===scope)return cached as Preference<T>;
 try{
  const raw=localStorage.getItem('jot:'+namespace+':'+scope);
  if(raw===null)return {...fallback,persisted:true};
  if(raw.length>256)return fallback;
  const value=JSON.parse(raw),keys=Object.keys(defaults);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==['version',...keys].sort().join(',')
   ||value.version!==1||keys.some(key=>typeof value[key]!=='boolean'))return fallback;
  return {scope,value:Object.fromEntries(keys.map(key=>[key,value[key]])) as T,persisted:true};
 }catch{return fallback;}
}
function useBooleanDisplayPreferences<T extends Record<string,boolean>>(namespace:string,defaults:T){
 const scope=useSyncExternalStore(subscribeTaskDraftScope,taskDraftScope),[state,setState]=useState(()=>load(namespace,scope,defaults));
 const current=state.scope===scope?state:load(namespace,scope,defaults),available=/^[a-f0-9]{64}$/.test(scope);
 useEffect(()=>{
  const refresh=()=>setState(load(namespace,scope,defaults));
  const samePage=(event:Event)=>{if((event as CustomEvent).detail===scope)refresh();};
  const otherPage=(event:StorageEvent)=>{
   if(event.key!==null&&event.key!=='jot:'+namespace+':'+scope)return;
   try{if(event.storageArea!==localStorage)return;}catch{return;}
   if(volatile.get(namespace)?.scope===scope)volatile.delete(namespace);refresh();
  };
  window.addEventListener(sync,samePage);window.addEventListener('storage',otherPage);refresh();
  return()=>{window.removeEventListener(sync,samePage);window.removeEventListener('storage',otherPage);};
 },[namespace,scope,defaults]);
 const setPreference=(key:keyof T,enabled:boolean)=>{
  if(!available||taskDraftScope()!==scope||!Object.hasOwn(defaults,key)||typeof enabled!=='boolean')return;
  const value={...load(namespace,scope,defaults).value,[key]:enabled};let persisted=false;
  try{const raw=JSON.stringify({version:1,...value}),storageKey='jot:'+namespace+':'+scope;localStorage.setItem(storageKey,raw);persisted=localStorage.getItem(storageKey)===raw;}catch{}
  const next={scope,value,persisted};if(persisted)volatile.delete(namespace);else volatile.set(namespace,next);
  setState(next);window.dispatchEvent(new CustomEvent(sync,{detail:scope}));
 };
 return {value:current.value,persisted:current.persisted,available,setPreference};
}
export function useToolDisplayPreference(){
 const state=useBooleanDisplayPreferences('tool-display',toolDefaults);
 return {enabled:state.value.autoExpandTools,persisted:state.persisted,available:state.available,setEnabled:(enabled:boolean)=>state.setPreference('autoExpandTools',enabled)};
}
export function useMessageDisplayPreferences(){return useBooleanDisplayPreferences('message-display',messageDefaults);}
