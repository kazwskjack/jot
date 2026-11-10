import {validateTerminalInventory} from './inventory.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).sort().join(',')===keys;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const text=value=>typeof value==='string'&&value.length>0&&!value.includes('\0');

export function validateTerminalOptions(value,sessionId) {
  if(!exact(value,'environment,execution_authorized,host_instance,inventory,protocol,session_id,shells')
    ||value.protocol!==1||value.session_id!==sessionId||value.execution_authorized!==false||!uuid(value.host_instance)
    ||!exact(value.environment,'cwd,maxBufferedBytes,maxCols,maxInputBytes,maxRows,scrollback')
    ||!text(value.environment.cwd)||!['maxBufferedBytes','maxCols','maxInputBytes','maxRows'].every(key=>positive(value.environment[key]))
    ||!Number.isSafeInteger(value.environment.scrollback)||value.environment.scrollback<0||!Array.isArray(value.shells)
    ||value.shells.some(shell=>!exact(shell,'args,name,path')||!text(shell.name)||!text(shell.path)
      ||!Array.isArray(shell.args)||shell.args.some(arg=>typeof arg!=='string'||arg.includes('\0'))))throw Error('terminal_options_invalid');
  const inventory=validateTerminalInventory(value.inventory,sessionId);
  return Object.freeze({...value,inventory,environment:Object.freeze({...value.environment}),
    shells:Object.freeze(value.shells.map(shell=>Object.freeze({...shell,args:Object.freeze([...shell.args])})))});
}

export function validateTerminalCommand(value) {
  const create=value?.action==='create';
  if(!exact(value,create?'action,cols,host_instance,request_id,rows,shell_path,terminal_id':'action,host_instance,request_id,terminal_id')
    ||!['create','close'].includes(value.action)||!uuid(value.host_instance)||!uuid(value.request_id)
    ||typeof value.terminal_id!=='string'||!/^[\w-]{1,128}$/.test(value.terminal_id)
    ||create&&(!value.terminal_id.startsWith('jot-')||!uuid(value.terminal_id.slice(4))||!positive(value.cols)||!positive(value.rows)
      ||value.shell_path!==null&&!text(value.shell_path)))throw Error('terminal_command_invalid');
  return Object.freeze({...value});
}
