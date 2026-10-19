import {randomUUID,createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {canonicalModelJson} from './model-policy.ts';
import {readChatCompactionIntent,inspectChatCompactionNative} from './chat-compaction-source.ts';
type Scope={owner_id:string;conversation_id:string;run_id:string;session_ref:string;expected_run_version:number};
type Row=Record<string,unknown>;
type Binding={intent_id:string;attempt_id:string;observer_id:string;fence_id:string};
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const digest=(v:unknown)=>sha(canonicalModelJson(v));
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=():never=>{throw Error('chat_compaction_attempt_unconfirmed');};
const reasons=new Set(['cancelled','provider_error','stream_incomplete','settlement_unavailable','dispatch_unconfirmed','usage_incomplete','unused']);
function object(v:unknown,keys:string[]):Row{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))return fail();return v as Row;}
function validateScope(scope:Scope){if(!scope||Object.keys(scope).sort().join(',')!=='conversation_id,expected_run_version,owner_id,run_id,session_ref'||!['owner_id','conversation_id','run_id','session_ref'].every(k=>id(scope[k as keyof Scope]))||!Number.isSafeInteger(scope.expected_run_version)||scope.expected_run_version<1)fail();}
function requestValue(input:unknown,source:Row){
 const r=object(input,['provider','model','reasoning_effort','purpose','session_id','call_sha256']),model=source.model as Row;
 if(Object.keys(r).sort().join(',')!=='call_sha256,model,provider,purpose,reasoning_effort,session_id'||r.provider!==model?.provider||r.model!==model?.model||model.reasoning_effort!=='off'||r.reasoning_effort!=='off'||r.purpose!=='compaction'||r.session_id!==source.session_id||!hash(r.call_sha256))fail();return r;
}
function usageValue(input:unknown){
 const v=object(input,['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens']);
 if(!Object.keys(v).length||Object.values(v).some(n=>!Number.isSafeInteger(n)||Number(n)<0))fail();
 const n=(key:string)=>v[key]===undefined?undefined:BigInt(v[key] as number),a=n('inputTokens'),b=n('outputTokens'),reason=n('reasoningTokens');let read=n('cacheReadTokens'),write=n('cacheWriteTokens');const total=n('totalTokens'),known=(a??0n)+(b??0n)+(read??0n)+(write??0n);
 if(reason!==undefined&&b!==undefined&&reason>b||total!==undefined&&(total<known||a!==undefined&&b!==undefined&&read!==undefined&&write!==undefined&&total!==known))fail();
 if(a!==undefined&&b!==undefined&&total===known){read??=0n;write??=0n;}
 if(a===undefined||b===undefined||read===undefined||write===undefined)return{complete:false,json:canonicalModelJson(v),tokens:null};
 const tokens=a+b+read+write;return{complete:true,json:canonicalModelJson({inputTokens:String(a),outputTokens:String(b),cacheReadTokens:String(read),cacheWriteTokens:String(write),totalTokens:String(tokens),reasoningTokens:reason===undefined?null:String(reason)}),tokens:String(tokens)};
}
/** Independent ordinary-Chat call journal, not a planner or model quota.
 * Only the first dispatch transition permits a caller to advance its separate
 * native maintenance guard. A receipt alone never authorizes inference.
 * Accounting uses the immutable original source after new input revokes it. */
