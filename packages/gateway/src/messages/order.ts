import type {DatabaseSync} from 'node:sqlite';
/** Keep original creation dates. A recovered canonical answer is presented at
 * its immutable publication time, after its repaired supplemental messages. */
export function storedConversationMessageRows(db:DatabaseSync,conversationId:string,limit:number){
 return storedConversationMessagePage(db,conversationId,limit).rows;
}
export function recoveredMessageTimes(db:DatabaseSync,conversationId:string){
 return new Map(db.prepare('SELECT message_id,created_at FROM ga_ordinary_final_publications WHERE conversation_id=?').all(conversationId).map(r=>[String(r.message_id),String(r.created_at)]));
}

/** A live history boundary is an existing message in the authorized conversation.
 * Use the same recovery-aware order as snapshots, including equal-date rows. */
export function storedConversationMessagePage(db:DatabaseSync,conversationId:string,limit:number,cursor?:string){
 if(!Number.isSafeInteger(limit))throw Error('invalid_message_limit');
 const size=Math.max(1,Math.min(limit,200));
 if(cursor!==undefined&&(typeof cursor!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(cursor)))throw Error('invalid_message_cursor');
 const at='CASE WHEN m.id=f.message_id THEN f.created_at ELSE m.created_at END';
 const final='CASE WHEN m.id=f.message_id THEN 1 ELSE 0 END';
 const group='CASE WHEN f.run_id IS NOT NULL THEN 1 ELSE 0 END';
 const ordinal='CASE WHEN f.run_id IS NOT NULL THEN m.rowid ELSE 0 END';
 const join='FROM ga_messages m LEFT JOIN ga_ordinary_final_publications f ON f.run_id=m.run_id AND f.conversation_id=m.conversation_id';
 const boundary=cursor===undefined?undefined:db.prepare(`SELECT m.id,${at} history_at,${final} history_final,${group} history_group,${ordinal} history_ordinal
  ${join} WHERE m.conversation_id=? AND m.id=?`).get(conversationId,cursor) as
  {id:string;history_at:string;history_final:number;history_group:number;history_ordinal:number}|undefined;
 if(cursor!==undefined&&!boundary)throw Error('invalid_message_cursor');
 const rows=db.prepare(`SELECT m.* ${join} WHERE m.conversation_id=?
  ${boundary?`AND (${at},${final},${group},${ordinal},m.id) < (?,?,?,?,?)`:''}
  ORDER BY ${at} DESC,${final} DESC,${group} DESC,${ordinal} DESC,m.id DESC LIMIT ?`)
  .all(conversationId,...(boundary?[boundary.history_at,boundary.history_final,boundary.history_group,boundary.history_ordinal,boundary.id]:[]),size+1);
 const selected=rows.slice(0,size),oldest=selected.at(-1);
 return {rows:selected.reverse(),...(rows.length>size&&oldest?{next_cursor:String(oldest.id)}:{})};
}
