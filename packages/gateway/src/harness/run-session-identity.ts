import {createHash} from 'node:crypto';
/** Product runtime cursor identity is separate from the DSH controller Session.
 * Keep the existing Worker mapping identical for history and execution checks. */
export function runtimeSessionRefForRun(runId:string):string{
 return `runtime-session-${createHash('sha256').update(runId).digest('hex').slice(0,32)}`;
}
