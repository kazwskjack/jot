import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { EventStore } from '../events/event-store.ts';
import { decodeStoredContent } from '../messages/content.ts';

export type DialogueTrigger = { kind: 'conversation_message' | 'conversation_result'; conversation_id: string };
export type DialogueCausation = { root_causation_id: string; source_event_id: string; source_run_id: string;
  task_chain: string[]; run_chain: string[]; depth: number };
type Signal = DialogueCausation & { event_id: string; reference: string; hash: string; excerpt: string; at: string };
type Task = { task_id: string; owner_id: string; generation: number; schedule_revision: number; trigger_json: string; status?: string };
type Row = Record<string, any>;
export const MAX_DIALOGUE_CAUSATION_DEPTH = 4;
export function isDialogueTrigger(value: { kind: string }): value is DialogueTrigger {
  return value.kind === 'conversation_message' || value.kind === 'conversation_result';
}
export function normalizeDialogueTrigger(value: unknown): DialogueTrigger {
  const input=value as Row;
  if (!input || !isDialogueTrigger(input as DialogueTrigger)) throw new Error('unsupported_trigger');
  if (typeof input.conversation_id !== 'string' || !input.conversation_id.trim() || input.conversation_id.length>200) throw new Error('invalid_conversation_id');
  return {kind:input.kind,conversation_id:input.conversation_id.trim()};
}

