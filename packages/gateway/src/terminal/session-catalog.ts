/** Read-only settings entry; native terminal routes remain the execution authority. */
export type TerminalSessionChoice={conversation_id:string;title:string;workspace_id:string;run_id:string;created_at:string};
export type TerminalSessionCatalog={protocol:1;items:TerminalSessionChoice[];before_run_id:string|null;next_before_run_id:string|null;execution_authorized:false};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const exact=(value:unknown,keys:string):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys;
export function validateTerminalSessionCatalog(value:unknown,before:string|null):TerminalSessionCatalog{
 if(!exact(value,'before_run_id,execution_authorized,items,next_before_run_id,protocol')||value.protocol!==1||value.execution_authorized!==false
  ||value.before_run_id!==before||before!==null&&!id(before)||!Array.isArray(value.items)||value.items.length>50)throw Error('terminal_session_catalog_invalid');
 let previous=before;
 for(const item of value.items){
  if(!exact(item,'conversation_id,created_at,run_id,title,workspace_id')||!id(item.conversation_id)||!id(item.run_id)||typeof item.workspace_id!=='string'
   ||typeof item.title!=='string'
   ||typeof item.created_at!=='string'||item.created_at.length>160||!Number.isFinite(Date.parse(item.created_at))
   ||previous!==null&&item.run_id>=previous)throw Error('terminal_session_catalog_invalid');
  previous=item.run_id;
 }
 if(value.next_before_run_id!==null&&(value.items.length!==50||value.next_before_run_id!==previous))throw Error('terminal_session_catalog_invalid');
 return value as unknown as TerminalSessionCatalog;
}
