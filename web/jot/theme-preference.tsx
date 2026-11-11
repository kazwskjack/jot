// Adapts PilotDeck 783499ff ThemeContext theme-mode semantics; AGPL-3.0.
import React,{useCallback,useEffect,useLayoutEffect,useState} from 'react';

export type ThemeMode='system'|'light'|'dark';
export type ThemePreference=ReturnType<typeof useThemePreference>;
const key='jot-theme-preference-v1',legacyKey='jot-theme';
const validMode=(value:unknown):value is ThemeMode=>value==='system'||value==='light'||value==='dark';
function parsePreference(raw:string|null):ThemeMode|null{
 if(!raw||raw.length>128)return null;
 try{const value:unknown=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const item=value as Record<string,unknown>;
  return Object.keys(item).sort().join(',')==='mode,version'&&item.version===1&&validMode(item.mode)?item.mode:null;
 }catch{return null;}
}
function readMode():ThemeMode{
 try{const saved=parsePreference(localStorage.getItem(key));if(saved)return saved;
  const legacy=localStorage.getItem(legacyKey);if(validMode(legacy))return legacy;
 }catch{}
 return 'system';
}
function systemQuery(){try{return window.matchMedia?.('(prefers-color-scheme: dark)')??null;}catch{return null;}}

export function useThemePreference(){
 const [mode,setMode]=useState<ThemeMode>(readMode),[systemDark,setSystemDark]=useState(()=>systemQuery()?.matches??false),[saveFailed,setSaveFailed]=useState(false);
 const theme=mode==='system'?(systemDark?'dark':'light'):mode;
 const changeMode=useCallback((next:ThemeMode)=>{
  if(!validMode(next))return;setMode(next);
  try{localStorage.setItem(key,JSON.stringify({version:1,mode:next}));setSaveFailed(false);}catch{setSaveFailed(true);}
 },[]);
 useEffect(()=>{
  const query=systemQuery();if(!query)return;
  const change=()=>setSystemDark(query.matches);change();query.addEventListener('change',change);
  return()=>query.removeEventListener('change',change);
 },[]);
 useEffect(()=>{
  const sync=(event:StorageEvent)=>{
   try{
    if(event.storageArea!==localStorage)return;
    if(event.key===key){const next=parsePreference(event.newValue);if(event.newValue!==null&&!next)return;setMode(next??readMode());setSaveFailed(false);}
    else if(event.key===null||event.key===legacyKey&&!parsePreference(localStorage.getItem(key))){setMode(readMode());setSaveFailed(false);}
   }catch{}
  };
  window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);
 },[]);
 useLayoutEffect(()=>{
  const root=document.documentElement;root.dataset.themeMode=mode;root.dataset.theme=theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#101217':'#faf9f6');
  // Persist the initial migration before updating the older resolved-value key.
  try{if(localStorage.getItem(key)===null)localStorage.setItem(key,JSON.stringify({version:1,mode}));}catch{setSaveFailed(true);}
  // Older Jot pages still consume a resolved dark/light value.
  try{localStorage.setItem(legacyKey,theme);}catch{}
 },[mode,theme]);
 return {mode,theme,changeMode,saveFailed};
}

export function ThemeSelector({preference,zh=false}:{preference:ThemePreference;zh?:boolean}){
 return <div className="jot-theme-control"><select className="jot-theme-select" aria-label={zh?'外观主题':'Appearance theme'} value={preference.mode} onChange={event=>{if(validMode(event.target.value))preference.changeMode(event.target.value);}}>
  <option value="system">{zh?'跟随系统':'System'}</option><option value="light">{zh?'浅色':'Light'}</option><option value="dark">{zh?'深色':'Dark'}</option>
 </select>{preference.saveFailed&&<span role="status">{zh?'主题暂未保存，本页仍有效。':'Theme could not be saved; it remains active on this page.'}</span>}</div>;
}
