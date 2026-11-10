import type {TerminalInfo} from './inventory.js';
export type TerminalAttachment=Readonly<{attachment_id:string;host_instance:string}>;
export type TerminalInput=Readonly<{type:'write';sequence:number;data:string}|{type:'resize';sequence:number;cols:number;rows:number}>;
export type TerminalInputPacket=Readonly<{host_instance:string;command:TerminalInput}>;
export type TerminalAttached=Readonly<{protocol:1;type:'attached';session_id:string;terminal_id:string;attachment_id:string;host_instance:string;execution_authorized:false}>;
export type TerminalQueued=Readonly<{protocol:1;state:'queued';attachment_id:string;sequence:number;execution_authorized:false}>;
export type TerminalFrame=Readonly<{type:'snapshot';sequence:number;screen:string;info:TerminalInfo;writable:boolean;inputWindow?:Readonly<{maxBytes:number;frameOverheadBytes:number}>}
  |{type:'output';sequence:number;data:string}|{type:'state';info:TerminalInfo;writable:boolean}|{type:'ack';sequence:number;refusal?:'read-only'|'not-running'}>;
export function validateTerminalAttachment(value:unknown):TerminalAttachment;
export function validateTerminalInput(value:unknown):TerminalInput;
export function validateTerminalInputPacket(value:unknown):TerminalInputPacket;
export function validateTerminalAttached(value:unknown,expected:TerminalAttachment&{session_id:string;terminal_id:string}):TerminalAttached;
export function validateTerminalQueued(value:unknown,attachmentId:string,sequence:number):TerminalQueued;
export function projectTerminalFrame(value:unknown,sessionId:string,terminalId:string):TerminalFrame;
