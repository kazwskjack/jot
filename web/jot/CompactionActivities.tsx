import {useApplicationLanguage,useApplicationText} from './application-language';
import React from 'react';
import type {Activity,Run} from './types';
/** Render only native metadata. Summary, provider output and raw errors stay private. */
export default function CompactionActivities({activities,runs}:{activities:Activity[];runs:Record<string,Run>}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const labels={running:t('正在压缩上下文','Compacting Context'),succeeded:t('上下文已整理','Context Compacted'),failed:t('上下文整理失败','Context Compaction Failed'),cancelled:t('上下文整理已取消','Context Compaction Cancelled'),unknown:t('上下文整理状态待确认','Context Compaction Status Unconfirmed')};
 const values=activities.filter(value=>value.kind==='compaction');
 if(!values.length)return null;
 return <div lang={language} className="jot-compaction-activities" aria-label={t('上下文整理','Context Compaction')}>{values.map(value=>{
  let status=value.status as keyof typeof labels;
  if(status==='running'){
   const run=runs[value.run_id];
   if(run?.status==='cancelled')status='cancelled';
   else if(run&&['succeeded','failed','interrupted','partial'].includes(run.status))status='unknown';
  }
  return <p key={value.activity_id} role="status" aria-live="polite" aria-busy={status==='running'} data-compaction-status={status}>{labels[status]??labels.unknown}</p>;
 })}</div>;
}
