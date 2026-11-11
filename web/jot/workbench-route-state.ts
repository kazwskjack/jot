import {taskDraftScope} from './client';

export type WorkbenchRoute={view:string;conversation:string;showConversations:boolean};
const validOwner=(owner:string)=>owner.length===64&&/^[a-f0-9]{64}$/.test(owner)&&taskDraftScope()===owner;
const slot=(owner:string)=>'jot.workbench.route.v1.'+owner;
function valid(value:unknown,views:readonly string[]):value is WorkbenchRoute&{protocol:1}{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const route=value as WorkbenchRoute&{protocol:number};
 return Object.keys(route).sort().join(',')==='conversation,protocol,showConversations,view'&&route.protocol===1
  &&typeof route.view==='string'&&views.includes(route.view)&&typeof route.showConversations==='boolean'
  &&typeof route.conversation==='string'&&(route.conversation===''||route.conversation.length<=128
   &&/^[A-Za-z0-9]/.test(route.conversation)&&!/[^A-Za-z0-9_:-]/.test(route.conversation));
}
/** Route identity only; original owned APIs and durable draft/command stores still authorize recovery. */
export function readWorkbenchRoute(owner:string,views:readonly string[]):WorkbenchRoute|undefined{
 if(!validOwner(owner))return;
 try{const raw=sessionStorage.getItem(slot(owner));if(!raw||raw.length>2048)return;
  const value:unknown=JSON.parse(raw);if(valid(value,views))return {view:value.view,conversation:value.conversation,showConversations:value.showConversations};
 }catch{}
}
export function writeWorkbenchRoute(owner:string,route:WorkbenchRoute,views:readonly string[]):boolean{
 if(!validOwner(owner))return false;
 const value={protocol:1,view:route.view,conversation:route.conversation,showConversations:route.showConversations};
 if(!valid(value,views))return false;
 try{const encoded=JSON.stringify(value);sessionStorage.setItem(slot(owner),encoded);return sessionStorage.getItem(slot(owner))===encoded&&validOwner(owner);}catch{return false;}
}
