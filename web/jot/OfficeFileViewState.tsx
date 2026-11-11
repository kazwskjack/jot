import {useEffect} from 'react';
import type {FileViewingIdentity} from './activity-file-preview-client';
import type {OfficeRegionSession} from './OfficeFileRegionReference';
import {taskDraftScope} from './client';
import {officeViewIdentity,readOfficeView,writeOfficeView,type OfficeViewKind} from './office-file-view-state';

// shortcut: frame scroll reports coalesce at160ms; add a close acknowledgment when exact final scroll is required.
/** View messages retain the original isolated window, token and exact source authority. */
export default function OfficeFileViewState({source,owner,session,kind,focused}:{source:FileViewingIdentity;owner:string;session:OfficeRegionSession;kind:OfficeViewKind;focused:boolean}){
 const key=officeViewIdentity(source,owner,kind);
 useEffect(()=>{
  const receive=(event:MessageEvent)=>{
   if(!session.live()||taskDraftScope()!==owner||event.source!==session.window||event.origin!==session.origin)return;
   const value=event.data;
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='protocol,token,type,view'
    ||value.protocol!==1||value.token!==session.token||value.type!==`jot-${kind}-view`)return;
   writeOfficeView(key,owner,kind,value.view);
  };
  window.addEventListener('message',receive);
  if(session.live()&&taskDraftScope()===owner)session.window.postMessage({type:`jot-${kind}-view-probe`,protocol:1,token:session.token,view:focused?null:readOfficeView(key,owner,kind)??null},session.origin);
  return()=>window.removeEventListener('message',receive);
 },[key,owner,kind,session,focused]);
 return null;
}
