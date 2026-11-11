import {validateTerminalCommand} from '../../packages/gateway/src/terminal/control.js';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function validateStandaloneTerminalCommandCatalog(value,admission,before){
 const fail=()=>{throw Error('standalone_terminal_command_catalog_invalid');};
 if(admission?.state!=='ready'||before!==null&&!uuid(before)||!object(value)
  ||Object.keys(value).sort().join(',')!=='admission_id,admission_state_sha256,before_request_id,execution_authorized,items,next_before_request_id,protocol,session_id'
  ||value.protocol!==1||value.execution_authorized!==false||value.admission_id!==admission.request_id||value.session_id!==admission.session_id
  ||value.admission_state_sha256!==admission.state_sha256||value.before_request_id!==before||!Array.isArray(value.items)||value.items.length>50
  ||value.next_before_request_id!==null&&!uuid(value.next_before_request_id))return fail();
 const items=value.items.map(item=>{
  if(!object(item)||Object.keys(item).sort().join(',')!=='command,command_sha256,created_at,native_attempted_at,receipt_state,request_id'
   ||!uuid(item.request_id)||!hash(item.command_sha256)||!date(item.created_at)||item.native_attempted_at!==null&&!date(item.native_attempted_at)
   ||!['unknown','completed','rejected','wait_ended_unknown'].includes(item.receipt_state)
   ||['completed','rejected'].includes(item.receipt_state)&&item.native_attempted_at===null)return fail();
  const command=validateTerminalCommand(item.command);if(command.request_id!==item.request_id)return fail();
  return Object.freeze({...item,command});
 });
 for(let index=0;index<items.length;index++){
  const item=items[index],previous=items[index-1];
  if(item.request_id===before||previous&&(previous.created_at<item.created_at||previous.created_at===item.created_at&&previous.request_id<=item.request_id))return fail();
 }
 if(new Set(items.map(item=>item.request_id)).size!==items.length||value.next_before_request_id!==null&&(items.length!==50||value.next_before_request_id!==items.at(-1)?.request_id))return fail();
 return Object.freeze({...value,items});
}
