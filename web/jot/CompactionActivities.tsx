import React from 'react';
import type {Activity,Run} from './types';
const labels={running:'正在压缩上下文',succeeded:'上下文已整理',failed:'上下文整理失败',cancelled:'上下文整理已取消',unknown:'上下文整理状态待确认'};
/** Render only native metadata. Summary, provider output and raw errors stay private. */
export default function CompactionActivities({activities,runs}:{activities:Activity[];runs:Record<string,Run>}){
 const values=activities.filter(value=>value.kind==='compaction');
 if(!values.length)return null;
 return <div className="jot-compaction-activities" aria-label="上下文整理">{values.map(value=>{
  let status=value.status as keyof typeof labels;
  if(status==='running'){
   const run=runs[value.run_id];
   if(run?.status==='cancelled')status='cancelled';
   else if(run&&['succeeded','failed','interrupted','partial'].includes(run.status))status='unknown';
  }
  return <p key={value.activity_id} role="status" aria-live="polite" aria-busy={status==='running'} data-compaction-status={status}>{labels[status]??labels.unknown}</p>;
 })}</div>;
}
