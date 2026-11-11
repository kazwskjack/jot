const kinds=['changed','completed','failed','needs_confirmation'];
function invalid(){throw Error('desktop_notification_data_invalid');}
function row(value){if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)invalid();return value;}
function exact(value,keys){if(Object.keys(value).sort().join(',')!==keys.slice().sort().join(','))invalid();}
const id=value=>typeof value==='string'&&/^desktop-notice-[a-f0-9]{64}$/.test(value);
export function notificationJournalScope(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))invalid();return value;}
export function notificationIdentity(value){
 const item=row(value);exact(item,['event_id','task_id','occurrence_id','generation','event_kind']);
 if(!id(item.event_id)||typeof item.task_id!=='string'||!item.task_id||item.task_id.length>200||typeof item.occurrence_id!=='string'||!item.occurrence_id||item.occurrence_id.length>200||!Number.isSafeInteger(item.generation)||item.generation<1||!kinds.includes(item.event_kind))invalid();
 return {event_id:item.event_id,task_id:item.task_id,occurrence_id:item.occurrence_id,generation:item.generation,event_kind:item.event_kind};
}
export function normalizeNotificationJournal(value){
 const saved=row(value);exact(saved,saved.version===1?['version','cursor','baseline','pending']:['version','cursor','baseline','pending','ended']);
 if(![1,2].includes(saved.version)||saved.cursor!==null&&!id(saved.cursor)||typeof saved.baseline!=='string'||saved.baseline.length>40||!Number.isFinite(Date.parse(saved.baseline))||!Array.isArray(saved.pending)||saved.pending.length>64)invalid();
 const pending=saved.pending.map(value=>{const item=row(value);exact(item,['identity','state']);if(!['queued','dispatching','unknown','observing','shown','ending'].includes(item.state)||saved.version===1&&item.state==='ending')invalid();return {identity:notificationIdentity(item.identity),state:item.state};});
 const ended=saved.version===1?[]:saved.ended;if(!Array.isArray(ended)||ended.length>64)invalid();
 const history=ended.map(notificationIdentity),ids=[...pending.map(item=>item.identity.event_id),...history.map(item=>item.event_id)];
 if(new Set(ids).size!==ids.length||history.length+pending.filter(item=>item.state==='ending').length>64)invalid();
 const result={version:2,cursor:saved.cursor,baseline:saved.baseline,pending,ended:history};if(JSON.stringify(result).length>131072)invalid();return result;
}
export function endNotificationWait(value,eventIds){
 const saved=normalizeNotificationJournal(value);
 if(!Array.isArray(eventIds)||!eventIds.length||eventIds.length>64||new Set(eventIds).size!==eventIds.length||eventIds.some(value=>!id(value)))invalid();
 const requested=new Set(eventIds),selected=saved.pending.filter(item=>requested.has(item.identity.event_id)&&['dispatching','unknown','observing'].includes(item.state));
 if(saved.ended.length+saved.pending.filter(item=>item.state==='ending').length+selected.length>64)throw Error('desktop_notification_history_full');
 const eligible=new Set(selected.map(item=>item.identity.event_id));return {...saved,pending:saved.pending.map(item=>eligible.has(item.identity.event_id)?{...item,state:'ending'}:item)};
}
