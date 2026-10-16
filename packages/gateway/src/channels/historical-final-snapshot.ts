import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';

type Row=Record<string,any>;
export type HistoricalDeliveryScope={owner_id:string;conversation_id:string;run_id:string};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
function canonical(value:any):string{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function reject():never{throw Error('historical_delivery_snapshot_rejected');}
const order=(rows:Row[])=>rows.sort((a,b)=>canonical(a).localeCompare(canonical(b),'en'));

/** Private, read-only channel facts. This is neither a provider permission nor
 * a native completion proof. A caller must re-read inside its publication
 * transaction. No schema installer, model, provider or EventStore is invoked. */
export function captureHistoricalDeliverySnapshot(db:DatabaseSync,value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='conversation_id,owner_id,run_id')reject();
 const scope=value as HistoricalDeliveryScope;if(!id(scope.owner_id)||!id(scope.conversation_id)||!id(scope.run_id))reject();
 return withImmediateTransaction(db,()=>{
  const conversation=db.prepare('SELECT * FROM ga_conversations WHERE id=? AND owner_id=?').get(scope.conversation_id,scope.owner_id) as Row|undefined;
  const run=db.prepare('SELECT * FROM ga_runs WHERE id=? AND conversation_id=?').get(scope.run_id,scope.conversation_id) as Row|undefined;
  if(!conversation||conversation.archived_at!==null||!run||!['succeeded','failed','interrupted','partial'].includes(run.status)||run.continuation_of!==null)reject();
  const bindings=db.prepare('SELECT * FROM ga_channel_bindings WHERE conversation_id=? ORDER BY channel,principal').all(scope.conversation_id) as Row[];
  const effects=db.prepare('SELECT * FROM ga_channel_deliveries WHERE run_id=? ORDER BY destination,recipient,effect_id').all(scope.run_id) as Row[];
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{name:string;sql:string}>;
  const names=new Set(tables.map(t=>t.name)),metadata:Row[]=[],protectedIds=new Set<string>(),digestIds=new Set<string>();
  // Inspect actual schemas, including future effect grants. Unknown metadata
  // may block superseding; it must never be silently treated as no authority.
  for(const table of tables){
   if(table.name==='ga_channel_deliveries')continue;
   const columns=db.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as Row[];
   const refs=new Set(columns.filter(c=>['effect_id','anchor_effect_id'].includes(c.name)).map(c=>String(c.name)));
   for(const fk of db.prepare(`PRAGMA foreign_key_list(${quote(table.name)})`).all() as Row[])if(fk.table==='ga_channel_deliveries')refs.add(String(fk.from));
   if(!refs.size)continue;
   const records:Row[]=[];
   for(const effect of effects){
    const keys=[...refs];const matches=db.prepare(`SELECT * FROM ${quote(table.name)} WHERE ${keys.map(c=>quote(c)+'=?').join(' OR ')}`).all(...keys.map(()=>effect.effect_id)) as Row[];
    if(matches.length)protectedIds.add(String(effect.effect_id));
    for(const row of matches){records.push(row);if(typeof row.digest_id==='string')digestIds.add(row.digest_id);}
   }
   metadata.push({table:table.name,schema_sha256:hash(table.sql),records_sha256:hash(order(records))});
  }
  const digests:Row[]=[];
  if(digestIds.size){
   if(!names.has('wb_task_notification_digests')||!names.has('wb_task_notification_digest_members'))reject();
   for(const digestId of [...digestIds].sort()){
    const digest=db.prepare('SELECT * FROM wb_task_notification_digests WHERE digest_id=?').get(digestId);
    const members=db.prepare('SELECT * FROM wb_task_notification_digest_members WHERE digest_id=? ORDER BY ordinal,effect_id').all(digestId) as Row[];
    if(!digest||!members.length)reject();
    const peers=members.map(member=>db.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?').get(member.effect_id));if(peers.some(p=>!p))reject();
    digests.push({digest_id:digestId,record_sha256:hash(digest),members_sha256:hash(members),effects_sha256:hash(peers)});
   }
  }
  const keys=new Map<string,{destination:string;recipient:string}>();
  for(const binding of bindings)keys.set(JSON.stringify([binding.channel,binding.principal]),{destination:binding.channel,recipient:binding.principal});
  for(const effect of effects)keys.set(JSON.stringify([effect.destination,effect.recipient]),{destination:effect.destination,recipient:effect.recipient});
  const targets=[...keys.entries()].sort(([a],[b])=>a.localeCompare(b,'en')).map(([,key])=>{
   if(!['wecom','email'].includes(key.destination)||typeof key.recipient!=='string'||!key.recipient.trim())reject();
   const binding=bindings.find(b=>b.channel===key.destination&&b.principal===key.recipient)??null;
   const owners=names.has('ga_owner_channel_bindings')?db.prepare('SELECT * FROM ga_owner_channel_bindings WHERE channel=? AND principal=? ORDER BY channel_binding_id').all(key.destination,key.recipient) as Row[]:[];
   const verified=owners.filter(b=>b.status==='verified');
   const authorized=!!binding&&(owners.length===0||verified.length===1&&verified[0]!.owner_id===scope.owner_id);
   const selected=effects.filter(e=>e.destination===key.destination&&e.recipient===key.recipient);
   return{...key,conversation_binding:binding,owner_bindings_sha256:hash(owners),recipient_authorized:authorized,effects:selected,protected_effect_ids:selected.filter(e=>protectedIds.has(e.effect_id)).map(e=>String(e.effect_id))};
  });
  const source={protocol:1 as const,kind:'historical_delivery_snapshot' as const,scope:{...scope},conversation_sha256:hash(conversation),run_sha256:hash(run),messages_sha256:hash(db.prepare('SELECT * FROM ga_messages WHERE run_id=? ORDER BY id').all(scope.run_id)),targets,metadata,digests,execution_authorized:false as const};
  return{...source,sha256:hash(source)};
 });
}

/** Comparison only, inside the caller's existing atomic write transaction.
 * The caller supplies a hash, never replacement recipient/effect facts. */
export function assertHistoricalDeliverySnapshot(db:DatabaseSync,scope:HistoricalDeliveryScope,expectedSha256:string){
 if(!db.isTransaction)throw Error('historical_delivery_transaction_required');
 if(typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256))reject();
 const current=captureHistoricalDeliverySnapshot(db,scope);if(current.sha256!==expectedSha256)throw Error('historical_delivery_snapshot_changed');return current;
}
