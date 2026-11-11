import {validateTerminalCommand} from '../../packages/gateway/src/terminal/control.js';

/** Same-tab recovery keeps the original owner-scoped command before dispatch. */
class TerminalCommandJournal {
  constructor(storage,scope,path) {
    if(typeof scope!=='string'||!/^[a-f0-9]{64}$/.test(scope))throw Error('terminal_storage_scope_invalid');
    this.storage=storage;
    this.path=path;
    this.key=`jot-terminal-command/v1/${scope}${this.path}`;
  }
  validate(command) {
    if(!command||typeof command!=='object'||Array.isArray(command)
      ||Object.keys(command).sort().join(',')!=='body,key,method,path'
      ||command.path!==this.path||command.method!=='POST'||command.key!==command.body?.request_id)
      throw Error('terminal_storage_command_invalid');
    validateTerminalCommand(command.body);
    return command;
  }
  read() {
    const raw=this.storage.getItem(this.key);
    if(raw===null)return null;
    if(raw.length>1048576)throw Error('terminal_storage_command_invalid');
    const value=JSON.parse(raw);
    if(value&&typeof value==='object'&&!Array.isArray(value)){
      const keys=Object.keys(value).sort().join(',');
      if(keys==='command,end_wait_requested'&&value.end_wait_requested===true
        ||keys==='command,recovery_only'&&value.recovery_only===true
        ||keys==='command,end_wait_requested,recovery_only'&&value.end_wait_requested===true&&value.recovery_only===true)
        return {command:this.validate(value.command),endingWait:value.end_wait_requested===true,recoveryOnly:value.recovery_only===true};
    }
    return {command:this.validate(value),endingWait:false,recoveryOnly:false};
  }
  saveCommand(command,expected) {
    if(command===null){this.complete(expected);return;}
    this.validate(command);
    const snapshot=this.read(),current=snapshot?.command;
    if(current&&(current.key!==command.key||Object.entries(current.body).some(([key,value])=>command.body[key]!==value)))
      throw Error('terminal_storage_conflict');
    const raw=JSON.stringify(snapshot?.endingWait||snapshot?.recoveryOnly?{command,...(snapshot?.endingWait?{end_wait_requested:true}:{}),...(snapshot?.recoveryOnly?{recovery_only:true}:{})}:command);
    if(raw.length>1048576)throw Error('terminal_storage_command_invalid');
    this.storage.setItem(this.key,raw);
  }
  restoreCommand(command){
    this.validate(command);const snapshot=this.read(),current=snapshot?.command;
    if(current&&(current.key!==command.key||Object.entries(current.body).some(([key,value])=>command.body[key]!==value)))throw Error('terminal_storage_conflict');
    const raw=JSON.stringify({command,recovery_only:true,...(snapshot?.endingWait?{end_wait_requested:true}:{})});
    if(raw.length>1048576)throw Error('terminal_storage_command_invalid');
    this.storage.setItem(this.key,raw);
  }
  requestEndWait(expected) {
    this.validate(expected);
    const snapshot=this.read(),current=snapshot?.command;
    if(!current||current.key!==expected.key||Object.entries(current.body).some(([key,value])=>expected.body[key]!==value))
      throw Error('terminal_storage_conflict');
    const raw=JSON.stringify({command:current,end_wait_requested:true,...(snapshot?.recoveryOnly?{recovery_only:true}:{})});
    if(raw.length>1048576)throw Error('terminal_storage_command_invalid');
    this.storage.setItem(this.key,raw);
  }
  complete(expected) {
    const current=this.read()?.command;
    if(expected&&current?.key!==expected.key)throw Error('terminal_storage_conflict');
    this.storage.removeItem(this.key);
  }
}

export class TerminalCommandStore extends TerminalCommandJournal {
  constructor(storage,scope,conversationId,runId){
    if(![conversationId,runId].every(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id)))throw Error('terminal_storage_scope_invalid');
    super(storage,scope,`/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/terminals/commands`);
  }
}
export class StandaloneTerminalCommandStore extends TerminalCommandJournal {
  constructor(storage,scope,admissionId){
    if(typeof admissionId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(admissionId))throw Error('terminal_storage_scope_invalid');
    super(storage,scope,`/standalone-terminals/admissions/${encodeURIComponent(admissionId)}/terminals/commands`);
  }
}

export function pendingTerminalRuns(storage,scope,conversationId) {
  const probe=new TerminalCommandStore(storage,scope,conversationId,'scope-probe');
  const prefix=probe.key.slice(0,probe.key.indexOf('/runs/')+6),suffix='/terminals/commands',runs=[];
  for(let index=0;index<storage.length;index++) {
    const key=storage.key(index);
    if(typeof key!=='string'||!key.startsWith(prefix)||!key.endsWith(suffix))continue;
    const runId=decodeURIComponent(key.slice(prefix.length,-suffix.length));
    if(new TerminalCommandStore(storage,scope,conversationId,runId).read()?.command)runs.push(runId);
  }
  return [...new Set(runs)].sort();
}