export class ChatCompactionAttempts{
 private db:DatabaseSync;private now:()=>number;private ttl:number;
 constructor(db:DatabaseSync,{now=Date.now,ttlMs=60000}:{now?:()=>number;ttlMs?:number}={}){if(typeof now!=='function'||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>300000)fail();this.db=db;this.now=now;this.ttl=ttlMs;}
 private time(){const n=this.now();if(!Number.isSafeInteger(n)||n<0||!Number.isSafeInteger(n+this.ttl))fail();return n;}
 private receipt(row:Row,dispatch=false){return Object.freeze({protocol:1,kind:'chat_compaction_attempt',attempt_id:row.attempt_id,intent_id:row.intent_id,fence_id:row.fence_id,observer_id:row.observer_id,run_id:row.run_id,session_id:row.session_id,source_sha256:row.source_sha256,request:JSON.parse(String(row.request_json)),state:row.state,expires_at:row.expires_at,usage_status:row.usage_status,usage:row.usage_json===null?null:JSON.parse(String(row.usage_json)),actual_tokens:row.actual_tokens,estimated_cost_nano_usd:null,reason:row.reason,dispatch_allowed:dispatch,execution_authorized:false});}
 private event(row:Row){this.db.prepare('INSERT INTO ga_chat_compaction_attempt_events(attempt_id,state,reason,usage_json,created_at) VALUES(?,?,?,?,?)').run(String(row.attempt_id),String(row.state),row.reason as string|null,row.usage_json as string|null,new Date(this.time()).toISOString());}
 private load(scope:Scope,binding:Binding){
  validateScope(scope);if(!binding||Object.keys(binding).sort().join(',')!=='attempt_id,fence_id,intent_id,observer_id'||!Object.values(binding).every(id))fail();
  const row=this.db.prepare('SELECT * FROM ga_chat_compaction_attempts WHERE attempt_id=?').get(binding.attempt_id),intent=this.db.prepare('SELECT * FROM ga_chat_compaction_intents WHERE intent_id=?').get(binding.intent_id);
  if(!row||!intent||row.intent_id!==binding.intent_id||row.observer_id!==binding.observer_id||row.fence_id!==binding.fence_id||row.owner_id!==scope.owner_id||row.conversation_id!==scope.conversation_id||row.run_id!==scope.run_id||row.session_id!==scope.session_ref
   ||row.source_json!==intent.source_json||row.source_sha256!==intent.source_sha256||sha(String(row.source_json))!==row.source_sha256||sha(String(row.request_json))!==row.request_sha256||sha(String(row.witness_json))!==row.witness_sha256)return fail();
  const source=JSON.parse(String(row.source_json));if(source.owner_id!==scope.owner_id||source.conversation_id!==scope.conversation_id||source.run_id!==scope.run_id||source.session_id!==scope.session_ref||source.run_version!==scope.expected_run_version||source.kind!=='chat_compaction_source'||source.execution_authorized!==false)fail();requestValue(JSON.parse(String(row.request_json)),source);return row;
 }
 read(scope:Scope,binding:Binding){return withImmediateTransaction(this.db,()=>this.receipt(this.load(scope,binding)));}
 reserve(scope:Scope,input:{intent_id:string;attempt_id:string;observer_id:string;request:unknown;witness:unknown}){
  return withImmediateTransaction(this.db,()=>{
   validateScope(scope);if(!input||Object.keys(input).sort().join(',')!=='attempt_id,intent_id,observer_id,request,witness'||![input.intent_id,input.attempt_id,input.observer_id].every(id))fail();
   const intent=readChatCompactionIntent(this.db,scope,input.intent_id),request=canonicalModelJson(requestValue(input.request,intent.source)),witness=canonicalModelJson(input.witness);inspectChatCompactionNative(this.db,scope,String(intent.source_sha256),input.witness);
   const prior=this.db.prepare('SELECT * FROM ga_chat_compaction_attempts WHERE intent_id=? OR attempt_id=?').all(input.intent_id,input.attempt_id);
   if(prior.length){if(prior.length!==1||prior[0]!.attempt_id!==input.attempt_id||prior[0]!.intent_id!==input.intent_id||prior[0]!.observer_id!==input.observer_id||prior[0]!.request_json!==request||prior[0]!.witness_json!==witness)return fail();return this.receipt(this.load(scope,{intent_id:input.intent_id,attempt_id:input.attempt_id,observer_id:input.observer_id,fence_id:String(prior[0]!.fence_id)}));}
   const time=this.time(),at=new Date(time).toISOString(),fence='compact-fence-'+randomUUID();
   this.db.prepare("INSERT INTO ga_chat_compaction_attempts(attempt_id,intent_id,fence_id,observer_id,owner_id,conversation_id,run_id,session_id,source_json,source_sha256,request_json,request_sha256,witness_json,witness_sha256,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?)").run(input.attempt_id,input.intent_id,fence,input.observer_id,scope.owner_id,scope.conversation_id,scope.run_id,scope.session_ref,canonicalModelJson(intent.source),String(intent.source_sha256),request,sha(request),witness,sha(witness),time+this.ttl,at,at);
   const row=this.load(scope,{intent_id:input.intent_id,attempt_id:input.attempt_id,observer_id:input.observer_id,fence_id:fence});this.event(row);return this.receipt(row);
  });
 }
 dispatch(scope:Scope,binding:Binding){return withImmediateTransaction(this.db,()=>{
  const row=this.load(scope,binding);if(row.state!=='reserved'){if(['dispatched','usage_unknown','settled'].includes(String(row.state)))return this.receipt(row);return fail();}
  if(Number(row.expires_at)<=this.time())return fail();readChatCompactionIntent(this.db,scope,binding.intent_id);inspectChatCompactionNative(this.db,scope,String(row.source_sha256),JSON.parse(String(row.witness_json)));
  this.db.prepare("UPDATE ga_chat_compaction_attempts SET state='dispatched',updated_at=? WHERE attempt_id=? AND state='reserved'").run(new Date(this.time()).toISOString(),binding.attempt_id);const changed=this.load(scope,binding);this.event(changed);return this.receipt(changed,true);
 });}
 release(scope:Scope,binding:Binding){return withImmediateTransaction(this.db,()=>{const row=this.load(scope,binding);if(row.state==='released')return this.receipt(row);if(row.state!=='reserved')return fail();this.db.prepare("UPDATE ga_chat_compaction_attempts SET state='released',reason='unused',updated_at=? WHERE attempt_id=?").run(new Date(this.time()).toISOString(),binding.attempt_id);const changed=this.load(scope,binding);this.event(changed);return this.receipt(changed);});}
 unknown(scope:Scope,binding:Binding,reason:string,usage?:unknown){return withImmediateTransaction(this.db,()=>{
  if(!reasons.has(reason))return fail();const row=this.load(scope,binding);if(row.state==='settled')return this.receipt(row);if(row.state==='reserved'){if(usage!==undefined)return fail();return this.release(scope,binding);}if(!['dispatched','usage_unknown'].includes(String(row.state)))return fail();
  const json=usage===undefined?(row.usage_json as string|null):canonicalModelJson(object(usage,['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens']));if(usage!==undefined)usageValue(usage);
  if(row.state==='usage_unknown'&&row.usage_json===json&&row.reason===reason)return this.receipt(row);
  this.db.prepare("UPDATE ga_chat_compaction_attempts SET state='usage_unknown',usage_json=?,usage_status=?,reason=?,updated_at=? WHERE attempt_id=?").run(json,json===null?'none':'partial',reason,new Date(this.time()).toISOString(),binding.attempt_id);const changed=this.load(scope,binding);this.event(changed);return this.receipt(changed);
 });}
 settle(scope:Scope,binding:Binding,input:unknown){return withImmediateTransaction(this.db,()=>{
  const row=this.load(scope,binding);if(!['dispatched','usage_unknown','settled'].includes(String(row.state)))return fail();const usage=usageValue(input);if(!usage.complete){if(row.state==='settled')return fail();return this.unknown(scope,binding,'usage_incomplete',input);}
  if(row.state==='settled'){if(row.usage_json!==usage.json)return fail();return this.receipt(row);}
  this.db.prepare("UPDATE ga_chat_compaction_attempts SET state='settled',usage_json=?,usage_status='complete',actual_tokens=?,reason=NULL,updated_at=? WHERE attempt_id=?").run(usage.json,usage.tokens,new Date(this.time()).toISOString(),binding.attempt_id);const changed=this.load(scope,binding);this.event(changed);return this.receipt(changed);
 });}
}

export {usageValue as chatCompactionUsageValue};
