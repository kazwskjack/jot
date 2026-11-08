import {randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,rm} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {normalizeDesktopNotificationPreferences} from './notification-policy.mjs';

const allowedEvents=new Set(['changed','completed','failed','needs_confirmation']);
const maxSeen=2000;
const identityKeys=['task_id','occurrence_id','generation','event_kind'];
const stateKeys=['version','preferences','seen','initialized_at'];

function corrupt(){throw new Error('desktop_notification_state_corrupt');}
function exactKeys(value,keys){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype&&
  Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
}
function normalizeIdentity(value){
 if(!exactKeys(value,identityKeys)||typeof value.task_id!=='string'||!value.task_id||value.task_id.length>200||
  typeof value.occurrence_id!=='string'||!value.occurrence_id||value.occurrence_id.length>200||
  !Number.isSafeInteger(value.generation)||value.generation<1||!allowedEvents.has(value.event_kind))corrupt();
 return {task_id:value.task_id,occurrence_id:value.occurrence_id,generation:value.generation,event_kind:value.event_kind};
}
function keyOf(identity){return JSON.stringify(identityKeys.map(key=>identity[key]));}
function normalizeState(value){
 if(!exactKeys(value,stateKeys)||value.version!==1||!Array.isArray(value.seen)||value.seen.length>maxSeen||
  !(value.initialized_at===null||(typeof value.initialized_at==='string'&&Number.isFinite(Date.parse(value.initialized_at)))))corrupt();
 let preferences;
 try{preferences=normalizeDesktopNotificationPreferences(value.preferences);}catch{corrupt();}
 const seen=value.seen.map(item=>{
  if(!exactKeys(item,[...identityKeys,'shown_at'])||typeof item.shown_at!=='string'||!Number.isFinite(Date.parse(item.shown_at)))corrupt();
  return {...normalizeIdentity(Object.fromEntries(identityKeys.map(key=>[key,item[key]]))),shown_at:item.shown_at};
 });
 if(new Set(seen.map(keyOf)).size!==seen.length)corrupt();
 return Object.freeze({version:1,preferences,seen:Object.freeze(seen.map(item=>Object.freeze(item))),initialized_at:value.initialized_at===null?null:new Date(value.initialized_at).toISOString()});
}
function defaultState(){return normalizeState({version:1,preferences:{enabled:false,quiet_hours:null},seen:[],initialized_at:null});}

export async function loadDesktopNotificationState(filePath){
 if(typeof filePath!=='string'||!isAbsolute(filePath))throw new Error('desktop_notification_state_path_invalid');
 let source;
 try{source=await readFile(filePath,'utf8');}catch(error){if(error?.code==='ENOENT')return defaultState();throw error;}
 let value;try{value=JSON.parse(source);}catch{corrupt();}
 return normalizeState(value);
}
export function initializeDesktopNotificationState(state,startedAt){
 const current=normalizeState(state);
 if(current.initialized_at)return current;
 const time=startedAt instanceof Date?startedAt:new Date(startedAt);
 if(Number.isNaN(time.getTime()))throw new Error('desktop_notification_state_invalid');
 return normalizeState({...current,initialized_at:time.toISOString()});
}
export function markDesktopNotificationSeen(state,identity,shownAt){
 const current=normalizeState(state),normalized=normalizeIdentity(identity),time=typeof shownAt==='string'?shownAt:new Date(shownAt).toISOString();
 if(!Number.isFinite(Date.parse(time)))throw new Error('desktop_notification_state_invalid');
 if(current.seen.some(item=>keyOf(item)===keyOf(normalized)))return {state:current,added:false};
 const seen=[...current.seen,{...normalized,shown_at:new Date(time).toISOString()}].slice(-maxSeen);
 return {state:normalizeState({version:1,preferences:current.preferences,seen,initialized_at:current.initialized_at}),added:true};
}
export async function saveDesktopNotificationState(filePath,state){
 if(typeof filePath!=='string'||!isAbsolute(filePath))throw new Error('desktop_notification_state_path_invalid');
 const normalized=normalizeState(state),directory=dirname(filePath),temporary=filePath+'.'+process.pid+'.'+randomUUID()+'.tmp';
 await mkdir(directory,{recursive:true});
 let handle;
 try{
  handle=await open(temporary,'wx',0o600);
  await handle.writeFile(JSON.stringify(normalized)+'\n','utf8');
  await handle.sync();await handle.close();handle=undefined;
  await rename(temporary,filePath);
  return normalized;
 }catch(error){
  if(handle)await handle.close().catch(()=>{});
  await rm(temporary,{force:true}).catch(()=>{});
  throw error;
 }
}