/** Host-side event admission only. Execution remains in ga_runs and the existing worker. */
export class DialogueEvents {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS wb_task_event_cursors(
      task_id TEXT PRIMARY KEY REFERENCES wb_persistent_tasks(task_id),conversation_id TEXT NOT NULL,
      generation INTEGER NOT NULL,last_seq INTEGER NOT NULL,pending_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS wb_task_event_receipts(
      task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),event_id TEXT NOT NULL,signal_key TEXT NOT NULL,
      generation INTEGER NOT NULL,outcome TEXT NOT NULL,run_id TEXT,PRIMARY KEY(task_id,event_id),UNIQUE(task_id,signal_key));
      CREATE TABLE IF NOT EXISTS wb_task_run_causation(
      run_id TEXT PRIMARY KEY REFERENCES ga_runs(id),origin_task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),
      root_causation_id TEXT NOT NULL,source_event_id TEXT,source_run_id TEXT,
      task_chain_json TEXT NOT NULL,run_chain_json TEXT NOT NULL,depth INTEGER NOT NULL);`);
  }
  assertOwned(owner: string, conversation: string) {
    if (!this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?').get(conversation,owner)) throw new Error('conversation_not_found');
  }
  reset(task: Task) {
    const trigger=JSON.parse(task.trigger_json);
    this.db.prepare("UPDATE wb_task_event_receipts SET outcome='generation_revoked' WHERE task_id=? AND outcome='pending'").run(task.task_id);
    this.db.prepare('DELETE FROM wb_task_event_cursors WHERE task_id=?').run(task.task_id);
    if (!isDialogueTrigger(trigger) || (task.status && task.status!=='active')) return;
    this.assertOwned(task.owner_id,trigger.conversation_id);
    const head=new EventStore(this.db).head(trigger.conversation_id);
    this.db.prepare('INSERT INTO wb_task_event_cursors(task_id,conversation_id,generation,last_seq) VALUES(?,?,?,?)')
      .run(task.task_id,trigger.conversation_id,task.generation,head);
  }
  private lineage(runId: string): { task_chain: string[]; run_chain: string[]; depth: number; root_causation_id: string } {
    const visited=new Set<string>();let current: string | null=runId;
    while(current && visited.size<32) {
      if(visited.has(current)) throw new Error('dialogue_causation_invalid');visited.add(current);
      const stored=this.db.prepare('SELECT * FROM wb_task_run_causation WHERE run_id=?').get(current) as Row|undefined;
      if(stored)return {task_chain:JSON.parse(stored.task_chain_json),run_chain:JSON.parse(stored.run_chain_json),depth:Number(stored.depth),root_causation_id:stored.root_causation_id};
      // Older task runs still carry authoritative origin through their occurrence binding.
      const occurrence=this.db.prepare('SELECT task_id FROM wb_task_occurrences WHERE run_id=?').get(current) as Row|undefined;
      if(occurrence)return {task_chain:[occurrence.task_id],run_chain:[current],depth:1,root_causation_id:current};
      const run=this.db.prepare('SELECT continuation_of FROM ga_runs WHERE id=?').get(current) as Row|undefined;
      current=run?.continuation_of ?? null;
    }
    if(current)throw new Error('dialogue_causation_invalid');
    return {task_chain:[],run_chain:[],depth:0,root_causation_id:''};
  }
  ingest(task: Task) {
    const trigger=JSON.parse(task.trigger_json) as DialogueTrigger;this.assertOwned(task.owner_id,trigger.conversation_id);
    const cursor=this.db.prepare('SELECT * FROM wb_task_event_cursors WHERE task_id=?').get(task.task_id) as Row|undefined;
    if(!cursor || cursor.generation!==task.generation || cursor.conversation_id!==trigger.conversation_id) {this.reset(task);return;}
    const events=new EventStore(this.db).replay(trigger.conversation_id,Number(cursor.last_seq),1000);
    let pending=JSON.parse(cursor.pending_json) as Signal[];let lastSeq=Number(cursor.last_seq);
    for(const event of events) {
      lastSeq=Number(event.seq);const payload=event.payload;
      if(event.run_id===null)continue; // Delivered replies are not new execution/user triggers.
      let message: Row|undefined;let signalKey='';
      if(trigger.kind==='conversation_message' && event.type==='message.created' && payload.role==='user' && payload.status==='complete') {
        message=this.db.prepare("SELECT * FROM ga_messages WHERE id=? AND conversation_id=? AND run_id=? AND role='user' AND status='complete'")
          .get(String(payload.message_id??''),trigger.conversation_id,event.run_id) as Row|undefined;
        if(message)signalKey=`message:${message.id}`;
      } else if(trigger.kind==='conversation_result' && event.type==='run.state' && ['succeeded','partial'].includes(String(payload.status))) {
        const run=this.db.prepare('SELECT 1 FROM ga_runs WHERE id=? AND conversation_id=?').get(event.run_id,trigger.conversation_id);
        if(run && payload.error_code!=='OUTCOME_UNKNOWN')message=this.db.prepare("SELECT * FROM ga_messages WHERE run_id=? AND conversation_id=? AND role='assistant' AND status='complete' ORDER BY created_at,id LIMIT 1")
          .get(event.run_id,trigger.conversation_id) as Row|undefined;
        if(message)signalKey=`result:${event.run_id}`;
      }
      if(!message)continue;
      const lineage=this.lineage(event.run_id);
      const suppressed=trigger.kind==='conversation_message' && lineage.depth>0 ? 'task_input'
        : lineage.task_chain.includes(task.task_id) ? 'causation_cycle' : lineage.depth>=MAX_DIALOGUE_CAUSATION_DEPTH ? 'causation_depth' : null;
      const inserted=this.db.prepare('INSERT OR IGNORE INTO wb_task_event_receipts(task_id,event_id,signal_key,generation,outcome) VALUES(?,?,?,?,?)')
        .run(task.task_id,event.event_id,signalKey,task.generation,suppressed??'pending').changes;
      if(!inserted || suppressed)continue;
      const content=decodeStoredContent(String(message.content_json));
      const excerpt=content.blocks.filter(block=>block.kind==='text' && block.exposure!=='provider').map(block=>block.text??'').join('\n').slice(0,4000);
      pending.push({...lineage,root_causation_id:lineage.root_causation_id||event.event_id,source_event_id:event.event_id,source_run_id:event.run_id,
        event_id:event.event_id,reference:`conversation:${trigger.conversation_id}:run:${event.run_id}:event:${event.event_id}`,
        hash:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),excerpt,at:event.at});
      // Bound prompt/evidence storage, while retaining every receipt and all causal ancestors.
      if(pending.length>100) {
        const removed=pending.shift()!;const first=pending[0]!;
        first.task_chain=[...new Set([...removed.task_chain,...first.task_chain])];
        first.run_chain=[...new Set([...removed.run_chain,...first.run_chain])];first.depth=Math.max(removed.depth,first.depth);
      }
    }
    this.db.prepare('UPDATE wb_task_event_cursors SET last_seq=?,pending_json=? WHERE task_id=? AND generation=?')
      .run(lastSeq,JSON.stringify(pending),task.task_id,task.generation);
  }
  pending(task: Task) {
    const row=this.db.prepare('SELECT pending_json FROM wb_task_event_cursors WHERE task_id=? AND generation=?').get(task.task_id,task.generation) as Row|undefined;
    const signals=JSON.parse(row?.pending_json??'[]') as Signal[];if(!signals.length)return null;
    const latest=signals[signals.length-1]!;
    const causation:DialogueCausation={root_causation_id:latest.root_causation_id,source_event_id:latest.event_id,source_run_id:latest.source_run_id,
      task_chain:[...new Set(signals.flatMap(signal=>signal.task_chain))],run_chain:[...new Set(signals.flatMap(signal=>signal.run_chain))],depth:Math.max(...signals.map(signal=>signal.depth))};
    return {key:`dialogue:${task.schedule_revision}:${latest.event_id}`,scheduled:latest.at,causation,
      evidence:signals.map(signal=>({kind:'conversation_event',reference:signal.reference,hash:signal.hash})),
      context:signals.map(signal=>`${signal.reference}\n${signal.excerpt}`).join('\n\n').slice(-12000)};
  }
  bindRun(taskId: string, runId: string, source?: DialogueCausation) {
    this.db.prepare('INSERT INTO wb_task_run_causation VALUES(?,?,?,?,?,?,?,?)').run(runId,taskId,source?.root_causation_id??runId,
      source?.source_event_id??null,source?.source_run_id??null,JSON.stringify([...(source?.task_chain??[]),taskId]),
      JSON.stringify([...(source?.run_chain??[]),...(source?.source_run_id?[source.source_run_id]:[]),runId]),(source?.depth??0)+1);
  }
  acknowledge(task: Task, runId: string) {
    this.db.prepare("UPDATE wb_task_event_receipts SET outcome='admitted',run_id=? WHERE task_id=? AND generation=? AND outcome='pending'").run(runId,task.task_id,task.generation);
    this.db.prepare("UPDATE wb_task_event_cursors SET pending_json='[]' WHERE task_id=? AND generation=?").run(task.task_id,task.generation);
  }
}
