// Adapts PilotDeck 783499ff ThemeContext/appearanceRuntime; AGPL-3.0.
import {useLayoutEffect} from 'react';
import type {useAppearancePreferences} from './useAppearancePreferences';
import {deriveLightColors,isCustomizedLightAppearance,withoutMissingImage} from '../../packages/desktop/src/light-appearance.mjs';
import './light-appearance.css';

const names=['canvas','surface','sidebar','sidebar-ink','sidebar-accent','ink','muted','border','accent'] as const;

export function useLightAppearance(theme:'light'|'dark',preferences:ReturnType<typeof useAppearancePreferences>){
 const value=preferences.value.lightAppearance;
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
 return {value,update:preferences.updateLight,saveFailed:!!preferences.error,unavailable:preferences.unavailable};
}
