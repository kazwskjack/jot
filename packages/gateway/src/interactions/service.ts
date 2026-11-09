import {interactionTextFields} from './public-text.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction,withReadTransaction } from '../db/database.ts';
import type { EventStore } from '../events/event-store.ts';
import {createBrowserActionInteraction,readBrowserActionInteraction,type BrowserActionObservation,type BrowserActionRequest} from './browser-action-approval.ts';

type TaskResponder={resolve(row:Record<string,unknown>,owner:string,status:string,input:Record<string,unknown>,key:string):boolean;
  recordReceipt(row:Record<string,unknown>,input:unknown,key:string,operation:string,receipt:Record<string,unknown>):void};

export function publicInteractionValue(row:Record<string,unknown>){
 const value=JSON.parse(String(row.request_json)) as Record<string,unknown>;
 value.status=row.status;value.version=Number(row.version);
 if(row.response_json){const response=JSON.parse(String(row.response_json));
  if(row.kind==='question')value.answers=response.answers;else value.decision=response.decision;}
 return value;
}

export class InteractionService {
  private readonly db: DatabaseSync;
  private readonly events: EventStore;
  private readonly taskResponder:TaskResponder|undefined;
  constructor(db: DatabaseSync, events: EventStore,taskResponder?:TaskResponder) {
    this.db = db; this.events = events;this.taskResponder=taskResponder;
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ga_interactions_history ON ga_interactions(conversation_id,created_at,id);
      CREATE INDEX IF NOT EXISTS idx_ga_interactions_run_history ON ga_interactions(conversation_id,run_id,created_at,id);`);
  }

  history(conversationId:string,ownerId:string,query:{cursor?:unknown;run_id?:unknown;limit?:unknown}={}){
    const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
    const cursor=query.cursor,runId=query.run_id,limit=query.limit===undefined?10:Number(query.limit);
    if(!id.test(conversationId)||cursor!==undefined&&(typeof cursor!=='string'||!id.test(cursor))
      ||runId!==undefined&&(typeof runId!=='string'||!id.test(runId))
      ||query.limit!==undefined&&typeof query.limit!=='string'&&typeof query.limit!=='number'
      ||!Number.isSafeInteger(limit)||limit<1||limit>25)throw Error('interaction_history_query_invalid');
    return withReadTransaction(this.db,()=>{
      if(!this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?').get(conversationId,ownerId))throw Error('conversation_not_found');
      if(runId!==undefined&&!this.db.prepare('SELECT 1 FROM ga_runs WHERE id=? AND conversation_id=?').get(runId as string,conversationId))throw Error('run_not_found');
      const scope=runId===undefined?'conversation_id=?':'conversation_id=? AND run_id=?';
      const bindings=runId===undefined?[conversationId]:[conversationId,runId as string];
      const boundary=cursor===undefined?undefined:this.db.prepare(`SELECT created_at,id FROM ga_interactions WHERE ${scope} AND id=?`)
        .get(...bindings,cursor as string) as {created_at:string;id:string}|undefined;
      if(cursor!==undefined&&!boundary)throw Error('interaction_history_query_invalid');
      const rows=this.db.prepare(`SELECT * FROM ga_interactions WHERE ${scope}
        ${boundary?'AND (created_at<? OR (created_at=? AND id<?))':''} ORDER BY created_at DESC,id DESC LIMIT ?`)
        .all(...bindings,...(boundary?[boundary.created_at,boundary.created_at,boundary.id]:[]),limit+1) as Array<Record<string,unknown>>;
      const selected=rows.slice(0,limit),last=selected.at(-1);
      return {conversation_id:conversationId,...(runId!==undefined?{run_id:runId}:{}),items:selected.map(row=>({...this.value(row),interaction_id:String(row.id),run_id:String(row.run_id),created_at:String(row.created_at)})),
        ...(rows.length>limit&&last?{next_cursor:String(last.id)}:{}),execution_authorized:false};
    });
  }


  historyRecord(conversationId:string,ownerId:string,interactionId:string,query:Record<string,unknown>){
    const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
    const runId=query.run_id,version=Number(query.expected_version);
    if(!id.test(conversationId)||!id.test(interactionId)||Object.keys(query).some(key=>!['run_id','expected_version'].includes(key))
      ||runId!==undefined&&(typeof runId!=='string'||!id.test(runId))
      ||typeof query.expected_version!=='string'&&typeof query.expected_version!=='number'
      ||!Number.isSafeInteger(version)||version<1)throw Error('interaction_history_query_invalid');
    return withReadTransaction(this.db,()=>{
      const row=this.db.prepare(`SELECT i.* FROM ga_interactions i JOIN ga_conversations c ON c.id=i.conversation_id
        JOIN ga_runs r ON r.id=i.run_id AND r.conversation_id=i.conversation_id
        WHERE i.id=? AND i.conversation_id=? AND c.owner_id=?`).get(interactionId,conversationId,ownerId) as Record<string,unknown>|undefined;
      if(!row||runId!==undefined&&row.run_id!==runId)throw Error('interaction_not_found');
      if(Number(row.version)!==version)throw Error('interaction_version_conflict');
      return {conversation_id:conversationId,item:{...this.value(row),interaction_id:String(row.id),run_id:String(row.run_id),created_at:String(row.created_at)},execution_authorized:false};
    });
  }

  searchHistory(conversationId:string,ownerId:string,query:Record<string,unknown>){
    const q=typeof query.q==='string'?query.q.trim():'';
    if(!q||q.length>200||Object.keys(query).some(key=>!['q','cursor','run_id'].includes(key)))throw Error('interaction_history_query_invalid');
    return withReadTransaction(this.db,()=>{
      const page=this.history(conversationId,ownerId,{cursor:query.cursor,run_id:query.run_id,limit:10});
      const pattern=new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'iu');
      const items=[];
      for(const item of page.items){
        const value:Record<string,unknown>=item;
        if(!this.db.prepare('SELECT 1 FROM ga_runs WHERE id=? AND conversation_id=?').get(item.run_id,conversationId))throw Error('interaction_history_source_invalid');
        if(!['question','approval'].includes(String(value.kind))||!['pending','answered','denied','cancelled','expired'].includes(String(value.status))
          ||!Number.isSafeInteger(value.version)||Number(value.version)<1)throw Error('interaction_history_source_invalid');
        for(const text of interactionTextFields(value)){
          const match=pattern.exec(text);
          if(!match)continue;
          let start=Math.max(0,match.index-60),end=Math.min(text.length,match.index+match[0].length+60);
          if(start>0&&/[\uD800-\uDBFF]/.test(text[start-1]!)&&/[\uDC00-\uDFFF]/.test(text[start]!))start--;
          if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!)&&/[\uDC00-\uDFFF]/.test(text[end]!))end--;
          items.push({interaction_id:item.interaction_id,run_id:item.run_id,kind:value.kind,status:value.status,
            version:value.version,created_at:item.created_at,match_text:match[0],excerpt:text.slice(start,end)});
          break;
        }
      }
      const last=page.items.at(-1);
      return {conversation_id:conversationId,...(page.run_id?{run_id:page.run_id}:{}),q,items,scanned_records:page.items.length,
        ...(last?{scanned_through:{interaction_id:last.interaction_id,created_at:last.created_at}}:{}),
        ...(page.next_cursor?{next_cursor:page.next_cursor}:{}),execution_authorized:false};
    });
  }

  list(conversationId: string, ownerId: string, status = 'pending') {
    const owner = this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?').get(conversationId, ownerId);
    if (!owner) throw new Error('conversation_not_found');
    const rows = this.db.prepare('SELECT * FROM ga_interactions WHERE conversation_id=? AND (?=\'all\' OR status=?) ORDER BY created_at,id')
      .all(conversationId, status, status) as Array<Record<string, unknown>>;
    return { items: rows.map(row => this.value(row)) };
  }

  requestBrowserAction(input:BrowserActionRequest){
    return withImmediateTransaction(this.db,()=>this.value(createBrowserActionInteraction(this.db,this.events,input)));
  }

  observeBrowserAction(input:BrowserActionObservation){
    const observed=readBrowserActionInteraction(this.db,input);
    return{state:observed.state,interaction:this.value(observed.row)};
  }

  respond(id: string, ownerId: string, input: Record<string, unknown>, key: string) {
    const row = this.row(id, ownerId);
    if (row.kind !== 'question') throw new Error('interaction_kind_conflict');
    this.assertPending(row, input);
    const request = JSON.parse(String(row.request_json)) as Record<string, any>;
    const questions = new Map((request.questions || []).map((item: any) => [item.question_id, item]));
    const answers = input.answers as Array<Record<string, unknown>>;
    if (!Array.isArray(answers) || answers.length === 0) throw new Error('interaction_answer_invalid');
    for (const answer of answers) {
      const question: any = questions.get(answer.question_id);
      if (!question) throw new Error('interaction_answer_invalid');
      const selected = answer.selected_option_ids;
      if (!Array.isArray(selected) || (!question.multiple && selected.length > 1)) throw new Error('interaction_answer_invalid');
      const allowed = new Set((question.options || []).map((option: any) => option.option_id));
      if (selected.some(option => !allowed.has(option))) throw new Error('interaction_answer_invalid');
      if (answer.custom_text && !question.allow_custom) throw new Error('interaction_answer_invalid');
    }
    return this.resolve(row, 'answered', input, key, 'interaction_response');
  }

  decide(id: string, ownerId: string, input: Record<string, unknown>, key: string) {
    const row = this.row(id, ownerId);
    if (row.kind !== 'approval') throw new Error('interaction_kind_conflict');
    this.assertPending(row, input);
    if (row.action_digest !== input.action_digest) throw new Error('action_digest_mismatch');
    if (!['approve', 'deny'].includes(String(input.decision))) throw new Error('interaction_decision_invalid');
    return this.resolve(row, input.decision === 'deny' ? 'denied' : 'answered', input, key, 'interaction_decision');
  }

  private row(id: string, ownerId: string) {
    const row = this.db.prepare('SELECT i.* FROM ga_interactions i JOIN ga_conversations c ON c.id=i.conversation_id WHERE i.id=? AND c.owner_id=?')
      .get(id, ownerId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('interaction_not_found');
    return row;
  }
  private assertPending(row: Record<string, unknown>, input: Record<string, unknown>) {
    if (row.status !== 'pending') throw new Error('interaction_state_conflict');
    if (Number(row.version) !== Number(input.expected_version)) throw new Error('interaction_version_conflict');
    if (row.expires_at && Date.parse(String(row.expires_at)) <= Date.now()) throw new Error('interaction_expired');
  }
  private resolve(row: Record<string, unknown>, status: string, payload: unknown, key: string, commandKind: string) {
    const now = new Date().toISOString(); const commandId = `cmd-${randomUUID()}`;
    return withImmediateTransaction(this.db, () => {
      const owner=this.ownerFor(String(row.conversation_id));
      this.assertPending(this.row(String(row.id),owner),payload as Record<string,unknown>);
      this.db.prepare('UPDATE ga_interactions SET status=?,version=version+1,response_json=?,resolved_at=? WHERE id=? AND status=\'pending\'')
        .run(status, JSON.stringify(payload), now, String(row.id));
      const handled=this.taskResponder?.resolve(row,owner,status,payload as Record<string,unknown>,key)??false;
      if(!handled)this.db.prepare('INSERT INTO ga_run_commands(id,run_id,kind,payload_json,status,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(commandId, String(row.run_id), commandKind, JSON.stringify({ interaction_id: row.id, ...payload as object }), 'pending', `${commandKind}:${key}`, now);
      const updated = this.row(String(row.id), this.ownerFor(String(row.conversation_id)));
      this.events.append(String(row.conversation_id), String(row.run_id), 'interaction.resolved', this.value(updated));
      const receipt={accepted:true,interaction_id:row.id,run_id:row.run_id,status,version:Number(updated.version)};
      if(handled)this.taskResponder!.recordReceipt(row,payload,key,commandKind,receipt);
      return receipt;
    });
  }
  private ownerFor(conversationId: string) {
    return String((this.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(conversationId) as { owner_id: string }).owner_id);
  }
  private value(row: Record<string, unknown>) {
    return publicInteractionValue(row);
  }
}
