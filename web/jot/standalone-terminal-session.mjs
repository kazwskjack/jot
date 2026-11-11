const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const projectId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const workspace=value=>typeof value==='string'&&!!value.trim()&&value.length<=4096&&!value.includes('\0');
export function validateStandaloneTerminalAdmission(value,expected){
 if(!object(value)||Object.keys(value).sort().join(',')!==(value.project_id===undefined?'authority_sha256,created_at,execution_authorized,native_identity_sha256,owner_id,protocol,request_id,session_id,state,state_sha256,updated_at,version,workspace_id':'authority_sha256,created_at,execution_authorized,native_identity_sha256,owner_id,project_id,protocol,request_id,session_id,state,state_sha256,updated_at,version,workspace_id')
  ||value.protocol!==1||value.execution_authorized!==false||!uuid(value.request_id)||value.request_id!==expected.request_id
  ||!workspace(value.workspace_id)||value.workspace_id!==expected.workspace_id||value.project_id!==expected.project_id||value.project_id!==undefined&&!projectId(value.project_id)
  ||typeof value.owner_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value.owner_id)
  ||typeof value.session_id!=='string'||!value.session_id.startsWith('jot-standalone-')||!uuid(value.session_id.slice('jot-standalone-'.length))
  ||!['prepared','dispatched','ready','unknown','cancelled'].includes(value.state)||!Number.isSafeInteger(value.version)||value.version<1
  ||!hash(value.state_sha256)||!hash(value.authority_sha256)||typeof value.created_at!=='string'||typeof value.updated_at!=='string'
  ||(value.state==='ready'?!hash(value.native_identity_sha256):value.native_identity_sha256!==null))throw Error('standalone_terminal_receipt_invalid');
 return Object.freeze({...value});
}
export function validateStandaloneTerminalCatalog(value,before){
 if(before!==null&&!uuid(before)||!object(value)||Object.keys(value).sort().join(',')!=='before_request_id,execution_authorized,items,next_before_request_id,protocol'
  ||value.protocol!==1||value.execution_authorized!==false||value.before_request_id!==before||!Array.isArray(value.items)||value.items.length>50
  ||value.next_before_request_id!==null&&!uuid(value.next_before_request_id))throw Error('standalone_terminal_catalog_invalid');
 const items=value.items.map(item=>validateStandaloneTerminalAdmission(item,{request_id:item?.request_id,workspace_id:item?.workspace_id,...(item?.project_id===undefined?{}:{project_id:item.project_id})}));
 for(let index=0;index<items.length;index++){
  const item=items[index],previous=items[index-1],time=Date.parse(item.created_at);
  if(!Number.isFinite(time)||new Date(time).toISOString()!==item.created_at||item.request_id===before||item.owner_id!==items[0].owner_id
   ||previous&&(previous.created_at<item.created_at||previous.created_at===item.created_at&&previous.request_id<=item.request_id))throw Error('standalone_terminal_catalog_invalid');
 }
 if(new Set(items.map(item=>item.request_id)).size!==items.length||value.next_before_request_id!==null&&(items.length!==50||value.next_before_request_id!==items.at(-1)?.request_id))throw Error('standalone_terminal_catalog_invalid');
 return Object.freeze({...value,items});
}
/** Only request identity is kept; native grants and Session creation remain server-owned. */
export class StandaloneTerminalSessionStore{
 constructor(storage,scope){
  if(!hash(scope))throw Error('terminal_storage_scope_invalid');
  this.storage=storage;this.key=`jot-standalone-terminal-sessions/v1/${scope}`;
 }
 validate(item){
  if(!object(item)||!['request_id,workspace_id','project_id,request_id,workspace_id'].includes(Object.keys(item).sort().join(','))||!uuid(item.request_id)||!workspace(item.workspace_id)||item.project_id!==undefined&&!projectId(item.project_id))throw Error('standalone_terminal_storage_invalid');
  return{request_id:item.request_id,workspace_id:item.workspace_id,...(item.project_id===undefined?{}:{project_id:item.project_id})};
 }
 read(){
  const raw=this.storage.getItem(this.key);if(raw===null)return[];
  if(raw.length>1048576)throw Error('standalone_terminal_storage_invalid');
  const value=JSON.parse(raw);
  if(!object(value)||Object.keys(value).sort().join(',')!=='items,version'||value.version!==1||!Array.isArray(value.items)||value.items.length>64)throw Error('standalone_terminal_storage_invalid');
  const items=value.items.map(item=>this.validate(item));
  if(new Set(items.map(item=>item.request_id)).size!==items.length)throw Error('standalone_terminal_storage_invalid');
  return items;
 }
 remove(input){
  const item=this.validate(input),items=this.read(),prior=items.find(row=>row.request_id===item.request_id);
  if(prior&&(prior.workspace_id!==item.workspace_id||prior.project_id!==item.project_id))throw Error('terminal_storage_conflict');
  if(!prior)return items;
  const next=items.filter(row=>row.request_id!==item.request_id);
  this.storage.setItem(this.key,JSON.stringify({version:1,items:next}));return next;
 }
 add(input){
  const item=this.validate(input),items=this.read(),prior=items.find(row=>row.request_id===item.request_id);
  if(prior&&(prior.workspace_id!==item.workspace_id||prior.project_id!==item.project_id))throw Error('terminal_storage_conflict');
  if(prior)return items;
  if(items.length>=64)throw Error('standalone_terminal_storage_full');
  const next=[item,...items],raw=JSON.stringify({version:1,items:next});
  if(raw.length>1048576)throw Error('standalone_terminal_storage_invalid');
  this.storage.setItem(this.key,raw);return next;
 }
}
