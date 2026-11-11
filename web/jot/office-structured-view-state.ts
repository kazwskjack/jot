import {useCallback,useEffect,useLayoutEffect,useRef,type RefObject} from 'react';
import {taskDraftScope} from './client';
import {writeOfficeView,type StructuredOfficeView} from './office-file-view-state';

/** Persist only displayed coordinates; quotes and pending selections keep their original recovery flow. */
export function useStructuredOfficeViewState(key:string|undefined,owner:string,root:RefObject<HTMLElement|null>,view:StructuredOfficeView,restoreLeft:number|undefined){
 const latest=useRef(view);latest.current=view;
 const scroller=useRef<HTMLElement|null>(null);
 const restoring=useRef(true),timer=useRef<number|undefined>(undefined);
 const persist=useCallback(()=>{
  if(!key||restoring.current||taskDraftScope()!==owner)return;
  const element=scroller.current;
  writeOfficeView(key,owner,latest.current.kind,{...latest.current,left:Math.max(0,Math.min(33554432,element?.scrollLeft??0))});
 },[key,owner,root]);
 const schedule=useCallback(()=>{window.clearTimeout(timer.current);timer.current=window.setTimeout(persist,160);},[persist]);
 useLayoutEffect(()=>{
  if(!key)return;
  restoring.current=true;
  const element=root.current?.closest<HTMLElement>('.jot-office-content');scroller.current=element??null;
  const frame=window.requestAnimationFrame(()=>{
   if(taskDraftScope()!==owner)return;
   if(element)element.scrollLeft=restoreLeft??0;
   restoring.current=false;persist();
  });
  const flush=()=>{window.clearTimeout(timer.current);persist();};
  element?.addEventListener('scroll',schedule,{passive:true});window.addEventListener('pagehide',flush);
  return()=>{element?.removeEventListener('scroll',schedule);window.removeEventListener('pagehide',flush);window.cancelAnimationFrame(frame);flush();scroller.current=null;};
 },[key,owner,root,restoreLeft,persist,schedule]);
 const stamp=JSON.stringify(view);
 useEffect(()=>{if(!key)return;schedule();return()=>window.clearTimeout(timer.current);},[key,stamp,schedule]);
}
