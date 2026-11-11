// Adapts PilotDeck 783499ff WindowsCaptionMenu; retained AGPL-3.0.
import {parseCaptionMenuRequest} from '../../packages/desktop/src/caption-menu-contract.mjs';
import {isDesktopAppUrl} from './desktop-security.mjs';
export function createDesktopCaptionMenu({owner,getWindow,appOrigin,Menu,getTemplate,getCursor}){
 let disposed=false,buttons=[],popup=null,current=undefined,pending=undefined,closing=false,timer=null,scheduled=null,cursor=null;
 let completion=null,complete=null;
 const valid=()=>!disposed&&getWindow()===owner&&!owner.isDestroyed()&&owner.isVisible?.()!==false&&!owner.webContents.isDestroyed?.()&&
  !owner.webContents.isCrashed?.()&&!(owner.webContents.isLoadingMainFrame?.()??owner.webContents.isLoading())&&isDesktopAppUrl(owner.webContents.getURL(),appOrigin);
 const notify=id=>{if(valid())try{owner.webContents.send('desktop:caption-menu',Object.freeze({protocol:1,id}));}catch{}};
 const finish=()=>{
  if(timer)clearInterval(timer);if(scheduled)clearImmediate(scheduled);
  timer=null;scheduled=null;cursor=null;popup=null;current=undefined;pending=undefined;closing=false;
  notify(null);const resolve=complete;complete=null;completion=null;resolve?.(Object.freeze({protocol:1,closed:true}));
 };
 const close=()=>{
  pending=undefined;if(scheduled)clearImmediate(scheduled);scheduled=null;
  if(timer)clearInterval(timer);timer=null;cursor=null;
  if(popup&&!closing){closing=true;try{popup.closePopup(owner);}catch{finish();}}
  else if(!popup)finish();
 };
 const openPending=()=>{
  scheduled=null;
  const id=pending;pending=undefined;
  if(id===undefined||!valid()){close();return;}
  const template=getTemplate(),items=id===null?template:template.find(item=>item.id===id)?.submenu;
  if(!Array.isArray(items)){finish();return;}
  let menu;
  try{menu=Menu.buildFromTemplate(items);}catch{finish();return;}
  popup=menu;current=id;closing=false;
  const bounds=owner.getContentBounds(),zoom=owner.webContents.getZoomFactor();
  if(!Number.isFinite(zoom)||zoom<=0){close();return;}
  const button=buttons.find(item=>item.id===id);
  const x=Math.max(0,Math.min(bounds.width,Math.round((button?.x??12)*zoom)));
  const y=owner.isFullScreen()?0:Math.min(bounds.height,32);
  notify(id??'all');
  try{menu.popup({window:owner,x,y,callback:()=>{
   if(popup!==menu)return;
   popup=null;current=undefined;closing=false;
   // Leave the native close callback before opening a replacement popup.
   if(pending!==undefined&&valid())scheduled=setImmediate(openPending);else finish();
  }});}catch{finish();}
 };
 const switchTo=id=>{
  if(id===current&&!closing)return;
  pending=id;
  if(popup){if(!closing){closing=true;try{popup.closePopup(owner);}catch{finish();}}}
  else if(!scheduled)openPending();
 };
 const trackHover=()=>{
  if(!valid()){close();return;}
  let point;try{point=getCursor();}catch{close();return;}
  const previous=cursor;cursor=point;
  if(!point||!previous||(point.x===previous.x&&point.y===previous.y)||owner.isFullScreen())return;
  const bounds=owner.getContentBounds(),zoom=owner.webContents.getZoomFactor(),x=point.x-bounds.x,y=point.y-bounds.y;
  if(!Number.isFinite(zoom)||zoom<=0||x<0||y<0||x>=bounds.width||y>=bounds.height)return;
  const button=buttons.find(item=>x>=item.x*zoom&&x<(item.x+item.width)*zoom&&y>=item.y*zoom&&y<(item.y+item.height)*zoom);
  if(button)switchTo(button.id);
 };
 const show=value=>{
  if(!valid())throw Error('desktop_caption_window_unavailable');
  const request=parseCaptionMenuRequest(value);buttons=request.buttons;
  if(!completion)completion=new Promise(resolve=>{complete=resolve;});
  const result=completion;
  if(!timer&&typeof getCursor==='function'){
   try{cursor=getCursor();}catch{cursor=null;}
   timer=setInterval(trackHover,40);timer.unref?.();
  }
  switchTo(request.id);return result;
 };
 const reset=()=>{const menu=popup;finish();try{menu?.closePopup(owner);}catch{}};
 const navigation=(_event,_url,inPlace,mainFrame)=>{if(mainFrame===true&&inPlace!==true)reset();};
 const events=['hide','resize','move','enter-full-screen','leave-full-screen'];
 for(const event of events)owner.on(event,close);
 owner.webContents.on('did-start-navigation',navigation);owner.webContents.on('render-process-gone',reset);
 const dispose=()=>{
  if(disposed)return;disposed=true;const menu=popup;finish();
  try{menu?.closePopup(owner);}catch{}
  for(const event of events)owner.off(event,close);
  owner.off('closed',dispose);owner.webContents.off('did-start-navigation',navigation);owner.webContents.off('render-process-gone',reset);
 };
 owner.on('closed',dispose);
 return Object.freeze({show,close,dispose});
}
