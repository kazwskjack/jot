import {projectTerminalInventory} from './inventory.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).sort().join(',')===keys;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const terminal=value=>typeof value==='string'&&/^[\w-]{1,128}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;

export function validateTerminalAttachment(value) {
  if(!exact(value,'attachment_id,host_instance')||!uuid(value.attachment_id)||!uuid(value.host_instance))throw Error('terminal_attachment_invalid');
  return Object.freeze({...value});
}

export function validateTerminalInput(value) {
  const write=value?.type==='write';
  if(!exact(value,write?'data,sequence,type':'cols,rows,sequence,type')||!positive(value.sequence)
    ||!['write','resize'].includes(value.type)||write&&typeof value.data!=='string'
    ||!write&&(!positive(value.cols)||value.cols<2||!positive(value.rows)))throw Error('terminal_input_invalid');
  return Object.freeze({...value});
}

export function validateTerminalInputPacket(value) {
  if(!exact(value,'command,host_instance')||!uuid(value.host_instance))throw Error('terminal_input_invalid');
  return Object.freeze({host_instance:value.host_instance,command:validateTerminalInput(value.command)});
}

export function validateTerminalAttached(value,expected) {
  if(!exact(value,'attachment_id,execution_authorized,host_instance,protocol,session_id,terminal_id,type')
    ||value.protocol!==1||value.type!=='attached'||value.execution_authorized!==false
    ||!uuid(value.attachment_id)||!uuid(value.host_instance)||!id(value.session_id)||!terminal(value.terminal_id)
    ||['attachment_id','host_instance','session_id','terminal_id'].some(key=>value[key]!==expected[key]))throw Error('terminal_attachment_invalid');
  return Object.freeze({...value});
}

export function validateTerminalQueued(value,attachmentId,sequence) {
  if(!exact(value,'attachment_id,execution_authorized,protocol,sequence,state')||value.protocol!==1
    ||value.state!=='queued'||value.execution_authorized!==false||value.attachment_id!==attachmentId
    ||!uuid(attachmentId)||!positive(value.sequence)||value.sequence!==sequence)throw Error('terminal_input_receipt_invalid');
  return Object.freeze({...value});
}

export function projectTerminalFrame(value,sessionId,terminalId) {
  const fail=()=>{throw Error('terminal_frame_invalid');};
  if(!object(value))return fail();
  if(value.type==='output') {
    if(!exact(value,'data,sequence,type')||!Number.isSafeInteger(value.sequence)||value.sequence<0||typeof value.data!=='string')return fail();
    return Object.freeze({...value});
  }
  if(value.type==='ack') {
    if(!exact(value,value.refusal===undefined?'sequence,type':'refusal,sequence,type')||!positive(value.sequence)
      ||value.refusal!==undefined&&!['read-only','not-running'].includes(value.refusal))return fail();
    return Object.freeze({...value});
  }
  if(value.type!=='snapshot'&&value.type!=='state')return fail();
  const snapshot=value.type==='snapshot';
  if(!exact(value,snapshot?(value.inputWindow===undefined?'info,screen,sequence,type,writable':'info,inputWindow,screen,sequence,type,writable'):'info,type,writable')
    ||typeof value.writable!=='boolean'||snapshot&&(typeof value.screen!=='string'||!Number.isSafeInteger(value.sequence)||value.sequence<0))return fail();
  if(snapshot&&value.inputWindow!==undefined&&(!exact(value.inputWindow,'frameOverheadBytes,maxBytes')
    ||!positive(value.inputWindow.maxBytes)||!Number.isSafeInteger(value.inputWindow.frameOverheadBytes)||value.inputWindow.frameOverheadBytes<0))return fail();
  const info=projectTerminalInventory(sessionId,[value.info]).terminals[0];
  if(info.id!==terminalId)return fail();
  return Object.freeze({...value,info,...(value.inputWindow?{inputWindow:Object.freeze({...value.inputWindow})}:{})});
}
