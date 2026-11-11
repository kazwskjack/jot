// Adapts PilotDeck 783499ff ThemeContext/appearanceRuntime; AGPL-3.0.
import {useCallback,useEffect,useLayoutEffect,useState} from 'react';
import {useInterfaceAppearance} from './useInterfaceAppearance';
import type {useAppearancePreferences} from './useAppearancePreferences';
import {loadBackgroundImage} from './appearance-images';
import {deriveLightColors,deriveLightBackgrounds,isCustomizedLightAppearance,withoutMissingImage} from '../../packages/desktop/src/light-appearance.mjs';
import './light-appearance.css';
const names=['canvas','surface','sidebar','sidebar-ink','sidebar-accent','ink','muted','border','accent','sidebar-fill','content-fill','wallpaper','image-fit','image-position','image-blur','image-brightness','image-saturation'] as const;
type ImageState={id:string;url:string|null;missing:boolean};
export function useLightAppearance(theme:'light'|'dark',preferences:ReturnType<typeof useAppearancePreferences>){
 const interfaceSettings=useInterfaceAppearance(preferences);
 const value=preferences.value.lightAppearance,id=theme==='light'&&value.background.type==='image'?value.background.imageId:null;
 const [image,setImage]=useState<ImageState|null>(null),[retry,setRetry]=useState(0);
 const imageUrl=id&&image?.id===id?image.url:null,imageMissing=!!id&&image?.id===id&&image.missing;
 useEffect(()=>{
  if(!id){setImage(null);return;}let disposed=false,loaded:string|null=null;
  setImage({id,url:null,missing:false});
  void loadBackgroundImage(id).then(url=>{loaded=url;if(disposed)URL.revokeObjectURL(url);else setImage({id,url,missing:false});}).catch(()=>{if(!disposed)setImage({id,url:null,missing:true});});
  return()=>{disposed=true;if(loaded)URL.revokeObjectURL(loaded);};
 },[id,retry]);
 const imageFailed=useCallback(()=>{setImage(current=>{if(!current||current.id!==id||current.url!==imageUrl)return current;if(current.url)URL.revokeObjectURL(current.url);return {...current,url:null,missing:true};});},[id,imageUrl]);
 useLayoutEffect(()=>{
  const root=document.documentElement,shown=withoutMissingImage(value,!imageUrl),active=theme==='light'&&isCustomizedLightAppearance(shown),wallpaper=!!imageUrl&&active;
  root.toggleAttribute('data-jot-light-appearance',active);root.toggleAttribute('data-jot-light-image',wallpaper);
  if(active){
   const c=deriveLightColors(shown),fill=deriveLightBackgrounds(shown,c),colors=[c.background,c.surface,c.sidebar,c.sidebarInk,c.sidebarAccent,c.ink,c.muted,c.border,wallpaper?c.sidebarAccent:c.accent,fill.sidebar,fill.content,wallpaper?`url(${JSON.stringify(imageUrl)})`:'none',value.background.fit,`${value.background.positionX}% ${value.background.positionY}%`,`${value.background.blur}px`,`${value.background.brightness}%`,`${value.background.saturation}%`];
   names.forEach((name,index)=>root.style.setProperty('--jot-light-'+name,colors[index]!));
   root.dataset.jotWindowAppearance=JSON.stringify(shown);
   document.querySelector('meta[name="theme-color"]')?.setAttribute('content',c.background);
  }else{
   root.removeAttribute('data-jot-window-appearance');names.forEach(name=>root.style.removeProperty('--jot-light-'+name));
   document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#101217':'#faf9f6');
  }
  return()=>{root.removeAttribute('data-jot-light-appearance');root.removeAttribute('data-jot-light-image');root.removeAttribute('data-jot-window-appearance');names.forEach(name=>root.style.removeProperty('--jot-light-'+name));};
 },[value,theme,imageUrl]);
 return {value,interfaceSettings,update:preferences.updateLight,commit:preferences.commitLight,saveFailed:!!preferences.error,retrySave:preferences.retrySave,unavailable:preferences.unavailable,pending:preferences.pending,imageUrl,imageMissing,imageLoading:!!id&&!imageUrl&&!imageMissing,imageFailed,retryImage:()=>setRetry(n=>n+1),discardImage:preferences.discardImage,cleanupFailed:preferences.cleanupFailed,cleanupPending:preferences.cleanupPending,retryCleanup:preferences.retryCleanup,recoverUnusedImages:preferences.recoverUnusedImages,recoveryPending:preferences.recoveryPending,recovery:preferences.recovery,recoveryError:preferences.recoveryError};
}
