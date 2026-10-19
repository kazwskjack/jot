export function messageFiles(state,message){
 const files=Object.values(state.artifacts);
 if(message.role==='user'){
  if(Object.hasOwn(message,'attachment_refs')){
   const refs=message.attachment_refs,ids=message.attachments??[];
   if(!Array.isArray(refs)||refs.length!==ids.length||new Set(ids).size!==ids.length)return [];
   if(refs.some((pin,index)=>!pin||pin.artifact_id!==ids[index]||!Number.isSafeInteger(pin.version)||pin.version<1||typeof pin.sha256!=='string'||!/^[a-f0-9]{64}$/.test(pin.sha256)||!Number.isSafeInteger(pin.size_bytes)||pin.size_bytes<0||typeof pin.media_type!=='string'||!pin.media_type||typeof pin.file_name!=='string'||!pin.file_name))return [];
   return refs.map(pin=>({artifact_id:pin.artifact_id,version:pin.version,sha256:pin.sha256,size_bytes:pin.size_bytes,media_type:pin.media_type,file_name:pin.file_name,
    conversation_id:state.conversation?.conversation_id??'',created_at:message.created_at,origin:'upload',status:'ready',
    preview_kind:pin.media_type.startsWith('image/')&&pin.media_type!=='image/svg+xml'?'image':pin.media_type.startsWith('text/')||['application/json','application/xml'].includes(pin.media_type)?'text':'unsupported'}));
  }
  return (message.attachments??[]).map(id=>files.find(file=>file.artifact_id===id&&file.origin==='upload')).filter(Boolean);
 }
 if(message.role!=='assistant'||message.status!=='complete'||!message.run_id||state.runs[message.run_id]?.status!=='succeeded')return [];
 const answers=Object.values(state.messages).filter(value=>value.role==='assistant'&&value.run_id===message.run_id&&value.status==='complete');
 const assigned=new Set(answers.flatMap(value=>value.attachments??[]));
 const final=answers.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.message_id.localeCompare(b.message_id)).at(-1);
 const order=message.attachments??[];
 return files.filter(file=>file.origin!=='upload'&&file.run_id===message.run_id&&file.status==='ready'&&(order.includes(file.artifact_id)||(message.message_id===final?.message_id&&!assigned.has(file.artifact_id))))
  .sort((a,b)=>{const first=order.indexOf(a.artifact_id),second=order.indexOf(b.artifact_id);if(first>=0||second>=0)return first<0?1:second<0?-1:first-second;return (a.created_at??'').localeCompare(b.created_at??'')||a.artifact_id.localeCompare(b.artifact_id);});
}
