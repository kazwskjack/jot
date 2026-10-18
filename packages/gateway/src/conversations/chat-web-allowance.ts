import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {withImmediateTransaction} from '../db/database.ts';
import {inspectOrdinaryExecutionPolicy} from './execution-policy.ts';
import {canonicalModelJson} from './model-policy.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
type Call={call_id:string;name:'web_search'|'web_fetch';arguments:Record<string,unknown>};
type Group={protocol:1;kind:'search'|'fetch';native_turn:number;native_step:number;assistant_seq:number;assistant_message_id:string;calls:Call[]};
export function normalizeChatWebGroup(value:unknown):Group{
 const fail=():never=>{throw Error('chat_web_group_invalid');};
 if(!plain(value)||Object.keys(value).sort().join(',')!=='assistant_message_id,assistant_seq,calls,kind,native_step,native_turn,protocol'
  ||value.protocol!==1||!['search','fetch'].includes(String(value.kind))||!['native_turn','native_step','assistant_seq'].every(k=>Number.isSafeInteger(value[k])&&Number(value[k])>=0)
  ||typeof value.assistant_message_id!=='string'||!ID.test(value.assistant_message_id)||!Array.isArray(value.calls)||!value.calls.length||value.calls.length>256)return fail();
 const ids=new Set();
 for(const call of value.calls){
  if(!plain(call)||Object.keys(call).sort().join(',')!=='arguments,call_id,name'||typeof call.call_id!=='string'||!ID.test(call.call_id)||ids.has(call.call_id)
   ||call.name!==(value.kind==='search'?'web_search':'web_fetch')||!plain(call.arguments))return fail();
  ids.add(call.call_id);const args=call.arguments;
  if(value.kind==='search'){
   if(Object.keys(args).join(',')!=='queries'||!Array.isArray(args.queries)||!args.queries.length||args.queries.length>4||args.queries.some(v=>typeof v!=='string'||!v.trim()))return fail();
  }else{
   if(Object.keys(args).join(',')!=='url'||typeof args.url!=='string')return fail();
   try{const url=new URL(args.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return fail();}catch{return fail();}
  }
 }
 if(Buffer.byteLength(canonicalModelJson(value))>1048576)return fail();
 return structuredClone(value) as Group;
}
/** Consume before effects. A lost acknowledgement is not a second permission.
 * Group identity comes from the trusted Host's committed assistant step;
 * original owner/run/Session/lease and accepted Chat policy stay authoritative. */
export function reserveOrdinaryChatWeb(db:DatabaseSync,input:{run_id:string;session_ref:string;execution_lease:unknown;group:unknown;call_id:string}){
 const group=normalizeChatWebGroup(input.group),call=group.calls.find(c=>c.call_id===input.call_id);
 if(!call)throw Error('chat_web_call_invalid');
 return withImmediateTransaction(db,()=>{
  const proof=inspectOrdinaryExecutionPolicy(db,input.run_id,input.session_ref,input.execution_lease);
  if(proof.policy.mode!=='chat')throw Error('chat_web_scope_invalid');
  const body=canonicalModelJson(group),digest=hash(body),now=new Date().toISOString();
  const prior=db.prepare('SELECT * FROM ga_chat_web_groups WHERE run_id=? AND kind=?').get(input.run_id,group.kind);
  if(prior&&(prior.session_id!==input.session_ref||prior.group_json!==body||prior.group_sha256!==digest||prior.policy_sha256!==proof.policy_sha256))throw Error('chat_web_group_exhausted');
  if(!prior)db.prepare('INSERT INTO ga_chat_web_groups(run_id,kind,session_id,native_turn,native_step,assistant_seq,group_json,group_sha256,policy_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
   .run(input.run_id,group.kind,input.session_ref,group.native_turn,group.native_step,group.assistant_seq,body,digest,proof.policy_sha256,now);
  const requestHash=hash(canonicalModelJson(call.arguments));
  const receipt=(first_dispatch:boolean,reason:string)=>({protocol:1,run_id:input.run_id,session_id:input.session_ref,kind:group.kind,call_id:call.call_id,group_sha256:digest,request_sha256:requestHash,policy_sha256:proof.policy_sha256,first_dispatch,reason});
  const previous=db.prepare('SELECT kind,request_sha256 FROM ga_chat_web_calls WHERE run_id=? AND call_id=?').get(input.run_id,call.call_id);
  if(previous){if(previous.kind!==group.kind||previous.request_sha256!==requestHash)throw Error('chat_web_call_conflict');return receipt(false,'already_consumed');}
  let urlHash:string|null=null;
  if(group.kind==='fetch'){
   const url=new URL(call.arguments.url as string);url.hash='';urlHash=hash(url.href);
   if(db.prepare('SELECT 1 FROM ga_chat_web_calls WHERE run_id=? AND url_sha256=?').get(input.run_id,urlHash))return receipt(false,'duplicate_url');
  }
  db.prepare('INSERT INTO ga_chat_web_calls(run_id,call_id,kind,request_sha256,url_sha256,created_at) VALUES(?,?,?,?,?,?)').run(input.run_id,call.call_id,group.kind,requestHash,urlHash,now);
  return receipt(true,'first_dispatch');
 });
}
