import type {DatabaseSync} from 'node:sqlite';
import {validateTerminalInventory} from './inventory.js';
import {validateTerminalOptions,validateTerminalCommand,validateTerminalReceipt,type TerminalCommand} from './control.js';
import {reserveStandaloneTerminalCommand,readStandaloneTerminalCommandReceipt,settleStandaloneTerminalCommand} from './standalone-commands.ts';
import {prepareStandaloneTerminalAdmission,readStandaloneTerminalAdmission,claimStandaloneTerminalAdmission,cancelStandaloneTerminalAdmission,
 markStandaloneTerminalUnknown,confirmStandaloneTerminalAdmission,type StandaloneTerminalAdmission} from './standalone-admissions.ts';

type Authority={protocol:1;owner_id:string;workspace_id:string;profile_id:string;authority_sha256:string;execution_authorized:false};
type Observation={protocol:1;owner_id:string;workspace_id:string;session_id:string;authority_sha256:string;
 status:'ready'|'unknown';native_identity_sha256:string|null;execution_authorized:false};
export interface StandaloneTerminalClient{
 readAuthority(owner:string,workspace:string,signal:AbortSignal):Promise<unknown>;
 createSession(admission:StandaloneTerminalAdmission,signal:AbortSignal):Promise<unknown>;
 observeSession(admission:StandaloneTerminalAdmission,signal:AbortSignal):Promise<unknown>;
 readInventory?(admission:StandaloneTerminalAdmission,signal:AbortSignal):Promise<unknown>;
 standaloneTerminalOptions?(admission:StandaloneTerminalAdmission,signal:AbortSignal):Promise<unknown>;
 recoverStandaloneTerminal?(admission:StandaloneTerminalAdmission,signal:AbortSignal):Promise<unknown>;
 standaloneTerminalCommand?(admission:StandaloneTerminalAdmission,command:TerminalCommand,signal:AbortSignal):Promise<unknown>;
 standaloneTerminalReceipt?(admission:StandaloneTerminalAdmission,command:TerminalCommand,signal:AbortSignal):Promise<unknown>;
}
export type StandaloneTerminalExpected={request_id:string;expected_version:number;expected_state_sha256:string};
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function authority(value:unknown,owner:string,workspace:string):Authority{
 if(!plain(value)||Object.keys(value).sort().join(',')!=='authority_sha256,execution_authorized,owner_id,profile_id,protocol,workspace_id'
  ||value.protocol!==1||value.execution_authorized!==false||value.owner_id!==owner||value.workspace_id!==workspace
  ||!id(value.profile_id)||!hash(value.authority_sha256))throw Error('standalone_terminal_authority_invalid');
 return value as unknown as Authority;
}
function observation(value:unknown,source:StandaloneTerminalAdmission):Observation{
 if(!plain(value)||Object.keys(value).sort().join(',')!=='authority_sha256,execution_authorized,native_identity_sha256,owner_id,protocol,session_id,status,workspace_id'
  ||value.protocol!==1||value.execution_authorized!==false||value.owner_id!==source.owner_id||value.workspace_id!==source.workspace_id
  ||value.session_id!==source.session_id||value.authority_sha256!==source.authority_sha256
  ||!['ready','unknown'].includes(String(value.status))
  ||(value.status==='ready'?!hash(value.native_identity_sha256):value.native_identity_sha256!==null))throw Error('standalone_terminal_native_identity_changed');
 return value as unknown as Observation;
}
async function nativeCall<T>(signal:AbortSignal,operation:(bounded:AbortSignal)=>Promise<T>):Promise<T>{
 const bounded=AbortSignal.any([signal,AbortSignal.timeout(30000)]);bounded.throwIfAborted();
 let abort:()=>void=()=>{};
 const pending=Promise.resolve().then(()=>{bounded.throwIfAborted();return operation(bounded);});
 const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(bounded.reason);bounded.addEventListener('abort',abort,{once:true});if(bounded.aborted)abort();});
 try{return await Promise.race([pending,cancelled]);}finally{bounded.removeEventListener('abort',abort);}
}
const expected=(row:StandaloneTerminalAdmission)=>({owner_id:row.owner_id,request_id:row.request_id,expected_version:row.version,
 expected_state_sha256:row.state_sha256,authority_sha256:row.authority_sha256});

