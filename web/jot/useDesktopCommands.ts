// Menu coordination adapts PilotDeck 783499ff useDesktopCommands; AGPL-3.0.
import {useEffect,useRef,type RefObject} from 'react';
import {desktopMenuCommands,type DesktopMenuCommand,type DesktopMenuState} from '../../packages/desktop/src/menu-commands.mjs';
import {taskDraftScope} from './client';
export type DesktopUiCommand=DesktopMenuCommand;
type Bridge={platform?:string;onMenuRefresh?:(listener:()=>void)=>()=>void;onCommand?:(listener:(value:{protocol:1;command:DesktopUiCommand;owner_scope:string})=>void)=>()=>void;setMenuState?:(state:DesktopMenuState)=>Promise<unknown>};
export function useDesktopCommands(options:{owner:string;surface:RefObject<HTMLElement|null>;sidebarVisible:boolean;enabled:(command:DesktopUiCommand)=>boolean;execute:(command:DesktopUiCommand)=>void}){
 const latest=useRef(options);latest.current=options;
 useEffect(()=>{
  const bridge=(window as Window&{jotDesktop?:Bridge}).jotDesktop;
  if(!bridge?.onCommand||!bridge.setMenuState)return;
  let disposed=false,frame=0,last='',sidebar:HTMLElement|null=null,toolbar:HTMLElement|null=null;
  const root=document.documentElement;
  const blocked=()=>Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"],dialog[open],[data-modal-overlay]'))
   .some(node=>!node.closest('[hidden],[aria-hidden="true"],[inert]')&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden');
  const state=():DesktopMenuState=>{
   const current=latest.current,ready=/^[a-f0-9]{64}$/.test(current.owner)&&taskDraftScope()===current.owner;
   return {protocol:1,owner_scope:ready?current.owner:null,ready,blocked:blocked(),enabled_commands:ready?desktopMenuCommands.filter(command=>current.enabled(command)):[],sidebar_visible:current.sidebarVisible};
  };
  const syncChrome=(ownerReady:boolean)=>{
   const current=latest.current,surface=current.surface.current;
   const candidate=surface?.querySelector<HTMLElement>('[data-desktop-sidebar]')??null,bar=surface?.querySelector<HTMLElement>('[data-desktop-toolbar]')??null;
   if(sidebar!==candidate){if(sidebar)resize?.unobserve(sidebar);sidebar=candidate;if(sidebar)resize?.observe(sidebar);}
   if(toolbar!==bar){if(toolbar)resize?.unobserve(toolbar);toolbar=bar;if(toolbar)resize?.observe(toolbar);}
   const shown=(node:HTMLElement|null)=>!!node&&!node.closest('[hidden],[inert],[aria-hidden="true"]')&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
   const ready=bridge.platform==='darwin'&&root.dataset.jotDesktopPlatform==='darwin'&&ownerReady;
   const bounds=toolbar?.getBoundingClientRect(),nav=sidebar?.getBoundingClientRect();
   const hasToolbar=ready&&shown(toolbar)&&!!bounds&&bounds.width>=300;
   const column=hasToolbar&&current.sidebarVisible&&shown(sidebar)&&!!nav&&nav.width>=120&&getComputedStyle(sidebar!).flexDirection==='column'&&nav.right-bounds!.left<=bounds!.width-300;
   const integrated=Boolean(column),setFlag=(name:string,value:boolean)=>{if(root.hasAttribute(name)!==value)root.toggleAttribute(name,value);};
   setFlag('data-jot-desktop-toolbar',Boolean(hasToolbar));setFlag('data-jot-desktop-integrated',integrated);
   const values:Record<string,number>={'--jot-desktop-toolbar-left':hasToolbar?bounds!.left:0,'--jot-desktop-toolbar-column':integrated?Math.max(0,nav!.right-bounds!.left):0};
   for(const [name,number] of Object.entries(values)){const value=`${Math.max(0,Math.min(32768,Math.round(number*100)/100))}px`;if(root.style.getPropertyValue(name)!==value)root.style.setProperty(name,value);}
  };
  const sync=()=>{if(disposed)return;const next=state();syncChrome(next.ready);const encoded=JSON.stringify(next);if(encoded===last)return;last=encoded;void bridge.setMenuState!(next).catch(()=>{if(!disposed)last='';});};
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;sync();});};
  const resize=bridge.platform==='darwin'&&typeof ResizeObserver!=='undefined'?new ResizeObserver(schedule):null;
  const rootObserver=new MutationObserver(schedule);rootObserver.observe(root,{attributes:true,attributeFilter:['data-jot-desktop-platform','data-jot-desktop-fullscreen']});
  window.addEventListener('resize',schedule);
  const stopRefresh=bridge.onMenuRefresh?.(()=>{last='';schedule();});
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
  const relevant='[data-desktop-toolbar],[data-desktop-sidebar],[aria-modal="true"],dialog,[role="dialog"],[role="alertdialog"],[data-modal-overlay],[data-desktop-target],[data-desktop-navigation-guard],[data-desktop-workbench],[data-chat-search-scope],[data-pdf-file-search]';
  const affects=(node:Node)=>node instanceof Element&&(node.matches(relevant)||!!node.querySelector(relevant));
  const observer=new MutationObserver(records=>{if(records.some(record=>record.type==='attributes'?affects(record.target):[...record.addedNodes,...record.removedNodes].some(affects)))schedule();});
  observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','hidden','aria-hidden','aria-modal','inert','class','data-desktop-files-ready','data-desktop-workspace']});
  document.addEventListener('focusin',schedule);document.addEventListener('focusout',schedule);document.addEventListener('keydown',keydown);window.addEventListener('jot:desktop-menu-refresh',sync);sync();
  return()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();rootObserver.disconnect();resize?.disconnect();stopRefresh?.();window.removeEventListener('resize',schedule);stop();
   root.removeAttribute('data-jot-desktop-toolbar');root.removeAttribute('data-jot-desktop-integrated');for(const name of ['--jot-desktop-toolbar-left','--jot-desktop-toolbar-column'])root.style.removeProperty(name);document.removeEventListener('focusin',schedule);document.removeEventListener('focusout',schedule);document.removeEventListener('keydown',keydown);window.removeEventListener('jot:desktop-menu-refresh',sync);
   void bridge.setMenuState!({protocol:1,owner_scope:null,ready:false,blocked:true,enabled_commands:[],sidebar_visible:false}).catch(()=>{});};
 },[]);
 useEffect(()=>{window.dispatchEvent(new Event('jot:desktop-menu-refresh'));},[options.owner,options.sidebarVisible,options.enabled]);
}
