// Adapts PilotDeck 783499ff appearance loading/status/retry UI; AGPL-3.0.
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {deriveLightColors,normalizeLightAppearance} from '../../packages/desktop/src/light-appearance.mjs';
import {windowChromePalette} from './window-chrome.mjs';
import {desktopText} from './desktop-text.mjs';
const phases=new Set(['loading','opening','failed','stopping']);
function html({phase,language,theme,lightAppearance,reducedMotion,token,canRetry,logFailed}){
 const light=deriveLightColors(normalizeLightAppearance(lightAppearance));
 const c=theme==='dark'?{background:'#101217',surface:'#171a21',ink:'#eef0f5',muted:'#8c95a6',border:'#2b303b'}:light;
 const text=key=>desktopText(key,language),action=(key)=>`<a href="https://jot.invalid/startup/${token}/${key}">${text(key)}</a>`;
 const message=phase==='failed'?'startupFailure':phase==='opening'?'startupOpening':phase==='stopping'?'startupStopping':'startupLoading';
 return `<!doctype html><html lang="${language}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Jot</title><style>
 :root{color-scheme:${theme};font:15px/1.6 system-ui,sans-serif;background:${c.background};color:${c.ink}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:72px 24px 32px}.drag{position:fixed;inset:0 140px auto 0;height:48px;-webkit-app-region:drag}main{width:min(520px,100%)}h1{font-size:24px}section{padding:24px;border:1px solid ${c.border};border-radius:12px;background:${c.surface}}p{margin:0 0 14px}.muted{color:${c.muted}}nav{display:flex;gap:12px;flex-wrap:wrap}a{display:inline-block;border:1px solid ${c.border};border-radius:8px;padding:8px 12px;color:inherit;text-decoration:none;-webkit-app-region:no-drag}a:hover{background:${c.background}}a:focus-visible{outline:2px solid currentColor;outline-offset:3px}.spinner{display:inline-block;width:16px;height:16px;margin-right:10px;border:2px solid ${c.border};border-top-color:currentColor;border-radius:50%;${reducedMotion==='on'?'':'animation:spin .8s linear infinite'}}@keyframes spin{to{transform:rotate(360deg)}}${reducedMotion==='system'?'@media(prefers-reduced-motion:reduce){.spinner{animation:none}}':''}
 </style></head><body><div class="drag" aria-hidden="true"></div><main><h1>Jot</h1><section><p role="${phase==='failed'?'alert':'status'}">${phase==='loading'||phase==='opening'?'<span class="spinner" aria-hidden="true"></span>':''}${text(message)}</p>${logFailed?`<p role="status" class="muted">${text('startupLogUnavailable')}</p>`:''}<nav aria-label="${text('startupActions')}">${phase==='stopping'?'':(canRetry?action('retry'):'')+action('openLog')+action('quit')}</nav></section></main></body></html>`;
}
export function createDesktopStartupView({owner,getWindow,getAppearance,language,isQuitting,onQuit,onRetry,getLogFile,shell,showWindow=true,onClosed=()=>{},onError=()=>{}}){
 let disposed=false,released=false,attached=false,generation=0,currentUrl=null,actions=null,work=Promise.resolve(),pending=false,state={phase:'loading',canRetry:false,logFailed:false};
 const nativeTheme=getAppearance().nativeTheme;
 const valid=()=>!disposed&&getWindow()===owner&&!owner.isDestroyed()&&!owner.webContents.isDestroyed?.();
 const current=(epoch,url)=>valid()&&!released&&!isQuitting()&&generation===epoch&&currentUrl===url&&owner.webContents.getURL()===url;
 const report=error=>{try{onError(error);}catch{}};
 const navigation=(event,url)=>{
  event.preventDefault();const epoch=generation,documentUrl=currentUrl;
  if(!documentUrl||!current(epoch,documentUrl)||!actions?.has(url))return;
  const action=actions.get(url);if(action==='quit'){onQuit();return;}if(pending)return;pending=true;
  void(async()=>{
   if(action==='retry'){if(state.canRetry)await onRetry();return;}
   if(action==='openLog'){
    const path=await getLogFile();if(!current(epoch,documentUrl))return;
    if(typeof path!=='string'||!isAbsolute(path)||typeof shell?.openPath!=='function'||await shell.openPath(path)){
     if(current(epoch,documentUrl))await render({...state,logFailed:true});
    }
   }
  })().catch(async error=>{report(error);if(action==='openLog'&&current(epoch,documentUrl))try{await render({...state,logFailed:true});}catch{}}).finally(()=>{pending=false;});
 };
 const redirect=event=>event.preventDefault(),close=event=>{event.preventDefault();onQuit();};
 const download=(event,_item,contents)=>{if(contents===owner.webContents)event.preventDefault();};
 const themeChanged=()=>{if(valid()&&!released&&!isQuitting())void render(state).catch(report);};
 const detach=()=>{if(!attached)return;attached=false;nativeTheme?.removeListener?.('updated',themeChanged);owner.off('close',close);owner.webContents.off('will-navigate',navigation);owner.webContents.off('will-redirect',redirect);owner.webContents.session.off('will-download',download);};
 const attach=()=>{if(attached)return;attached=true;nativeTheme?.on?.('updated',themeChanged);owner.on('close',close);owner.webContents.on('will-navigate',navigation);owner.webContents.on('will-redirect',redirect);owner.webContents.session.on('will-download',download);owner.webContents.setWindowOpenHandler(()=>({action:'deny'}));};
 const closed=()=>{if(disposed)return;disposed=true;generation++;currentUrl=null;actions=null;detach();owner.off('closed',closed);onClosed();};
 const render=(next)=>{
  if(!valid()||!phases.has(next.phase))return Promise.reject(Error('desktop_startup_window_unavailable'));
  released=false;attach();state={phase:next.phase,canRetry:next.canRetry===true,logFailed:next.logFailed===true};
  const epoch=++generation,token=randomUUID(),appearance=getAppearance();currentUrl=null;
  const url='data:text/html;charset=utf-8,'+encodeURIComponent(html({...state,language:language(),theme:appearance.initialTheme,lightAppearance:appearance.initialAppearance,reducedMotion:appearance.reducedMotion,token}));
  const links=new Map(['quit','openLog',...(state.canRetry?['retry']:[])].map(key=>['https://jot.invalid/startup/'+token+'/'+key,key]));
  work=work.catch(()=>{}).then(async()=>{
   if(!valid()||released||generation!==epoch)return false;
   const palette=windowChromePalette(appearance.initialTheme,appearance.initialAppearance);owner.setBackgroundColor(palette.background);
   if((process.platform==='win32'||process.platform==='linux')&&!owner.isFullScreen())owner.setTitleBarOverlay({height:32,color:palette.caption,symbolColor:palette.symbol});
   currentUrl=url;actions=links;await owner.loadURL(url);
   if(valid()&&!released&&generation===epoch&&showWindow)owner.show();return true;
  });return work;
 };
 const release=async()=>{released=true;generation++;currentUrl=null;actions=null;detach();await work.catch(()=>{});};
 const destroy=()=>{if(disposed)return;closed();if(!owner.isDestroyed())owner.destroy();};
 owner.on('closed',closed);
 return Object.freeze({window:owner,render,release,destroy,get active(){return !disposed&&!released;}});
}
