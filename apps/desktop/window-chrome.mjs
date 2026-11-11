// Adapts PilotDeck 783499ff windowChrome/preloadChrome; AGPL-3.0.
import {deriveLightColors,isCustomizedLightAppearance,normalizeLightAppearance,withoutMissingImage} from '../../packages/desktop/src/light-appearance.mjs';
import {isDesktopAppUrl} from './desktop-security.mjs';
export function windowChromePalette(theme,lightAppearance){
 const value=normalizeLightAppearance(lightAppearance);
 if(theme==='light'&&isCustomizedLightAppearance(value)){const c=deriveLightColors(value);return Object.freeze({background:c.background,caption:c.sidebar,symbol:c.sidebarInk});}
 return Object.freeze(theme==='light'?{background:'#faf9f6',caption:'#f0eee9',symbol:'#242731'}:{background:'#101217',caption:'#171a21',symbol:'#eef0f5'});
}
export function windowChromeOptions(platform=process.platform,theme='dark',lightAppearance){
 const palette=windowChromePalette(theme,lightAppearance);
 if(platform==='darwin')return {backgroundColor:palette.background,titleBarStyle:'hiddenInset',trafficLightPosition:{x:16,y:18}};
 if(platform==='win32'||platform==='linux')return {backgroundColor:palette.background,titleBarStyle:'hidden',titleBarOverlay:{height:32,color:palette.caption,symbolColor:palette.symbol}};
 return {};
}
export function createDesktopWindowChrome({owner,getWindow,appOrigin,getMenus,platform=process.platform,initialTheme='dark',initialAppearance=null}){
 let theme=initialTheme,lightAppearance=initialAppearance,disposed=false,revision=0,lastSignature='';
 const valid=()=>!disposed&&getWindow()===owner&&!owner.isDestroyed()&&!owner.webContents.isDestroyed?.();
 const read=()=>{
  if(!valid())throw Error('desktop_window_unavailable');
  const fullscreen=owner.isFullScreen(),menus=getMenus(),signature=JSON.stringify([theme,lightAppearance,fullscreen,menus]);
  if(signature!==lastSignature){lastSignature=signature;revision+=1;}
  return Object.freeze({protocol:lightAppearance?2:1,revision,platform,theme,fullscreen,caption_height:platform==='darwin'?48:32,
   palette:windowChromePalette(theme,lightAppearance),menus:Object.freeze(menus)});
 };
 const publish=()=>{
  if(!valid())return;
  const state=read();owner.setBackgroundColor(state.palette.background);
  // Changing overlay geometry while fullscreen can restore the native frame.
  if(platform!=='darwin'&&!state.fullscreen)owner.setTitleBarOverlay({height:32,color:state.palette.caption,symbolColor:state.palette.symbol});
  if(isDesktopAppUrl(owner.webContents.getURL(),appOrigin))try{owner.webContents.send('desktop:window-chrome',state);}catch{}
 };
 const setTheme=value=>{
  if(value!=='dark'&&value!=='light')throw Error('desktop_window_theme_invalid');
  if(!valid())throw Error('desktop_window_unavailable');
  theme=value;lightAppearance=null;publish();return read();
 };
 const setAppearance=value=>{
  if(!valid())throw Error('desktop_window_unavailable');
  if(value?.theme!=='light'&&value?.theme!=='dark')throw Error('desktop_window_theme_invalid');
  theme=value.theme;lightAppearance=normalizeLightAppearance(value.appearance);publish();return read();
 };
 const syncPreferences=value=>{
  const appearance=normalizeLightAppearance(value.appearance);
  return setAppearance({theme:value.theme,appearance:withoutMissingImage(appearance,appearance.background.imageId!==lightAppearance?.background?.imageId)});
 };
 const dispose=()=>{if(disposed)return;disposed=true;owner.off('enter-full-screen',publish);owner.off('leave-full-screen',publish);owner.off('closed',dispose);};
 owner.on('enter-full-screen',publish);owner.on('leave-full-screen',publish);owner.on('closed',dispose);
 return Object.freeze({read,setTheme,setAppearance,syncPreferences,publish,dispose});
}