/** Only a configured authenticated native client supplies authority and Session observations. */
export class StandaloneTerminalAdmissions{
 private readonly workspaces:Set<string>;
 constructor(private readonly db:DatabaseSync,workspaces:readonly string[],private readonly client?:StandaloneTerminalClient){
  if(client&&['readAuthority','createSession','observeSession'].some(method=>typeof client[method as keyof StandaloneTerminalClient]!=='function'))throw Error('standalone_terminal_native_configuration_invalid');
  this.workspaces=new Set(workspaces);
 }
 private scope(workspace:string){if(!this.workspaces.has(workspace))throw Error('standalone_terminal_workspace_forbidden');}
 read(owner:string,request:string){const row=readStandaloneTerminalAdmission(this.db,owner,request);if(row)this.scope(row.workspace_id);return row;}
 private current(owner:string,input:StandaloneTerminalExpected){
  const row=this.read(owner,input.request_id);
  if(!row)throw Error('standalone_terminal_admission_missing');
  if(!Number.isSafeInteger(input.expected_version)||input.expected_version<1||!hash(input.expected_state_sha256))throw Error('standalone_terminal_input_invalid');
  if(row.version!==input.expected_version||row.state_sha256!==input.expected_state_sha256)throw Error('standalone_terminal_state_changed');
  return row;
 }
 async prepare(owner:string,input:{request_id:string;workspace_id:string},signal:AbortSignal){
  signal.throwIfAborted();this.scope(input.workspace_id);
  const previous=this.read(owner,input.request_id);
  if(previous){if(previous.workspace_id!==input.workspace_id)throw Error('standalone_terminal_request_conflict');return previous;}
  if(!this.client)throw Error('standalone_terminal_native_unavailable');
  const source=authority(await nativeCall(signal,bounded=>this.client!.readAuthority(owner,input.workspace_id,bounded)),owner,input.workspace_id);
  signal.throwIfAborted();this.scope(input.workspace_id);
  return prepareStandaloneTerminalAdmission(this.db,{owner_id:owner,request_id:input.request_id,workspace_id:input.workspace_id,authority_sha256:source.authority_sha256});
 }
 cancel(owner:string,input:StandaloneTerminalExpected){return cancelStandaloneTerminalAdmission(this.db,expected(this.current(owner,input)));}
 private unknown(owner:string,request:string){
  // Concurrent observations may already have settled this exact admission.
  let row=this.read(owner,request);
  if(!row)throw Error('standalone_terminal_admission_missing');
  if(row.state==='dispatched')try{return markStandaloneTerminalUnknown(this.db,expected(row));}
   catch{row=this.read(owner,request);if(!row)throw Error('standalone_terminal_admission_missing');}
  return row;
 }
 private confirm(owner:string,row:StandaloneTerminalAdmission,value:unknown){
  const native=observation(value,row);
  if(native.status==='unknown')return this.unknown(owner,row.request_id);
  try{return confirmStandaloneTerminalAdmission(this.db,{...expected(row),session_id:row.session_id,native_identity_sha256:native.native_identity_sha256!});}
  catch(error){const current=this.read(owner,row.request_id);
   if(current?.state==='ready'&&current.session_id===row.session_id&&current.authority_sha256===row.authority_sha256
    &&current.native_identity_sha256===native.native_identity_sha256)return current;
   throw error;
  }
 }
 async dispatch(owner:string,input:StandaloneTerminalExpected,signal:AbortSignal){
  signal.throwIfAborted();const original=this.current(owner,input);
  if(original.state!=='prepared')throw Error('standalone_terminal_transition_invalid');
  if(!this.client)throw Error('standalone_terminal_native_unavailable');
  const source=authority(await nativeCall(signal,bounded=>this.client!.readAuthority(owner,original.workspace_id,bounded)),owner,original.workspace_id);
  signal.throwIfAborted();this.scope(original.workspace_id);
  if(source.authority_sha256!==original.authority_sha256)throw Error('standalone_terminal_authority_changed');
  const claimed=claimStandaloneTerminalAdmission(this.db,expected(original));
  try{
   // This is the only creation call. A lost response never re-enters it.
   const value=await nativeCall(signal,bounded=>this.client!.createSession(claimed,bounded));signal.throwIfAborted();
   return this.confirm(owner,claimed,value);
  }catch{return this.unknown(owner,claimed.request_id);}
 }
 private commandAdmission(owner:string,request:string){
  const row=this.read(owner,request);
  if(!row)throw Error('standalone_terminal_admission_missing');
  if(row.state!=='ready')throw Error('standalone_terminal_transition_invalid');
  return row;
 }
 async terminalCommand(owner:string,request:string,input:TerminalCommand,signal:AbortSignal){
  signal.throwIfAborted();const row=this.commandAdmission(owner,request),command=validateTerminalCommand(input);
  if(typeof this.client?.standaloneTerminalCommand!=='function')throw Error('standalone_terminal_native_unavailable');
  const claim=reserveStandaloneTerminalCommand(this.db,row,command);
  if(!claim.fresh){
   const saved=readStandaloneTerminalCommandReceipt(this.db,row,command);
   if(saved.state==='completed')return saved.inventory!;
   throw Error(saved.state==='wait_ended_unknown'?'terminal_wait_ended_unknown':'terminal_outcome_unknown');
  }
  try{
   const inventory=validateTerminalInventory(await nativeCall(signal,bounded=>this.client!.standaloneTerminalCommand!(row,command,bounded)),row.session_id);
   signal.throwIfAborted();this.scope(row.workspace_id);
   const receipt=settleStandaloneTerminalCommand(this.db,row,command,validateTerminalReceipt({protocol:1,session_id:row.session_id,
    host_instance:command.host_instance,request_id:command.request_id,state:'completed',inventory,rejection:null,execution_authorized:false},command,row.session_id));
   if(receipt.state!=='completed')throw Error('terminal_wait_ended_unknown');
   return receipt.inventory!;
  }catch(error){
   if((error as Error)?.message==='terminal_wait_ended_unknown')throw error;
   throw Error('terminal_outcome_unknown');
  }
 }
 async terminalReceipt(owner:string,request:string,input:TerminalCommand,signal:AbortSignal,endWait=false){
  signal.throwIfAborted();const row=this.commandAdmission(owner,request),command=validateTerminalCommand(input);
  if(endWait)reserveStandaloneTerminalCommand(this.db,row,command);
  const saved=readStandaloneTerminalCommandReceipt(this.db,row,command);
  if(saved.state!=='unknown')return saved;
  if(endWait)return settleStandaloneTerminalCommand(this.db,row,command,{...saved,state:'wait_ended_unknown'});
  if(typeof this.client?.standaloneTerminalReceipt!=='function')return saved;
  let value;
  try{value=validateTerminalReceipt(await nativeCall(signal,bounded=>this.client!.standaloneTerminalReceipt!(row,command,bounded)),command,row.session_id);}
  catch{signal.throwIfAborted();return readStandaloneTerminalCommandReceipt(this.db,row,command);}
  signal.throwIfAborted();this.scope(row.workspace_id);
  if(value.state==='completed'||value.state==='rejected')return settleStandaloneTerminalCommand(this.db,row,command,value);
  const current=readStandaloneTerminalCommandReceipt(this.db,row,command);
  return current.state==='unknown'&&value.state==='pending'?value:current;
 }
 async terminalOptions(owner:string,request:string,signal:AbortSignal,recover=false){
  signal.throwIfAborted();const row=this.read(owner,request);
  if(!row)throw Error('standalone_terminal_admission_missing');
  if(row.state!=='ready')throw Error('standalone_terminal_transition_invalid');
  const operation=recover?this.client?.recoverStandaloneTerminal:this.client?.standaloneTerminalOptions;
  if(typeof operation!=='function')throw Error('standalone_terminal_native_unavailable');
  const value=validateTerminalOptions(await nativeCall(signal,bounded=>operation.call(this.client,row,bounded)),row.session_id);
  signal.throwIfAborted();const current=this.read(owner,request);
  if(!current||current.state_sha256!==row.state_sha256)throw Error('standalone_terminal_state_changed');
  return value;
 }
 async inventory(owner:string,request:string,signal:AbortSignal){
  signal.throwIfAborted();const row=this.read(owner,request);
  if(!row)throw Error('standalone_terminal_admission_missing');
  if(row.state!=='ready')throw Error('standalone_terminal_transition_invalid');
  if(typeof this.client?.readInventory!=='function')throw Error('standalone_terminal_native_unavailable');
  const value=validateTerminalInventory(await nativeCall(signal,bounded=>this.client!.readInventory!(row,bounded)),row.session_id);
  signal.throwIfAborted();const current=this.read(owner,request);
  if(!current||current.state_sha256!==row.state_sha256)throw Error('standalone_terminal_state_changed');
  return value;
 }
 async observe(owner:string,input:StandaloneTerminalExpected,signal:AbortSignal){
  signal.throwIfAborted();const row=this.current(owner,input);
  if(row.state!=='dispatched'&&row.state!=='unknown')return row;
  if(!this.client)throw Error('standalone_terminal_native_unavailable');
  try{
   const value=await nativeCall(signal,bounded=>this.client!.observeSession(row,bounded));signal.throwIfAborted();
   return this.confirm(owner,row,value);
  }catch{return this.unknown(owner,row.request_id);}
 }
}
