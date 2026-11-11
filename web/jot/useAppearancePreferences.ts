// Adapts PilotDeck 783499ff ThemeContext/appearance persistence; AGPL-3.0.
import {deleteBackgroundImage,writeBrowserLight,copyBrowserBackgroundImage,recoverBackgroundImages,type ImageRecovery} from './appearance-images';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {LIGHT_APPEARANCE_KEY,LEGACY_LIGHT_APPEARANCE_KEY,normalizeLightAppearance,type LightAppearance,type ThemeMode} from '../../packages/desktop/src/light-appearance.mjs';
import {INTERFACE_PREFERENCES_KEY,normalizeInterfacePreferences,type InterfacePreferences} from '../../packages/desktop/src/interface-preferences.mjs';
type Preferences={themeMode:ThemeMode;lightAppearance:LightAppearance;interfacePreferences:InterfacePreferences};
type Snapshot=Preferences&{protocol:1|2;revision:number;stored:boolean;writable:boolean;error:null|'desktop_appearance_unavailable'|'desktop_appearance_conflict'};
type Bridge={getAppearance:()=>unknown;setAppearance:(request:{expected_revision:number;themeMode:ThemeMode;lightAppearance:string;interfacePreferences?:string})=>Promise<unknown>};
const modeKey='jot-theme-preference-v1',legacyKey='jot-theme';
const mode=(value:unknown):value is ThemeMode=>value==='system'||value==='light'||value==='dark';
function browserPreferences(strict=false){
 let themeMode:ThemeMode='system',lightAppearance=normalizeLightAppearance(),interfacePreferences=normalizeInterfacePreferences(),saved=false;
 try{
  const raw=localStorage.getItem(modeKey),legacy=localStorage.getItem(legacyKey);
  if(mode(legacy)){themeMode=legacy;saved=true;}
  if(raw)try{if(raw.length>128)throw Error();const v=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='mode,version'||v.version!==1||!mode(v.mode))throw Error();themeMode=v.mode;saved=true;}catch(error){if(strict)throw error;}
  const preferences=localStorage.getItem(INTERFACE_PREFERENCES_KEY);
  if(preferences)try{if(preferences.length>256)throw Error();const v=JSON.parse(preferences),normalized=normalizeInterfacePreferences(v);if(JSON.stringify(v)!==JSON.stringify(normalized))throw Error();interfacePreferences=normalized;saved=true;}catch(error){if(strict)throw error;}
  const light=localStorage.getItem(LIGHT_APPEARANCE_KEY)??localStorage.getItem(LEGACY_LIGHT_APPEARANCE_KEY);
  if(light)try{if(light.length>4096)throw Error();const v=JSON.parse(light);if(!v||typeof v!=='object'||Array.isArray(v)||![undefined,1,2].includes(v.version))throw Error();lightAppearance=normalizeLightAppearance(v);saved=true;}catch(error){if(strict)throw error;}
 }catch(error){if(strict)throw error;}
 return {value:{themeMode,lightAppearance,interfacePreferences},saved};
}
function snapshot(value:unknown):Snapshot{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('desktop_appearance_invalid');
 const v=value as Record<string,unknown>;
 const keys=v.protocol===2?'error,interfacePreferences,lightAppearance,protocol,revision,stored,themeMode,writable':'error,lightAppearance,protocol,revision,stored,themeMode,writable';
 if(Object.keys(v).sort().join(',')!==keys||(v.protocol!==1&&v.protocol!==2)||!Number.isSafeInteger(v.revision)||Number(v.revision)<0||typeof v.stored!=='boolean'||typeof v.writable!=='boolean'||!mode(v.themeMode)||
  (v.stored?Number(v.revision)<1:v.revision!==0)||!(v.writable?v.error===null:v.error==='desktop_appearance_unavailable'||v.error==='desktop_appearance_conflict'))throw Error('desktop_appearance_invalid');
 const lightAppearance=normalizeLightAppearance(v.lightAppearance),raw=JSON.stringify(v.lightAppearance);
 if(!raw||raw.length>4096||raw!==JSON.stringify(lightAppearance))throw Error('desktop_appearance_invalid');
 const interfacePreferences=normalizeInterfacePreferences(v.interfacePreferences);
 if(v.protocol===2&&JSON.stringify(v.interfacePreferences)!==JSON.stringify(interfacePreferences))throw Error('desktop_appearance_invalid');
 return {protocol:v.protocol as 1|2,interfacePreferences,revision:Number(v.revision),stored:v.stored,writable:v.writable,error:v.error as Snapshot['error'],themeMode:v.themeMode,lightAppearance};
}
function initial(){
 const browser=browserPreferences(),candidate=(window as Window&{jotDesktop?:Partial<Bridge>}).jotDesktop;
 const bridge=typeof candidate?.getAppearance==='function'&&typeof candidate?.setAppearance==='function'?candidate as Bridge:null;
 let native:Snapshot|null=null,unavailable=false;
 if(bridge)try{native=snapshot(bridge.getAppearance());unavailable=!native.writable;}catch{unavailable=true;}
 return {bridge,native,unavailable,value:native?.stored?{themeMode:native.themeMode,lightAppearance:native.lightAppearance,interfacePreferences:native.interfacePreferences}:browser.value,migrate:!!bridge&&!!native?.writable&&!native.stored&&browser.saved};
}
export function useAppearancePreferences(){
 const [start]=useState(initial),[value,setValue]=useState(start.value),[error,setError]=useState(start.unavailable?'unavailable':''),[unavailable,setUnavailable]=useState(start.unavailable),[pending,setPending]=useState(0),[cleanupFailures,setCleanupFailures]=useState<string[]>([]),[cleanupPending,setCleanupPending]=useState(false),[recoveryPending,setRecoveryPending]=useState(false),[recovery,setRecovery]=useState<ImageRecovery|null>(null),[recoveryError,setRecoveryError]=useState(false);
 const current=useRef(value),saved=useRef(value),nativeSaved=useRef(!!start.native?.stored),migrationImage=useRef<{from:string;to:string}|null>(null),revision=useRef(start.native?.revision??0),sequence=useRef(0),queued=useRef(0),queue=useRef(Promise.resolve()),blocked=useRef(start.unavailable),mounted=useRef(true),migrated=useRef(false),failedCleanup=useRef(new Set<string>()),deferredCleanup=useRef(new Set<string>()),cleaning=useRef(false),recovering=useRef(false),recoveryActive=useRef(false),volatileMode=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const cleanupNow=useCallback(async(id:string)=>{
  try{await deleteBackgroundImage(id);failedCleanup.current.delete(id);}
  catch{if(failedCleanup.current.size<32)failedCleanup.current.add(id);}
  if(mounted.current)setCleanupFailures([...failedCleanup.current]);
 },[]);
 const discardImage=useCallback(async(id:string)=>{
  // Native pending references do not include writes still queued in this renderer.
  if(queued.current||recoveryActive.current){if(deferredCleanup.current.size<32)deferredCleanup.current.add(id);return;}
  await cleanupNow(id);
 },[cleanupNow]);
 const drainCleanup=useCallback(async function drain(includeFailures:boolean):Promise<void>{
  if(cleaning.current||recoveryActive.current||queued.current||!mounted.current)return;
  const ids=new Set([...deferredCleanup.current,...(includeFailures?failedCleanup.current:[])]);if(!ids.size)return;
  cleaning.current=true;setCleanupPending(true);
  try{for(const id of ids){if(!mounted.current||queued.current)break;deferredCleanup.current.delete(id);await cleanupNow(id);}}
  finally{cleaning.current=false;if(mounted.current){setCleanupPending(false);if(!queued.current&&deferredCleanup.current.size)void drain(false);}}
 },[cleanupNow]);
 const retryCleanup=useCallback(()=>drainCleanup(true),[drainCleanup]);
 const recoverUnusedImages=useCallback(async()=>{
  if(recovering.current||queued.current||cleaning.current||blocked.current||!mounted.current)return;
  recovering.current=true;setRecoveryPending(true);setRecovery(null);setRecoveryError(false);
  try{
   await drainCleanup(true);if(!mounted.current)return;if(queued.current)throw Error('appearance_image_busy');
   recoveryActive.current=true;const result=await recoverBackgroundImages();if(mounted.current)setRecovery(result);
  }catch{if(mounted.current)setRecoveryError(true);}
  finally{recovering.current=false;recoveryActive.current=false;if(mounted.current){setRecoveryPending(false);void drainCleanup(false);}}
 },[drainCleanup]);
 const change=useCallback((patch:Partial<Preferences>,onSaved?:(saved:boolean)=>void,lightUpdate?:(value:LightAppearance)=>LightAppearance)=>{
  if(blocked.current){onSaved?.(false);return false;}
  if(queued.current>=32){setError('busy');onSaved?.(false);return false;}
  const next={themeMode:patch.themeMode??current.current.themeMode,lightAppearance:normalizeLightAppearance(patch.lightAppearance??current.current.lightAppearance),interfacePreferences:normalizeInterfacePreferences(patch.interfacePreferences??current.current.interfacePreferences)};
  if(!mode(next.themeMode)){onSaved?.(false);return false;}
  const request=++sequence.current;current.current=next;setValue(next);setError('');queued.current++;setPending(queued.current);
  queue.current=queue.current.then(async()=>{
   if(!mounted.current){onSaved?.(false);return;}
   if(blocked.current){if(request===sequence.current){current.current=saved.current;setValue(saved.current);setError('unavailable');}onSaved?.(false);return;}
   let copiedImage:string|null=null,migrationAttempt:{from:string;to:string;expected:number;value:Preferences}|null=null;
   try{
    let actual:Preferences,previousId=start.bridge&&!nativeSaved.current?null:saved.current.lightAppearance.background.imageId;
    if(start.bridge){
     const expected=revision.current,sourceId=next.lightAppearance.background.imageId;let intended=next;
     const alias=migrationImage.current;
     if(sourceId&&alias?.from===sourceId)intended={...next,lightAppearance:{...next.lightAppearance,background:{...next.lightAppearance.background,imageId:alias.to}}};
     else if(!nativeSaved.current&&start.migrate&&sourceId&&sourceId===start.value.lightAppearance.background.imageId){
      const before=snapshot(start.bridge.getAppearance());if(before.stored||before.revision!==expected||expected!==0||!before.writable)throw Error('desktop_appearance_conflict');
      copiedImage=await copyBrowserBackgroundImage(sourceId,()=>mounted.current&&!blocked.current);
      if(copiedImage)intended={...next,lightAppearance:{...next.lightAppearance,background:{...next.lightAppearance.background,imageId:copiedImage}}};
     }
     if(copiedImage&&sourceId)migrationAttempt={from:sourceId,to:copiedImage,expected,value:intended};
     if(!mounted.current)throw Error('appearance_image_cancelled');
     const result=snapshot(await start.bridge.setAppearance({expected_revision:expected,themeMode:intended.themeMode,lightAppearance:JSON.stringify(intended.lightAppearance),...(start.native?.protocol===2?{interfacePreferences:JSON.stringify(intended.interfacePreferences)}:{})}));
     if(!result.writable||!result.stored||result.revision!==expected+1||result.themeMode!==intended.themeMode||JSON.stringify(result.lightAppearance)!==JSON.stringify(intended.lightAppearance)||result.protocol===2&&JSON.stringify(result.interfacePreferences)!==JSON.stringify(intended.interfacePreferences))throw Error('desktop_appearance_ack_invalid');
     if(copiedImage&&sourceId)migrationImage.current={from:sourceId,to:copiedImage};
     nativeSaved.current=true;revision.current=result.revision;actual={themeMode:result.themeMode,lightAppearance:result.lightAppearance,interfacePreferences:result.interfacePreferences};
    }else{
     if(patch.themeMode!==undefined){localStorage.setItem(modeKey,JSON.stringify({version:1,mode:next.themeMode}));volatileMode.current=false;}
     if(patch.interfacePreferences!==undefined)localStorage.setItem(INTERFACE_PREFERENCES_KEY,JSON.stringify(next.interfacePreferences));
     if(patch.lightAppearance!==undefined){const result=await writeBrowserLight(lightUpdate??(()=>next.lightAppearance),()=>mounted.current);previousId=result.previousImageId;actual={...browserPreferences().value,lightAppearance:result.value};}
     else actual=browserPreferences().value;
    }
    saved.current=actual;
    if(mounted.current&&request===sequence.current){current.current=!start.bridge&&patch.themeMode===undefined?{...actual,themeMode:current.current.themeMode}:actual;setValue(current.current);}
    onSaved?.(true);
    if(previousId&&previousId!==actual.lightAppearance.background.imageId)await discardImage(previousId);
   }catch{
    if(!start.bridge&&patch.themeMode!==undefined)volatileMode.current=true;
    if(start.bridge)try{const latest=snapshot(start.bridge.getAppearance());revision.current=latest.revision;if(latest.stored){nativeSaved.current=true;saved.current={themeMode:latest.themeMode,lightAppearance:latest.lightAppearance,interfacePreferences:latest.interfacePreferences};if(migrationAttempt&&latest.revision===migrationAttempt.expected+1&&latest.themeMode===migrationAttempt.value.themeMode&&JSON.stringify(latest.lightAppearance)===JSON.stringify(migrationAttempt.value.lightAppearance)&&JSON.stringify(latest.interfacePreferences)===JSON.stringify(migrationAttempt.value.interfacePreferences))migrationImage.current={from:migrationAttempt.from,to:migrationAttempt.to};}if(!latest.writable){blocked.current=true;if(mounted.current)setUnavailable(true);}}catch{blocked.current=true;if(mounted.current)setUnavailable(true);}
    if(mounted.current&&request===sequence.current){current.current=start.bridge?saved.current:{...saved.current,themeMode:current.current.themeMode};setValue(current.current);setError(blocked.current?'unavailable':'save');}
    onSaved?.(false);
    if(copiedImage)await discardImage(copiedImage);
   }
  }).catch(()=>{onSaved?.(false);if(mounted.current)setError('save');}).finally(()=>{queued.current=Math.max(0,queued.current-1);if(mounted.current){setPending(queued.current);if(!start.bridge&&!queued.current)try{const latest=browserPreferences(true).value;saved.current=latest;current.current=volatileMode.current?{...latest,themeMode:current.current.themeMode}:latest;setValue(current.current);}catch{}if(!queued.current)void drainCleanup(false);}});
  return true;
 },[start,discardImage,drainCleanup]);
 useLayoutEffect(()=>{if(start.migrate&&!migrated.current){migrated.current=true;change(current.current);}},[start,change]);
 useEffect(()=>{
  if(start.bridge)return;
  const sync=(event:StorageEvent)=>{try{if(event.storageArea!==localStorage||![null,modeKey,legacyKey,LIGHT_APPEARANCE_KEY,LEGACY_LIGHT_APPEARANCE_KEY,INTERFACE_PREFERENCES_KEY].includes(event.key))return;
   if(event.key===LEGACY_LIGHT_APPEARANCE_KEY&&localStorage.getItem(LIGHT_APPEARANCE_KEY)!==null)return;
   if(event.newValue!==null&&event.key===modeKey){if(event.newValue.length>128)return;const v=JSON.parse(event.newValue);if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='mode,version'||v.version!==1||!mode(v.mode))return;}
   if(event.newValue!==null&&(event.key===LIGHT_APPEARANCE_KEY||event.key===LEGACY_LIGHT_APPEARANCE_KEY)){if(event.newValue.length>4096)return;const v=JSON.parse(event.newValue);if(!v||typeof v!=='object'||Array.isArray(v)||![undefined,1,2].includes(v.version))return;}
   if(event.newValue!==null&&event.key===INTERFACE_PREFERENCES_KEY){if(event.newValue.length>256)return;const v=JSON.parse(event.newValue);if(JSON.stringify(v)!==JSON.stringify(normalizeInterfacePreferences(v)))return;}
   saved.current=browserPreferences(true).value;if(!queued.current){volatileMode.current=false;current.current=saved.current;setValue(current.current);setError('');}
  }catch{}};
  window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);
 },[start]);
 const updateInterface=useCallback((patch:Partial<InterfacePreferences>)=>{if(start.bridge&&start.native?.protocol!==2)return false;return change({interfacePreferences:normalizeInterfacePreferences({...current.current.interfacePreferences,...patch})});},[change,start]);
 const retrySave=useCallback(()=>change(current.current),[change]);
 const changeMode=useCallback((themeMode:ThemeMode)=>change({themeMode}),[change]);
 const updateLight=useCallback((update:(v:LightAppearance)=>LightAppearance)=>change({lightAppearance:normalizeLightAppearance(update(current.current.lightAppearance))},undefined,update),[change]);
 const commitLight=useCallback((update:(v:LightAppearance)=>LightAppearance)=>new Promise<boolean>(resolve=>{change({lightAppearance:normalizeLightAppearance(update(current.current.lightAppearance))},resolve,update);}),[change]);
 return {value,savedInterfacePreferences:saved.current.interfacePreferences,changeMode,updateLight,commitLight,updateInterface,interfaceAvailable:!start.bridge||start.native?.protocol===2,retrySave,error,pending,unavailable,native:!!start.bridge,discardImage,retryCleanup,cleanupFailed:cleanupFailures.length>0,cleanupPending,recoverUnusedImages,recoveryPending,recovery,recoveryError};
}
