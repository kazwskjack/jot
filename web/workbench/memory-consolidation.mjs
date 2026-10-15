export function consolidationMatches(batch,selection){return !!batch&&batch.project_id===selection.project_id&&batch.scope===selection.scope&&(batch.scope==='project'?batch.agent_id==null:batch.agent_id===selection.agent_id);}
export function consolidationCommand(batch,action){
 const allowed={apply:['proposed'],reject:['draft','proposed'],rollback:['applied']};
 if(!allowed[action]?.includes(batch?.status)||!Number.isSafeInteger(batch?.version)||batch.version<1)throw new Error('整理状态已变化，请刷新后重新确认。');
 return {expected_version:batch.version};
}
export function consolidationPreview(batch){
 const sources=new Map(batch.sources.map(source=>[source.memory_id,source])),changes=batch.proposal?.changes??[];
 return changes.map(change=>{
  const source=sources.get(change.memory_id);if(!source)throw new Error('整理来源缺失，不能应用。');
  if(change.action==='rewrite')return {...change,before:source.content,after:change.content,source_version:source.version};
  const replacement=sources.get(change.replacement_id);if(change.action!=='supersede'||!replacement)throw new Error('整理目标缺失，不能应用。');
  const rewritten=changes.find(item=>item.memory_id===change.replacement_id&&item.action==='rewrite');
  return {...change,before:source.content,source_version:source.version,replacement_content:rewritten?.content??replacement.content};
 });
}
