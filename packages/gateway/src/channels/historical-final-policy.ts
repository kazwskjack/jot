/** Pure reconciliation policy, not send/recipient authority. The integration
 * must supply an owned, frozen recipient/effect snapshot and revalidate it in
 * the same transaction as its outbox changes. No provider or DB API is called. */
type Effect={effect_id:string;message_id:string;artifact_ref:string|null;payload_json:string|null;status:string;generation:number;provider_receipt_json:string|null;lease_owner:string|null;lease_expires_at:number|null};
type Base={execution_authorized:false;unresolved_effect_ids:string[]};
export type HistoricalFinalDecision=Base&(
 {kind:'queue';mode:'final'|'correction';text:string;supersede_ids:string[];corrects_ids:string[]}
 |{kind:'reuse';effect_id:string;state:'queued'|'pending_receipt'|'delivered';mode:'final'|'correction';effect_protected:boolean}
 |{kind:'hold';reason:string;wait_for_ids:string[]}
 |{kind:'revoke';reason:'recipient_authority_revoked'});
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const uncertain=new Set(['sending','receipt_pending','outcome_unknown']);
function fullReceipt(value:string|null):boolean{
 if(value===null)return false;let r:unknown;try{r=JSON.parse(value);}catch{return false;}if(!object(r))return false;
 if(Object.hasOwn(r,'receipts')||Object.hasOwn(r,'total')){
  if(!Number.isSafeInteger(r.total)||Number(r.total)<1||!Array.isArray(r.receipts)||r.receipts.length!==r.total)return false;
  return r.receipts.every((p,i)=>object(p)&&p.part_index===i+1&&typeof p.provider_message_id==='string'&&!!p.provider_message_id.trim())
   &&new Set(r.receipts.map(p=>p.provider_message_id)).size===r.receipts.length;
 }
 return typeof r.provider_message_id==='string'&&!!r.provider_message_id.trim();
}
function effectValid(value:unknown):value is Effect{
 return object(value)&&id(value.effect_id)&&id(value.message_id)&&(value.artifact_ref===null||id(value.artifact_ref))
  &&(value.payload_json===null||typeof value.payload_json==='string')&&typeof value.status==='string'&&['pending','historical_pending','sending','receipt_pending','outcome_unknown','delivered','cancelled','failed'].includes(value.status)
  &&Number.isSafeInteger(value.generation)&&Number(value.generation)>=0&&(value.provider_receipt_json===null||typeof value.provider_receipt_json==='string')
  &&(value.lease_owner===null||id(value.lease_owner))&&(value.lease_expires_at===null||Number.isSafeInteger(value.lease_expires_at));
}
function body(row:Effect):string|null{
 if(row.artifact_ref!==null)return row.payload_json===null?null:'';
 if(row.payload_json===null)return '';let value:unknown;try{value=JSON.parse(row.payload_json);}catch{return '';}
 return object(value)&&Object.keys(value).sort().join(',')==='kind,text'&&value.kind==='text'&&typeof value.text==='string'&&value.text.trim()?value.text:'';
}
function unresolved(row:Effect){return uncertain.has(row.status)||row.status==='delivered'&&(!fullReceipt(row.provider_receipt_json)||row.lease_owner!==null||row.lease_expires_at!==null)
 ||['pending','cancelled','failed'].includes(row.status)&&(row.generation>0||row.provider_receipt_json!==null||row.lease_owner!==null||row.lease_expires_at!==null);}
export function decideHistoricalFinalDelivery(value:unknown):HistoricalFinalDecision{
 const empty={execution_authorized:false as const,unresolved_effect_ids:[] as string[]};
 const invalid=():HistoricalFinalDecision=>({...empty,kind:'hold',reason:'invalid_delivery_snapshot',wait_for_ids:[]});
 if(!object(value)||Object.keys(value).sort().join(',')!=='effects,message_id,protected_effect_ids,recipient_authorized,text'||!id(value.message_id)||typeof value.text!=='string'||!value.text.trim()||typeof value.recipient_authorized!=='boolean'||!Array.isArray(value.effects)||!Array.isArray(value.protected_effect_ids)||value.protected_effect_ids.some(v=>!id(v)))return invalid();
 if(!value.effects.every(effectValid)||new Set(value.effects.map(e=>e.effect_id)).size!==value.effects.length)return invalid();
 const effects=(value.effects as Effect[]).map(effect=>effect.status==='historical_pending'?{...effect,status:'pending'}:effect),protectedIds=new Set(value.protected_effect_ids as string[]),text=value.text.trim(),correction='更新后的结果：\n'+text;
 const base={execution_authorized:false as const,unresolved_effect_ids:effects.filter(unresolved).map(e=>e.effect_id)};
 if(!value.recipient_authorized)return{...base,kind:'revoke',reason:'recipient_authority_revoked'};
 const hold=(reason:string,rows:Effect[]):HistoricalFinalDecision=>({...base,kind:'hold',reason,wait_for_ids:rows.map(e=>e.effect_id)});
 const bodies=new Map(effects.map(e=>[e.effect_id,body(e)]));
 if(effects.some(e=>bodies.get(e.effect_id)===''))return hold('invalid_effect_payload',effects.filter(e=>bodies.get(e.effect_id)===''));
 const matching=effects.filter(e=>e.message_id===value.message_id&&e.artifact_ref===null&&[text,correction].includes(bodies.get(e.effect_id)!));
 if(matching.length>1)return hold('ambiguous_matching_effects',matching);
 if(matching.length){
  const e=matching[0]!;if(['cancelled','failed'].includes(e.status))return hold('prior_delivery_cancelled',matching);
  if(e.status==='delivered'&&unresolved(e)||e.status==='pending'&&e.provider_receipt_json!==null)return hold('receipt_unconfirmed',matching);
  return{...base,kind:'reuse',effect_id:e.effect_id,state:e.status==='delivered'?'delivered':e.status==='pending'&&!unresolved(e)?'queued':'pending_receipt',mode:bodies.get(e.effect_id)===correction?'correction':'final',effect_protected:protectedIds.has(e.effect_id)};
 }
 const unknown=effects.filter(unresolved);if(unknown.length)return hold('prior_delivery_unconfirmed',unknown);
 const old=effects.filter(e=>e.message_id===value.message_id&&e.artifact_ref===null),supersede:string[]=[],corrects:string[]=[];
 for(const e of old){
  if(protectedIds.has(e.effect_id))return hold('delivery_policy_protected',[e]);
  if(e.status==='delivered'&&fullReceipt(e.provider_receipt_json)){corrects.push(e.effect_id);continue;}
  if(e.status==='pending'&&e.generation===0&&e.provider_receipt_json===null&&e.lease_owner===null&&e.lease_expires_at===null){supersede.push(e.effect_id);continue;}
  return hold('prior_delivery_cancelled',[e]);
 }
 return{...base,kind:'queue',mode:corrects.length?'correction':'final',text:corrects.length?correction:text,supersede_ids:supersede,corrects_ids:corrects};
}
