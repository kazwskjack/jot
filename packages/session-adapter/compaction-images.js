/** Adapt PilotDeck stripMultimedia to native flat user/tool content blocks.
 * Original attachments and messages remain in the append-only Session. */
export function compactionImageReferences(messages){
 return messages.map(message=>{
  if(!['user','tool'].includes(message.role)||!message.content.some(block=>block.type==='image'))return message;
  let imageIndex=0;
  const content=message.content.map(block=>{
   if(block.type!=='image')return block;
   return{type:'text',text:JSON.stringify({kind:'compaction_image_source',message_id:message.id,image_index:imageIndex++,recognition_text_state:'unknown'})};
  });
  return{...message,content};
 });
}
