import {fixture} from './task-wait-fixture.mjs';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
export const candidate={text:'The report is ready. This still needs the user to verify its criteria.',blocks:[{kind:'text',text:'The report is ready. This still needs the user to verify its criteria.'}]};
export const prepare=async f=>{
 const proof=new TaskExecutionEvidence(f.db).record(f.runId,'observed-read','universe_read_page',{url:'https://fixture.invalid/report',title:'Observed report'});
 f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Read report',acceptance:'The source supports the report conclusion.',status:'completed',evidence:[proof]},f.runId);
};
export const completionFixture=(t,options={})=>fixture(t,'complete',{beforeRun:options.beforeRun,prepare:async f=>{
 await prepare(f);
 const proof=new TaskExecutionEvidence(f.db).record(f.runId,'observed-second-read','universe_read_page',{url:'https://fixture.invalid/second',title:'Independent source'});
 f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Check second source',acceptance:'The independent source agrees with the main conclusion.',status:'completed',evidence:[proof]},f.runId);
 if(options.prepare)await options.prepare(f);
},candidate:options.candidate??candidate});
