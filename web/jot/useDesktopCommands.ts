// Menu coordination adapts PilotDeck 783499ff useDesktopCommands; AGPL-3.0.
import {useEffect,useRef} from 'react';
import {desktopMenuCommands,type DesktopMenuCommand,type DesktopMenuState} from '../../packages/desktop/src/menu-commands.mjs';
import {taskDraftScope} from './client';
export type DesktopUiCommand=DesktopMenuCommand;
type Bridge={platform?:string;onCommand?:(listener:(value:{protocol:1;command:DesktopUiCommand;owner_scope:string})=>void)=>()=>void;setMenuState?:(state:DesktopMenuState)=>Promise<unknown>};
export function useDesktopCommands(options:{owner:string;sidebarVisible:boolean;enabled:(command:DesktopUiCommand)=>boolean;execute:(command:DesktopUiCommand)=>void}){
 const latest=useRef(options);latest.current=options;
 useEffect(()=>{
  const bridge=(window as Window&{jotDesktop?:Bridge}).jotDesktop;
  if(!bridge?.onCommand||!bridge.setMenuState)return;
  let disposed=false,frame=0,last='';
  const blocked=()=>Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"],dialog[open],[data-modal-overlay]'))
   .some(node=>!node.closest('[hidden],[aria-hidden="true"],[inert]')&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden');
  const state=():DesktopMenuState=>{
   const current=latest.current,ready=/^[a-f0-9]{64}$/.test(current.owner)&&taskDraftScope()===current.owner;
   return {protocol:1,owner_scope:ready?current.owner:null,ready,blocked:blocked(),enabled_commands:ready?desktopMenuCommands.filter(command=>current.enabled(command)):[],sidebar_visible:current.sidebarVisible};
  };
  const sync=()=>{if(disposed)return;const next=state(),encoded=JSON.stringify(next);if(encoded===last)return;last=encoded;void bridge.setMenuState!(next).catch(()=>{if(!disposed)last='';});};
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;sync();});};
  const stop=bridge.onCommand(value=>{
   const current=state();
   if(!disposed&&value?.protocol===1&&value.owner_scope===current.owner_scope&&desktopMenuCommands.includes(value.command)&&!current.blocked&&current.ready&&current.enabled_commands.includes(value.command))latest.current.execute(value.command);
  });
  const keydown=(event:KeyboardEvent)=>{
   if(event.defaultPrevented||event.isComposing||event.keyCode===229||event.altKey||event.shiftKey)return;
   const modifier=bridge.platform==='darwin'?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey;
   if(!modifier||event.key.toLowerCase()!=='b')return;
   const target=event.target instanceof Element?event.target:document.activeElement;
   if(target?.closest('input,textarea,select,[contenteditable="true"],.cm-editor,.xterm'))return;
   const current=state();if(current.blocked||!current.enabled_commands.includes('toggle-sidebar'))return;
   event.preventDefault();latest.current.execute('toggle-sidebar');
  };
  const relevant='[aria-modal="true"],dialog,[role="dialog"],[role="alertdialog"],[data-modal-overlay],[data-desktop-target],[data-desktop-navigation-guard],[data-desktop-workbench],[data-chat-search-scope],[data-pdf-file-search]';
  const affects=(node:Node)=>node instanceof Element&&(node.matches(relevant)||!!node.querySelector(relevant));
  const observer=new MutationObserver(records=>{if(records.some(record=>record.type==='attributes'?affects(record.target):[...record.addedNodes,...record.removedNodes].some(affects)))schedule();});
  observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','hidden','aria-hidden','aria-modal','inert','class','data-desktop-files-ready','data-desktop-workspace']});
  document.addEventListener('focusin',schedule);document.addEventListener('focusout',schedule);document.addEventListener('keydown',keydown);window.addEventListener('jot:desktop-menu-refresh',sync);sync();
  return()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();stop();document.removeEventListener('focusin',schedule);document.removeEventListener('focusout',schedule);document.removeEventListener('keydown',keydown);window.removeEventListener('jot:desktop-menu-refresh',sync);
   void bridge.setMenuState!({protocol:1,owner_scope:null,ready:false,blocked:true,enabled_commands:[],sidebar_visible:false}).catch(()=>{});};
 },[]);
 useEffect(()=>{window.dispatchEvent(new Event('jot:desktop-menu-refresh'));},[options.owner,options.sidebarVisible,options.enabled]);
}
