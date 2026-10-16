import type {DatabaseSync} from 'node:sqlite';
/** Keep original creation dates. A recovered canonical answer is presented at
 * its immutable publication time, after its repaired supplemental messages. */
export function storedConversationMessageRows(db:DatabaseSync,conversationId:string,limit:number){
 return db.prepare(`SELECT m.* FROM ga_messages m
  LEFT JOIN ga_ordinary_final_publications f ON f.run_id=m.run_id AND f.conversation_id=m.conversation_id
  WHERE m.conversation_id=?
  ORDER BY CASE WHEN m.id=f.message_id THEN f.created_at ELSE m.created_at END DESC,
   CASE WHEN m.id=f.message_id THEN 1 ELSE 0 END DESC,
   CASE WHEN f.run_id IS NOT NULL THEN m.rowid END DESC,m.id DESC LIMIT ?`)
  .all(conversationId,Math.max(1,Math.min(limit,200))).reverse();
}
export function recoveredMessageTimes(db:DatabaseSync,conversationId:string){
 return new Map(db.prepare('SELECT message_id,created_at FROM ga_ordinary_final_publications WHERE conversation_id=?').all(conversationId).map(r=>[String(r.message_id),String(r.created_at)]));
}
