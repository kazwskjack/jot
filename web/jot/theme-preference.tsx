// Adapts PilotDeck 783499ff ThemeContext theme-mode semantics; AGPL-3.0.
import {useAppearancePreferences} from './useAppearancePreferences';
import {useLightAppearance} from './useLightAppearance';
import LightAppearanceControls from './LightAppearanceControls';
import React,{useEffect,useLayoutEffect,useState} from 'react';

export type ThemeMode='system'|'light'|'dark';
export type ThemePreference=ReturnType<typeof useThemePreference>;
const validMode=(value:unknown):value is ThemeMode=>value==='system'||value==='light'||value==='dark';
function systemQuery(){try{return window.matchMedia?.('(prefers-color-scheme: dark)')??null;}catch{return null;}}

export function useThemePreference(){
 const preferences=useAppearancePreferences(),mode=preferences.value.themeMode;
 const [systemDark,setSystemDark]=useState(()=>systemQuery()?.matches??false);
 const theme=mode==='system'?(systemDark?'dark':'light'):mode;
 const light=useLightAppearance(theme,preferences);
 useEffect(()=>{
  const query=systemQuery();if(!query)return;
  const change=()=>setSystemDark(query.matches);change();query.addEventListener('change',change);
  return()=>query.removeEventListener('change',change);
 },[]);
 useLayoutEffect(()=>{
  const root=document.documentElement;root.dataset.themeMode=mode;root.dataset.theme=theme;root.dataset.jotThemeReady='true';
  if(!preferences.native){
   try{if(localStorage.getItem('jot-theme-preference-v1')===null)localStorage.setItem('jot-theme-preference-v1',JSON.stringify({version:1,mode}));}catch{}
   try{localStorage.setItem('jot-theme',theme);}catch{}
  }
  return()=>{root.removeAttribute('data-jot-theme-ready');};
 },[mode,theme,preferences.native]);
 return {mode,theme,changeMode:preferences.changeMode,saveFailed:!!preferences.error,pending:preferences.pending,unavailable:preferences.unavailable,light};
}

export function ThemeSelector({preference,zh=false}:{preference:ThemePreference;zh?:boolean}){
 return <div className="jot-theme-control"><select className="jot-theme-select" aria-label={zh?'外观主题':'Appearance theme'} value={preference.mode} disabled={preference.unavailable} onChange={event=>{if(validMode(event.target.value))preference.changeMode(event.target.value);}}>
  <option value="system">{zh?'跟随系统':'System'}</option><option value="light">{zh?'浅色':'Light'}</option><option value="dark">{zh?'深色':'Dark'}</option>
 </select><details className="jot-appearance-popover" onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!event.nativeEvent.isComposing&&event.currentTarget.open){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary>{zh?'配色':'Palette'}</summary><LightAppearanceControls light={preference.light} dark={preference.theme==='dark'} onLight={()=>preference.changeMode('light')} zh={zh}/></details>{preference.unavailable?<span role="status">{zh?'桌面外观设置暂不可用。':'Desktop appearance settings are unavailable.'}</span>:preference.pending?<span role="status">{zh?'正在保存外观…':'Saving appearance…'}</span>:preference.saveFailed&&<span role="status">{zh?'外观暂未保存，请重试。':'Appearance could not be saved. Please try again.'}</span>}</div>;
}
