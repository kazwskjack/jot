import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

type ReadInput={owner:string;workspace:string;project:string;path:string;version:number;runId:string};
type ReadOutput={path:string;version:number;sha256:string;size:number;content:string};
type Reader=(input:ReadInput)=>ReadOutput;
// Each Gateway/Worker database connection explicitly installs its own trusted
// workspace service reader. No process-global root or caller-supplied path.
const readers=new WeakMap<DatabaseSync,Reader>();
export function configureTaskOutputReader(db:DatabaseSync,reader:Reader):void {
 if(readers.has(db))throw new Error('task_output_reader_already_configured');
 readers.set(db,reader);
}
export function verifyTaskOutputContent(db:DatabaseSync,input:ReadInput,expected:{sha256:string;size:number}):ReadOutput {
 const reader=readers.get(db);if(!reader)throw new Error('task_output_reader_unavailable');
 try{
  const result=reader(input);
  if(result.path!==input.path||result.version!==input.version||result.sha256!==expected.sha256||result.size!==expected.size
    ||typeof result.content!=='string'||Buffer.byteLength(result.content)!==expected.size
    ||createHash('sha256').update(result.content).digest('hex')!==expected.sha256)throw new Error('content_mismatch');
  return result;
 }catch{throw new Error('task_completion_output_integrity_failed');}
}
