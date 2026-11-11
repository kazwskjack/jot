// Adapts PilotDeck 783499ff rendererRecovery; AGPL-3.0.
import {isDesktopAppUrl} from './desktop-security.mjs';
import {desktopText} from './desktop-text.mjs';
export function createDesktopRendererRecovery({owner,getWindow,appOrigin,dialog,isQuitting,language,onUnavailable=()=>{},onResponsive=()=>{},onDiagnostic=()=>{},onError=()=>{}}){
 let disposed=false,pending=false,crashPending=false,unresponsive=false,epoch=0;
 const valid=()=>!disposed&&!isQuitting()&&getWindow()===owner&&!owner.isDestroyed()&&!owner.webContents.isDestroyed?.()&&isDesktopAppUrl(owner.webContents.getURL(),appOrigin);
 const note=kind=>{try{onDiagnostic(kind);}catch{}};
 const report=error=>{try{onError(error);}catch{}};
 const refresh=()=>{if(valid()&&!unresponsive&&!owner.webContents.isCrashed?.())try{onResponsive();}catch(error){report(error);}};
 const reload=()=>{
  if(!valid()||!owner.webContents.isCrashed?.()&&(owner.webContents.isLoadingMainFrame?.()??owner.webContents.isLoading()))return;
  note('renderer-reload');
  // Keep Electron's original beforeunload protection; no forced navigation or backend restart.
  owner.webContents.reload();
 };
 const offer=async(crashed=false)=>{
  if(crashed)crashPending=true;
  if(pending||!valid()||typeof dialog?.showMessageBox!=='function')return;
  crashed=crashPending||crashed;crashPending=false;pending=true;const admittedEpoch=epoch,wasUnresponsive=unresponsive;
  try{
   const locale=language();
   const result=await dialog.showMessageBox(owner,{type:'warning',title:'Jot',message:desktopText(crashed?'crashed':'unresponsive',locale),detail:desktopText('reloadDetail',locale),
    buttons:[desktopText('reload',locale),desktopText(crashed?'later':'wait',locale)],defaultId:1,cancelId:1,noLink:true});
   if(result?.response===0&&valid()&&epoch===admittedEpoch&&(crashed?owner.webContents.isCrashed?.()===true:wasUnresponsive&&unresponsive))reload();
  }catch(error){report(error);}finally{pending=false;refresh();if(crashPending&&valid()&&owner.webContents.isCrashed?.())void offer(true);}
 };
 const unavailable=()=>{
  if(!valid()||unresponsive)return;unresponsive=true;note('renderer-unresponsive');
  try{onUnavailable();}catch(error){report(error);}void offer(false);
 };
 const responsive=()=>{if(!unresponsive)return;unresponsive=false;epoch++;note('renderer-responsive');refresh();};
 const navigation=(_event,_url,inPlace,mainFrame)=>{if(mainFrame===true&&inPlace!==true){epoch++;crashPending=false;unresponsive=false;}};
 const input=(event,value)=>{
  if(!valid()||(!unresponsive&&!owner.webContents.isCrashed?.())||value?.type!=='keyDown'||value.isAutoRepeat||value.isComposing||value.alt||value.shift)return;
  const key=typeof value.key==='string'?value.key.toLowerCase():'';
  const modifier=process.platform==='darwin'?value.meta&&!value.control:value.control&&!value.meta;
  if(key!=='f5'&&!(modifier&&key==='r'))return;
  event.preventDefault();void offer(owner.webContents.isCrashed?.()===true);
 };
 const dispose=()=>{
  if(disposed)return;disposed=true;crashPending=false;epoch++;
  owner.off('unresponsive',unavailable);owner.off('responsive',responsive);owner.off('closed',dispose);
  owner.webContents.off('did-start-navigation',navigation);owner.webContents.off('before-input-event',input);
 };
 owner.on('unresponsive',unavailable);owner.on('responsive',responsive);owner.on('closed',dispose);
 owner.webContents.on('did-start-navigation',navigation);owner.webContents.on('before-input-event',input);
 return Object.freeze({offer,dispose,isUnresponsive:()=>unresponsive});
}
