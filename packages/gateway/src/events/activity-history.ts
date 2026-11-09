import type {DatabaseSync} from 'node:sqlite';

const MAX_SEQUENCE=9223372036854775807n;
function sequence(value:unknown){
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,18})$/.test(value)||BigInt(value)>MAX_SEQUENCE)throw Error('invalid_activity_history_query');
 return BigInt(value);
}

/** The caller authorizes and holds one read transaction for rows and coverage.
 * Return descending upserts so consumers can retain the first state per ID. */
export function readActivityHistory(db:DatabaseSync,conversationId:string,query:{as_of_seq?:unknown;before_seq?:unknown;limit?:unknown;run_id?:unknown}){
 if(!db.isTransaction)throw Error('activity_history_read_transaction_required');
 const asOf=sequence(query.as_of_seq),before=query.before_seq===undefined?undefined:sequence(query.before_seq);
 if(query.limit!==undefined&&typeof query.limit!=='string'&&typeof query.limit!=='number')throw Error('invalid_activity_history_query');
 const limit=query.limit===undefined?200:Number(query.limit);
 if(!Number.isSafeInteger(limit)||limit<1||limit>200||before!==undefined&&(before<1n||before>asOf))throw Error('invalid_activity_history_query');
 const head=db.prepare('SELECT CAST(next_seq-1 AS TEXT) seq FROM ga_conversations WHERE id=?').get(conversationId) as {seq:string}|undefined;
 if(!head)throw Error('conversation_not_found');
 let headSeq:bigint;
 try{headSeq=sequence(head.seq);}catch{throw Error('activity_history_source_invalid');}
 if(asOf>headSeq)throw Error('activity_history_cursor_future');
 const runId=query.run_id;
 if(runId!==undefined&&(typeof runId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(runId)
  ||!db.prepare('SELECT 1 FROM ga_runs WHERE id=? AND conversation_id=?').get(runId,conversationId)))throw Error('invalid_activity_history_query');
 const through=before===undefined?asOf:before-1n;
 const rows=db.prepare(`SELECT CAST(e.seq AS TEXT) seq,e.run_id,e.payload_json,r.id scoped_run_id FROM ga_events e
  LEFT JOIN ga_runs r ON r.id=e.run_id AND r.conversation_id=e.conversation_id
  WHERE e.conversation_id=? AND e.seq<=? AND e.type='activity.upsert' ${runId===undefined?'':'AND e.run_id=?'}
  ORDER BY e.seq DESC LIMIT ?`).all(conversationId,through.toString(),...(runId===undefined?[]:[runId as string]),limit+1) as Array<{seq:string;run_id:string|null;payload_json:string;scoped_run_id:string|null}>;
 const selected=rows.slice(0,limit),last=selected.at(-1),more=rows.length>limit;
 const from=more&&last?sequence(last.seq):through===0n?0n:1n;
 const count=db.prepare(`SELECT CAST(COUNT(*) AS TEXT) n FROM ga_events
  WHERE conversation_id=? AND seq>=? AND seq<=?`).get(conversationId,from.toString(),through.toString()) as {n:string};
 const expected=through===0n?0n:through-from+1n;
 const items=selected.map(row=>{
  let activity:Record<string,unknown>;
  try{activity=JSON.parse(row.payload_json);}catch{throw Error('activity_history_source_invalid');}
  if(!activity||typeof activity!=='object'||Array.isArray(activity)||typeof activity.activity_id!=='string'||!activity.activity_id
   ||typeof activity.run_id!=='string'||activity.run_id!==row.run_id||activity.run_id!==row.scoped_run_id)throw Error('activity_history_source_invalid');
  return {seq:row.seq,activity};
 });
 return {conversation_id:conversationId,as_of_seq:asOf.toString(),items,...(runId===undefined?{}:{run_id:runId}),
  coverage:{from_seq:from.toString(),through_seq:through.toString(),event_count:count.n,complete:BigInt(count.n)===expected},
  ...(more&&last?{next_before_seq:last.seq}:{})};
}
