// Adapts PilotDeck 783499ff ThemeContext/appearanceRuntime; AGPL-3.0.
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {LIGHT_APPEARANCE_KEY,deriveLightColors,isCustomizedLightAppearance,normalizeLightAppearance,withoutMissingImage,type LightAppearance} from '../../packages/desktop/src/light-appearance.mjs';
import './light-appearance.css';

const read=(raw:string|null):LightAppearance|null=>{
 if(!raw||raw.length>4096)return null;
 try{const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const version=(value as Record<string,unknown>).version;
  return version===undefined||version===1||version===2?normalizeLightAppearance(value):null;
 }catch{return null;}
};
function initial(){try{return read(localStorage.getItem(LIGHT_APPEARANCE_KEY))??normalizeLightAppearance();}catch{return normalizeLightAppearance();}}
const names=['canvas','surface','sidebar','sidebar-ink','sidebar-accent','ink','muted','border','accent'] as const;

export function useLightAppearance(theme:'light'|'dark'){
 const [value,setValue]=useState(initial),current=useRef(value),[saveFailed,setSaveFailed]=useState(false);
 const update=useCallback((change:(current:LightAppearance)=>LightAppearance)=>{
  let next:LightAppearance;
  try{next=normalizeLightAppearance(change(read(localStorage.getItem(LIGHT_APPEARANCE_KEY))??current.current));localStorage.setItem(LIGHT_APPEARANCE_KEY,JSON.stringify(next));}
  catch{setSaveFailed(true);return false;}
  current.current=next;setValue(next);setSaveFailed(false);return true;
 },[]);
 useEffect(()=>{
  const sync=(event:StorageEvent)=>{
   try{if(event.storageArea!==localStorage||event.key!==null&&event.key!==LIGHT_APPEARANCE_KEY)return;
    const next=event.newValue===null?normalizeLightAppearance():read(event.newValue);if(!next)return;
    current.current=next;setValue(next);setSaveFailed(false);
   }catch{}
  };
  window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);
 },[]);
 useLayoutEffect(()=>{
  const root=document.documentElement;
  // shortcut: asset loading is not connected yet; replace the fallback when the image store is integrated.
  const shown=withoutMissingImage(value,true),active=theme==='light'&&isCustomizedLightAppearance(shown);
  root.toggleAttribute('data-jot-light-appearance',active);
  if(active){
   const c=deriveLightColors(shown),colors=[c.background,c.surface,c.sidebar,c.sidebarInk,c.sidebarAccent,c.ink,c.muted,c.border,c.accent];
   names.forEach((name,index)=>root.style.setProperty('--jot-light-'+name,colors[index]!));
   root.dataset.jotWindowAppearance=JSON.stringify(shown);
   document.querySelector('meta[name="theme-color"]')?.setAttribute('content',c.background);
  }else{
   root.removeAttribute('data-jot-window-appearance');names.forEach(name=>root.style.removeProperty('--jot-light-'+name));
   document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#101217':'#faf9f6');
  }
  return()=>{root.removeAttribute('data-jot-light-appearance');root.removeAttribute('data-jot-window-appearance');names.forEach(name=>root.style.removeProperty('--jot-light-'+name));};
 },[value,theme]);
 return {value,update,saveFailed};
}
