// Adapts PilotDeck 783499ff linuxCaptionMenu; AGPL-3.0.
import {randomUUID} from 'node:crypto';
import {captionMenuIds} from '../../packages/desktop/src/caption-menu-contract.mjs';
import {isDesktopAppUrl} from './desktop-security.mjs';
const editRoles=new Set(['undo','redo','cut','copy','paste','selectAll']);
const roles=new Set([...editRoles,'resetZoom','zoomIn','zoomOut','togglefullscreen','close']);
export function createLinuxCaptionMenu({owner,getWindow,appOrigin,getTemplate,getEpoch}){
 let current=null,generation=0,disposed=false;
 const valid=()=>!disposed&&getWindow()===owner&&!owner.isDestroyed()&&owner.isVisible?.()!==false&&!owner.webContents.isDestroyed?.()&&!owner.webContents.isCrashed?.()&&
  !(owner.webContents.isLoadingMainFrame?.()??owner.webContents.isLoading())&&isDesktopAppUrl(owner.webContents.getURL(),appOrigin);
 const identity=item=>JSON.stringify([item.id??null,item.role??null,item.label??'',item.type??'normal']);
 const submenu=id=>{if(!captionMenuIds.includes(id))throw Error('desktop_caption_request_invalid');const items=getTemplate().find(item=>item.id===id)?.submenu;if(!Array.isArray(items)||items.length>64)throw Error('desktop_caption_menu_unavailable');return items;};
 const publish=reset=>{if(valid())try{owner.webContents.send('desktop:linux-caption-update',Object.freeze({protocol:1,generation,reset}));}catch{}};
 const invalidate=()=>{const had=current!==null;current=null;generation+=1;if(had)publish(true);};
 const refresh=()=>{if(current){generation+=1;publish(false);}};
 const read=({id})=>{
  if(!valid())throw Error('desktop_caption_window_unavailable');
  const items=submenu(id),entries=[],bindings=new Map();
  items.forEach((item,index)=>{
   if(item.visible===false)return;
   const type=item.type==='separator'?'separator':item.type==='checkbox'?'checkbox':'normal';
   const label=item.label??'',accelerator=item.accelerator;
   if(typeof label!=='string'||label.length>512||/[\x00-\x1f\x7f]/.test(label)||accelerator!==undefined&&(typeof accelerator!=='string'||accelerator.length>64))throw Error('desktop_caption_menu_invalid');
   const enabled=type!=='separator'&&item.enabled!==false&&(typeof item.click==='function'||roles.has(item.role));
   entries.push(Object.freeze({index,label,type,enabled,checked:item.checked===true,...(accelerator?{accelerator:accelerator.replaceAll('CmdOrCtrl','Ctrl')}: {})}));
   bindings.set(index,{identity:identity(item),item});
  });
  generation+=1;const token=randomUUID();current={token,id,epoch:getEpoch(),generation,bindings};
  return Object.freeze({protocol:1,generation,token,menu_id:id,entries:Object.freeze(entries)});
 };
 const activate=({token,index})=>{
  const session=current;
  if(!valid()||!session||session.token!==token||session.generation!==generation||session.epoch!==getEpoch())throw Error('desktop_caption_action_stale');
  const bound=session.bindings.get(index),fresh=submenu(session.id)[index];
  if(!bound||!fresh||fresh.visible===false||fresh.enabled===false||fresh.type==='separator'||bound.identity!==identity(fresh))throw Error('desktop_caption_action_unavailable');
  current=null;generation+=1; // Consume before executing; a repeated IPC cannot replay it.
  const item=bound.item,contents=owner.webContents;
  if(typeof item.click==='function')item.click();
  else if(editRoles.has(item.role))contents[item.role]();
  else if(item.role==='resetZoom')contents.setZoomLevel(0);
  else if(item.role==='zoomIn'||item.role==='zoomOut')contents.setZoomLevel(contents.getZoomLevel()+(item.role==='zoomIn'?1:-1));
  else if(item.role==='togglefullscreen')owner.setFullScreen(!owner.isFullScreen());
  else if(item.role==='close')owner.close();else throw Error('desktop_caption_action_unavailable');
  return Object.freeze({protocol:1,accepted:true});
 };
 const dismiss=({token})=>{if(current?.token===token)invalidate();return Object.freeze({protocol:1,closed:true});};
 const navigation=(_event,_url,inPlace,mainFrame)=>{if(mainFrame===true&&inPlace!==true)invalidate();};
 const events=['hide','resize','move','enter-full-screen','leave-full-screen'];
 for(const event of events)owner.on(event,invalidate);
 owner.webContents.on('did-start-navigation',navigation);owner.webContents.on('render-process-gone',invalidate);
 const dispose=()=>{if(disposed)return;disposed=true;current=null;generation+=1;for(const event of events)owner.off(event,invalidate);owner.off('closed',dispose);owner.webContents.off('did-start-navigation',navigation);owner.webContents.off('render-process-gone',invalidate);};
 owner.on('closed',dispose);return Object.freeze({read,activate,dismiss,invalidate,refresh,dispose});
}
