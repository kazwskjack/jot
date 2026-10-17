import {createHash} from 'node:crypto';
import {types} from 'node:util';
import type {DatabaseSync} from 'node:sqlite';
import type {TaskFileSource,TaskFileLocation} from './task-file-source.ts';
export type TaskOutputReadInput={owner:string;workspace:string;project:string;path:string;version:number;runId:string;source?:TaskFileSource};
export type TaskOutputReadResult={path:string;version:number;sha256:string;size:number;content:string;source?:TaskFileLocation};
type Reader=(input:TaskOutputReadInput)=>TaskOutputReadResult;
const readers=new WeakMap<DatabaseSync,Reader>();
export function configureTaskOutputReader(db:DatabaseSync,reader:Reader):void {
 if(readers.has(db))throw new Error('task_output_reader_already_configured');readers.set(db,reader);
}
export function taskFileLocation(value:TaskFileLocation):TaskFileLocation{
 if(!value||typeof value!=='object')throw Error('invalid_location');
 if(value.source==='workspace'&&!['cycle_id','snapshot_id','isolated_receipt_id'].some(k=>k in value))return {source:'workspace'};
 if(value.source==='isolated'&&['cycle_id','snapshot_id','isolated_receipt_id'].every(k=>typeof (value as unknown as Record<string,unknown>)[k]==='string'&&!!(value as unknown as Record<string,unknown>)[k]))return {source:'isolated',cycle_id:value.cycle_id,snapshot_id:value.snapshot_id,isolated_receipt_id:value.isolated_receipt_id};
 throw Error('invalid_location');
}
export function sameTaskFileLocation(a:TaskFileLocation,b:TaskFileLocation):boolean{try{return JSON.stringify(taskFileLocation(a))===JSON.stringify(taskFileLocation(b));}catch{return false;}}
export function verifyTaskOutputContent(db:DatabaseSync,input:TaskOutputReadInput,expected:{sha256:string;size:number}):TaskOutputReadResult {
 const reader=readers.get(db);if(!reader)throw new Error('task_output_reader_unavailable');
 try{
  const location=input.source===undefined?{source:'workspace'} as const:taskFileLocation(input.source);
  if(input.source&&(input.source.owner_id!==input.owner||input.source.workspace_id!==input.workspace||input.source.project_id!==input.project||input.source.path!==input.path||input.source.version!==input.version||input.source.sha256!==expected.sha256||input.source.size!==expected.size))throw Error('source_mismatch');
  const result=reader(input);
  if(types.isPromise(result)){
   // Consume only a real Promise rejection through the intrinsic method. Never
   // assimilate an arbitrary thenable or invoke its continuation as cleanup.
   void Promise.prototype.then.call(result,undefined,()=>{});
   throw Error('reader_must_be_synchronous');
  }
  if(result&&(typeof result==='object'||typeof result==='function')&&'then' in result&&typeof result.then==='function')throw Error('reader_must_be_synchronous');
  const returned=result.source===undefined?{source:'workspace'} as const:taskFileLocation(result.source);
  if(!sameTaskFileLocation(location,returned)||result.path!==input.path||result.version!==input.version||result.sha256!==expected.sha256||result.size!==expected.size||typeof result.content!=='string'||Buffer.byteLength(result.content)!==expected.size||createHash('sha256').update(result.content).digest('hex')!==expected.sha256)throw Error('content_mismatch');return result;
 }catch{throw new Error('task_completion_output_integrity_failed');}
}
