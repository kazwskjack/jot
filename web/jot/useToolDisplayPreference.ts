// Tool auto-expand preference adapts PilotDeck 783499ff useUiPreferences/ToolRenderer.
// Adapted portions retain AGPL-3.0; see THIRD_PARTY_NOTICES.md.
import {useEffect,useState,useSyncExternalStore} from 'react';
import {subscribeTaskDraftScope,taskDraftScope} from './client';

type Preference={scope:string;enabled:boolean;persisted:boolean};
const sync='jot:tool-display-preference';
// One account-scoped fallback keeps this preference usable when browser storage is denied.
let volatile:Preference|undefined;
function load(scope:string):Preference{
 const fallback={scope,enabled:false,persisted:false};
 if(!/^[a-f0-9]{64}$/.test(scope))return fallback;
 if(volatile?.scope===scope)return volatile;
 try{
  const raw=localStorage.getItem('jot:tool-display:'+scope);
  if(raw===null)return {...fallback,persisted:true};
  if(raw.length>256)return fallback;
  const value=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='autoExpandTools,version'
   ||value.version!==1||typeof value.autoExpandTools!=='boolean')return fallback;
  return {scope,enabled:value.autoExpandTools,persisted:true};
 }catch{return fallback;}
}
export function useToolDisplayPreference(){
 const scope=useSyncExternalStore(subscribeTaskDraftScope,taskDraftScope),[state,setState]=useState(()=>load(scope));
 const current=state.scope===scope?state:load(scope),available=/^[a-f0-9]{64}$/.test(scope);
 useEffect(()=>{
  const refresh=()=>setState(load(scope));
  const samePage=(event:Event)=>{if((event as CustomEvent).detail===scope)refresh();};
  const otherPage=(event:StorageEvent)=>{
   if(event.key!==null&&event.key!=='jot:tool-display:'+scope)return;
   try{if(event.storageArea!==localStorage)return;}catch{return;}
   if(volatile?.scope===scope)volatile=undefined;refresh();
  };
  window.addEventListener(sync,samePage);window.addEventListener('storage',otherPage);refresh();
  return()=>{window.removeEventListener(sync,samePage);window.removeEventListener('storage',otherPage);};
 },[scope]);
 const setEnabled=(enabled:boolean)=>{
  if(!available||taskDraftScope()!==scope)return;
  let persisted=false;
  try{const raw=JSON.stringify({version:1,autoExpandTools:enabled}),key='jot:tool-display:'+scope;localStorage.setItem(key,raw);persisted=localStorage.getItem(key)===raw;}catch{}
  const next={scope,enabled,persisted};volatile=persisted?undefined:next;setState(next);window.dispatchEvent(new CustomEvent(sync,{detail:scope}));
 };
 return {enabled:current.enabled,persisted:current.persisted,available,setEnabled};
}
