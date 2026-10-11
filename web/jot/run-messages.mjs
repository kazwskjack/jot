// Keep user messages, but render one process container per run at its first slot.
export function runMessages(messages) {
 const latest=new Map();
 for(const m of messages)if(m.role==='assistant'&&m.run_id!==null)latest.set(m.run_id,m);
 const seen=new Set();
 return messages.flatMap(m=>{
  if(m.role!=='assistant'||m.run_id===null)return [m];
  if(seen.has(m.run_id))return [];
  seen.add(m.run_id);return [latest.get(m.run_id)];
 });
}
