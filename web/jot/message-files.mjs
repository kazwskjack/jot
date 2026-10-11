export function messageFiles(state,message){
 const files=Object.values(state.artifacts);
 if(message.role==='user')return (message.attachments??[]).map(id=>files.find(file=>file.artifact_id===id&&file.origin==='upload')).filter(Boolean);
 if(message.role!=='assistant'||message.status!=='complete'||!message.run_id||state.runs[message.run_id]?.status!=='succeeded')return [];
 const answers=Object.values(state.messages).filter(value=>value.role==='assistant'&&value.run_id===message.run_id&&value.status==='complete');
 const assigned=new Set(answers.flatMap(value=>value.attachments??[]));
 const final=answers.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.message_id.localeCompare(b.message_id)).at(-1);
 const order=message.attachments??[];
 return files.filter(file=>file.origin!=='upload'&&file.run_id===message.run_id&&file.status==='ready'&&(order.includes(file.artifact_id)||(message.message_id===final?.message_id&&!assigned.has(file.artifact_id))))
  .sort((a,b)=>{const first=order.indexOf(a.artifact_id),second=order.indexOf(b.artifact_id);if(first>=0||second>=0)return first<0?1:second<0?-1:first-second;return (a.created_at??'').localeCompare(b.created_at??'')||a.artifact_id.localeCompare(b.artifact_id);});
}
