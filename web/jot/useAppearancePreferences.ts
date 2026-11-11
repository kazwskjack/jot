// Adapts PilotDeck 783499ff ThemeContext/appearance persistence; AGPL-3.0.
import {useCallback,useEffect,useRef,useState} from 'react';
import {LIGHT_APPEARANCE_KEY,normalizeLightAppearance,type LightAppearance,type ThemeMode} from '../../packages/desktop/src/light-appearance.mjs';
type Preferences={themeMode:ThemeMode;lightAppearance:LightAppearance};
type Snapshot=Preferences&{protocol:1;revision:number;stored:boolean;writable:boolean;error:null|'desktop_appearance_unavailable'|'desktop_appearance_conflict'};
type Bridge={getAppearance:()=>unknown;setAppearance:(request:{expected_revision:number;themeMode:ThemeMode;lightAppearance:string})=>Promise<unknown>};
const modeKey='jot-theme-preference-v1',legacyKey='jot-theme';
const mode=(value:unknown):value is ThemeMode=>value==='system'||value==='light'||value==='dark';
function browserPreferences(){
 let themeMode:ThemeMode='system',lightAppearance=normalizeLightAppearance(),saved=false;
 try{
  const raw=localStorage.getItem(modeKey),legacy=localStorage.getItem(legacyKey);
  if(mode(legacy)){themeMode=legacy;saved=true;}
  if(raw&&raw.length<=128)try{const v=JSON.parse(raw);if(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')==='mode,version'&&v.version===1&&mode(v.mode)){themeMode=v.mode;saved=true;}}catch{}
  const light=localStorage.getItem(LIGHT_APPEARANCE_KEY);
  if(light&&light.length<=4096)try{const v=JSON.parse(light);if(v&&typeof v==='object'&&!Array.isArray(v)&&(v.version===undefined||v.version===1||v.version===2)){lightAppearance=normalizeLightAppearance(v);saved=true;}}catch{}
 }catch{}
 return {value:{themeMode,lightAppearance},saved};
}
function snapshot(value:unknown):Snapshot{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('desktop_appearance_invalid');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='error,lightAppearance,protocol,revision,stored,themeMode,writable'||v.protocol!==1||!Number.isSafeInteger(v.revision)||Number(v.revision)<0||typeof v.stored!=='boolean'||typeof v.writable!=='boolean'||!mode(v.themeMode)||
  (v.stored?Number(v.revision)<1:v.revision!==0)||!(v.writable?v.error===null:v.error==='desktop_appearance_unavailable'||v.error==='desktop_appearance_conflict'))throw Error('desktop_appearance_invalid');
 const lightAppearance=normalizeLightAppearance(v.lightAppearance),raw=JSON.stringify(v.lightAppearance);
 if(!raw||raw.length>4096||raw!==JSON.stringify(lightAppearance))throw Error('desktop_appearance_invalid');
 return {protocol:1,revision:Number(v.revision),stored:v.stored,writable:v.writable,error:v.error as Snapshot['error'],themeMode:v.themeMode,lightAppearance};
}
function initial(){
 const browser=browserPreferences(),candidate=(window as Window&{jotDesktop?:Partial<Bridge>}).jotDesktop;
 const bridge=typeof candidate?.getAppearance==='function'&&typeof candidate?.setAppearance==='function'?candidate as Bridge:null;
 let native:Snapshot|null=null,unavailable=false;
 if(bridge)try{native=snapshot(bridge.getAppearance());unavailable=!native.writable;}catch{unavailable=true;}
 return {bridge,native,unavailable,value:native?.stored?{themeMode:native.themeMode,lightAppearance:native.lightAppearance}:browser.value,migrate:!!bridge&&!!native?.writable&&!native.stored&&browser.saved};
}
export function useAppearancePreferences(){
 const [start]=useState(initial),[value,setValue]=useState(start.value),[error,setError]=useState(start.unavailable?'unavailable':''),[unavailable,setUnavailable]=useState(start.unavailable),[pending,setPending]=useState(0);
 const current=useRef(value),saved=useRef(value),revision=useRef(start.native?.revision??0),sequence=useRef(0),queued=useRef(0),queue=useRef(Promise.resolve()),blocked=useRef(start.unavailable),mounted=useRef(true),migrated=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const change=useCallback((patch:Partial<Preferences>)=>{
  if(blocked.current)return false;
  if(queued.current>=32){setError('busy');return false;}
  const base=start.bridge?current.current:browserPreferences().value;
  const next={themeMode:patch.themeMode??base.themeMode,lightAppearance:normalizeLightAppearance(patch.lightAppearance??base.lightAppearance)};
  if(!mode(next.themeMode))return false;
  if(!start.bridge){
   try{if(patch.themeMode!==undefined)localStorage.setItem(modeKey,JSON.stringify({version:1,mode:next.themeMode}));if(patch.lightAppearance!==undefined)localStorage.setItem(LIGHT_APPEARANCE_KEY,JSON.stringify(next.lightAppearance));}
   catch{if(patch.themeMode!==undefined){current.current=next;setValue(next);}setError('save');return false;}
   current.current=saved.current=next;setValue(next);setError('');return true;
  }
  const request=++sequence.current;current.current=next;setValue(next);setError('');queued.current++;setPending(queued.current);
  queue.current=queue.current.then(async()=>{
   if(!mounted.current)return;
   if(blocked.current){if(request===sequence.current){current.current=saved.current;setValue(saved.current);setError('unavailable');}return;}
   try{
    const expected=revision.current,result=snapshot(await start.bridge!.setAppearance({expected_revision:expected,themeMode:next.themeMode,lightAppearance:JSON.stringify(next.lightAppearance)}));
    if(!result.writable||!result.stored||result.revision!==expected+1||result.themeMode!==next.themeMode||JSON.stringify(result.lightAppearance)!==JSON.stringify(next.lightAppearance))throw Error('desktop_appearance_ack_invalid');
    revision.current=result.revision;saved.current={themeMode:result.themeMode,lightAppearance:result.lightAppearance};
   }catch{
    try{const latest=snapshot(start.bridge!.getAppearance());revision.current=latest.revision;if(latest.stored)saved.current={themeMode:latest.themeMode,lightAppearance:latest.lightAppearance};if(!latest.writable){blocked.current=true;if(mounted.current)setUnavailable(true);}}catch{blocked.current=true;if(mounted.current)setUnavailable(true);}
    if(mounted.current&&request===sequence.current){current.current=saved.current;setValue(saved.current);setError(blocked.current?'unavailable':'save');}
   }
  }).catch(()=>{if(mounted.current)setError('save');}).finally(()=>{queued.current=Math.max(0,queued.current-1);if(mounted.current)setPending(queued.current);});
  return true;
 },[start]);
 useEffect(()=>{if(start.migrate&&!migrated.current){migrated.current=true;change(current.current);}},[start,change]);
 useEffect(()=>{
  if(start.bridge)return;
  const sync=(event:StorageEvent)=>{try{if(event.storageArea!==localStorage||![null,modeKey,legacyKey,LIGHT_APPEARANCE_KEY].includes(event.key))return;
   // Invalid external records do not replace the last valid visible preference.
   if(event.newValue!==null&&event.key===modeKey){if(event.newValue.length>128)return;const v=JSON.parse(event.newValue);if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='mode,version'||v.version!==1||!mode(v.mode))return;}
   if(event.newValue!==null&&event.key===LIGHT_APPEARANCE_KEY){if(event.newValue.length>4096)return;const v=JSON.parse(event.newValue);if(!v||typeof v!=='object'||Array.isArray(v)||![undefined,1,2].includes(v.version))return;}
   current.current=saved.current=browserPreferences().value;setValue(current.current);setError('');
  }catch{}};
  window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);
 },[start]);
 const changeMode=useCallback((themeMode:ThemeMode)=>change({themeMode}),[change]);
 const updateLight=useCallback((update:(v:LightAppearance)=>LightAppearance)=>change({lightAppearance:normalizeLightAppearance(update(start.bridge?current.current.lightAppearance:browserPreferences().value.lightAppearance))}),[change,start]);
 return {value,changeMode,updateLight,error,pending,unavailable,native:!!start.bridge};
}
