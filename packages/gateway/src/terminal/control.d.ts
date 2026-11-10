import type {TerminalInventory} from './inventory.js';
export type TerminalOptions=Readonly<{
  protocol:1;
  session_id:string;
  host_instance:string;
  inventory:TerminalInventory;
  environment:Readonly<{cwd:string;maxBufferedBytes:number;maxCols:number;maxInputBytes:number;maxRows:number;scrollback:number}>;
  shells:readonly Readonly<{name:string;path:string;args:readonly string[]}>[];
  execution_authorized:false;
}>;
export type TerminalCommand=Readonly<{
  action:'create';request_id:string;host_instance:string;terminal_id:string;
  cols:number;rows:number;shell_path:string|null;
}|{action:'close';request_id:string;host_instance:string;terminal_id:string}>;
export function validateTerminalOptions(value:unknown,sessionId:string):TerminalOptions;
export function validateTerminalCommand(value:unknown):TerminalCommand;
export type TerminalReceipt=Readonly<{
  protocol:1;session_id:string;host_instance:string;request_id:string;
  state:'not_admitted'|'pending'|'completed'|'rejected'|'unknown';
  inventory:TerminalInventory|null;
  rejection:Readonly<{status:number;error_code:string}>|null;
  execution_authorized:false;
}>;
export function validateTerminalReceipt(value:unknown,command:TerminalCommand,sessionId:string):TerminalReceipt;
