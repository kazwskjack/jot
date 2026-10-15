import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
type Authority={owner:string;root_run:string;lease_generation:number;lead:string;members:string[];lease_owner?:string;policy_version?:number};
type State={revision:number;controller:string;phase:'active'|'returned'|'stopped';hops:number;max_hops:number;route:string[]};
type Row={authority_json:string;state_json:string};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
/** Trusted host boundary only. No HTTP/tool dispatch, model loop or permission
 * grants. The host must revalidate original task, role policy, lease and budget
 * in authorize on every read/mutation and apply assertController to execution. */
export class TaskHandoffController {
 private db:DatabaseSync;private authorize:(owner:string,root:string)=>Authority;
 constructor(db:DatabaseSync,authorize:(owner:string,root:string)=>Authority){
  if(typeof authorize!=='function')throw new Error('handoff_authorizer_required');this.db=db;this.authorize=authorize;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_handoff_control(owner_id TEXT NOT NULL,root_run_id TEXT NOT NULL,authority_json TEXT NOT NULL,state_json TEXT NOT NULL,PRIMARY KEY(owner_id,root_run_id));
   CREATE TABLE IF NOT EXISTS wb_task_handoff_requests(owner_id TEXT NOT NULL,root_run_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(owner_id,root_run_id,request_id));
   CREATE TRIGGER IF NOT EXISTS wb_task_handoff_request_no_update BEFORE UPDATE ON wb_task_handoff_requests BEGIN SELECT RAISE(ABORT,'handoff_receipt_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_task_handoff_request_no_delete BEFORE DELETE ON wb_task_handoff_requests BEGIN SELECT RAISE(ABORT,'handoff_receipt_immutable'); END;`);
 }
 private authority(owner:string,root:string){
  if(!id(owner)||!id(root))throw new Error('handoff_identity_invalid');const a=this.authorize(owner,root);
  if(!a||a.owner!==owner||a.root_run!==root||!id(a.lead)||!Array.isArray(a.members)||!a.members.length||a.members.some(v=>!id(v)||v===a.lead)||new Set(a.members).size!==a.members.length||!Number.isSafeInteger(a.lease_generation)||a.lease_generation<1)throw new Error('handoff_authority_invalid');
  if(a.lease_owner!==undefined&&!id(a.lease_owner)||a.policy_version!==undefined&&(!Number.isSafeInteger(a.policy_version)||a.policy_version<1))throw new Error('handoff_authority_invalid');
  return {owner,root_run:root,lease_generation:a.lease_generation,lead:a.lead,members:[...a.members].sort(),...(a.lease_owner===undefined?{}:{lease_owner:a.lease_owner}),...(a.policy_version===undefined?{}:{policy_version:a.policy_version})};
 }
 private row(owner:string,root:string,a:Authority){const r=this.db.prepare('SELECT authority_json,state_json FROM wb_task_handoff_control WHERE owner_id=? AND root_run_id=?').get(owner,root) as Row|undefined;if(r&&r.authority_json!==JSON.stringify(a))throw new Error('handoff_lease_changed');return r;}
 private digest(action:string,input:Record<string,unknown>){return createHash('sha256').update(JSON.stringify([action,Object.entries(input).sort(([a],[b])=>a.localeCompare(b))])).digest('hex');}
 get(owner:string,root:string):State {const a=this.authority(owner,root),r=this.row(owner,root,a);if(!r)throw new Error('handoff_not_started');return JSON.parse(r.state_json);}
 getIfStarted(owner:string,root:string):State|null {const a=this.authority(owner,root),r=this.row(owner,root,a);return r?JSON.parse(r.state_json):null;}
 readReceipt(owner:string,root:string,action:string,input:Record<string,unknown>){
  if(!id(input.request_id))throw new Error('handoff_request_invalid');const a=this.authority(owner,root);this.row(owner,root,a);
  const prior=this.db.prepare('SELECT digest,response_json FROM wb_task_handoff_requests WHERE owner_id=? AND root_run_id=? AND request_id=?').get(owner,root,input.request_id) as {digest:string;response_json:string}|undefined;
  if(!prior)return {found:false as const};return {found:true as const,digest_matches:prior.digest===this.digest(action,input),response:JSON.parse(prior.response_json) as unknown};
 }
 assertController(owner:string,root:string,role:string,revision:number){const s=this.get(owner,root);if(s.revision!==revision)throw new Error('handoff_revision_conflict');if(s.phase!=='active')throw new Error('handoff_closed');if(s.controller!==role)throw new Error('handoff_controller_changed');return s;}
 private mutate(owner:string,root:string,action:string,input:Record<string,unknown>,change:(a:Authority,r:Row|undefined)=>State){
  if(!id(input.request_id))throw new Error('handoff_request_invalid');return withImmediateTransaction(this.db,()=>{
   const a=this.authority(owner,root),r=this.row(owner,root,a);const digest=this.digest(action,input);
   const prior=this.db.prepare('SELECT digest,response_json FROM wb_task_handoff_requests WHERE owner_id=? AND root_run_id=? AND request_id=?').get(owner,root,input.request_id as string) as {digest:string;response_json:string}|undefined;
   if(prior){if(prior.digest!==digest)throw new Error('handoff_request_conflict');return JSON.parse(prior.response_json) as State;}
   const next=change(a,r);this.db.prepare('INSERT INTO wb_task_handoff_control VALUES(?,?,?,?) ON CONFLICT(owner_id,root_run_id) DO UPDATE SET state_json=excluded.state_json').run(owner,root,JSON.stringify(a),JSON.stringify(next));
   this.db.prepare('INSERT INTO wb_task_handoff_requests VALUES(?,?,?,?,?)').run(owner,root,input.request_id as string,digest,JSON.stringify(next));return next;
  });
 }
 start(owner:string,root:string,input:{request_id:string;max_hops:number}){
  if(Object.keys(input).some(k=>!['request_id','max_hops'].includes(k))||!Number.isSafeInteger(input.max_hops)||input.max_hops<1||input.max_hops>20)throw new Error('handoff_request_invalid');
  return this.mutate(owner,root,'start',input,(a,r)=>{if(r)throw new Error('handoff_already_started');return {revision:1,controller:a.lead,phase:'active',hops:0,max_hops:input.max_hops,route:[a.lead]};});
 }
 transfer(owner:string,root:string,input:{request_id:string;expected_revision:number;from:string;to:string}){
  if(Object.keys(input).some(k=>!['request_id','expected_revision','from','to'].includes(k))||!id(input.from)||!id(input.to)||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1)throw new Error('handoff_request_invalid');
  return this.mutate(owner,root,'transfer',input,(a,r)=>{
   if(!r)throw new Error('handoff_not_started');const s:State=JSON.parse(r.state_json);if(s.revision!==input.expected_revision)throw new Error('handoff_revision_conflict');if(s.phase!=='active')throw new Error('handoff_closed');if(s.controller!==input.from)throw new Error('handoff_controller_changed');
   if(input.to!==a.lead&&!a.members.includes(input.to))throw new Error('handoff_role_forbidden');
   if(s.route.includes(input.to)&&input.to!==a.lead||input.from===input.to)throw new Error('handoff_route_repeated');
   if(input.to!==a.lead&&s.hops>=s.max_hops)throw new Error('handoff_hop_exhausted');
   return {...s,revision:s.revision+1,controller:input.to,phase:input.to===a.lead?'returned':'active',hops:s.hops+(input.to===a.lead?0:1),route:[...s.route,input.to]};
  });
 }
 stop(owner:string,root:string,input:{request_id:string;expected_revision:number}){
  if(Object.keys(input).some(k=>!['request_id','expected_revision'].includes(k))||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1)throw new Error('handoff_request_invalid');
  return this.mutate(owner,root,'stop',input,(_a,r)=>{if(!r)throw new Error('handoff_not_started');const s:State=JSON.parse(r.state_json);if(s.revision!==input.expected_revision)throw new Error('handoff_revision_conflict');if(s.phase!=='active')throw new Error('handoff_closed');return {...s,revision:s.revision+1,phase:'stopped'};});
 }
}
