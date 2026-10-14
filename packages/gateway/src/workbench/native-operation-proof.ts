const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const fields=['session_ref','request_id','tool_name','operation_id','revision','status','accepted_count','items'];
/** Validate closure facts supplied by the authenticated native host. */
export function validateNativeOperationProofs(value:unknown,sessionRef:unknown):void{
 if(value===undefined)return;
 const invalid=()=>{throw new Error('native_child_closure_invalid');};
 if(!Array.isArray(value)||value.length>1000)invalid();
 const requests=new Set<string>();
 for(const entry of value as unknown[]){
  if(!entry||typeof entry!=='object'||Array.isArray(entry))invalid();
  const p=entry as Record<string,unknown>;
  if(Object.keys(p).some(key=>!fields.includes(key))||fields.some(key=>!Object.hasOwn(p,key))
   ||p.session_ref!==sessionRef||typeof p.request_id!=='string'||!id.test(p.request_id)||requests.has(p.request_id)
   ||typeof p.tool_name!=='string'||!['universe_read_page','universe_browse','universe_execute'].includes(String(p.tool_name))
   ||typeof p.operation_id!=='string'||!/^web-[A-Za-z0-9-]{8,128}$/.test(p.operation_id)
   ||!Number.isSafeInteger(p.revision)||Number(p.revision)<1
   ||typeof p.status!=='string'||!['succeeded','partial','failed','cancelled'].includes(String(p.status))
   ||!Number.isSafeInteger(p.accepted_count)||Number(p.accepted_count)<0||Number(p.accepted_count)>100
   ||!Array.isArray(p.items)||p.items.length!==p.accepted_count)invalid();
  requests.add(p.request_id as string);
  const items=p.items as Record<string,unknown>[],count=Number(p.accepted_count);
  if(new Set(items.map(item=>item?.item_id)).size!==count||new Set(items.map(item=>item?.position)).size!==count)invalid();
  for(const item of items){
   if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['item_id','position','status'].includes(key))
    ||typeof item.item_id!=='string'||!id.test(item.item_id)||!Number.isSafeInteger(item.position)||Number(item.position)<0||Number(item.position)>=count
    ||typeof item.status!=='string'||!['succeeded','failed','cancelled'].includes(String(item.status)))invalid();
  }
 }
}
