import {timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {DatabaseSync} from 'node:sqlite';
import type {RunRepository} from '../runs/repository.ts';
import {createHostSettingsOperationReceiptStore} from './settings-operation-receipts.ts';
import {createHostSettingsAdmissionFenceStore} from './settings-admission-fence.ts';
import {installHostSettingsControlSchema} from './settings-control-schema.ts';

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:unknown,keys:readonly string[])=>record(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const privateHeaders={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};

function componentAllowed(value:unknown,token:string):boolean{
 if(typeof value!=='string')return false;
 const expected=Buffer.from(`Bearer ${token}`),actual=Buffer.from(value);
 return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

/** Private Adapter-to-Gateway provider for the durable Host product receipts.
 * The Adapter has already resolved the one-use Host ticket to its A1 identity;
 * this route trusts only the configured component bearer for that assertion.
 */
export function registerHostSettingsInternalRoutes(app:FastifyInstance,{db,token,enabled=false,runs}:{db:DatabaseSync;token:string;enabled?:boolean;runs?:Pick<RunRepository,'hostSettingsActivityImpact'>}){
 if(!db||typeof token!=='string'||token.length<32||typeof enabled!=='boolean')throw Error('host_settings_internal_configuration_invalid');
 if(!enabled){
  app.post('/internal/v1/host-settings/*',async(_request,reply)=>reply.headers(privateHeaders).code(404).send({error:'not_found'}));
  return;
 }
 installHostSettingsControlSchema(db);
 const store=createHostSettingsOperationReceiptStore({db});
 const fence=createHostSettingsAdmissionFenceStore(db);
 const inspectIdentity=(identity:unknown)=>{
  if(!exact(identity,['owner_id','profile_id','namespace'])||!record(identity)
   ||!['owner_id','profile_id'].every(key=>typeof identity[key]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(identity[key] as string))
   ||typeof identity.namespace!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(identity.namespace)||identity.namespace==='jot-host-policy')throw Error('host_settings_version_identity_invalid');
  return{owner_id:identity.owner_id as string,profile_id:identity.profile_id as string,namespace:identity.namespace};
 };
 const inspectVersion=(identity:unknown)=>{
  const scope=inspectIdentity(identity);
  const row=db.prepare('SELECT settings_version,dsh_revision,schema_fingerprint,settings_sha256,reconciliation_sha256 FROM ga_host_settings_versions WHERE owner_id=? AND profile_id=? AND namespace=?')
   .get(scope.owner_id,scope.profile_id,scope.namespace);
  if(!row)return{kind:'missing' as const};
  if(!Number.isSafeInteger(row.settings_version)||Number(row.settings_version)<1||!Number.isSafeInteger(row.dsh_revision)||Number(row.dsh_revision)<0
   ||!['schema_fingerprint','settings_sha256','reconciliation_sha256'].every(key=>typeof row[key]==='string'&&/^[a-f0-9]{64}$/.test(row[key] as string)))throw Error('host_settings_version_row_invalid');
  return{kind:'present' as const,...row};
 };
 const routes=new Map<string,{keys:readonly string[];run:(body:Record<string,unknown>)=>unknown}>([
  ['/internal/v1/host-settings/activity/preview',{keys:['identity','session_refs'],run:body=>{
   const identity=inspectIdentity(body.identity);
   if(body.session_refs!==null&&!Array.isArray(body.session_refs))throw Error('host_settings_activity_source_invalid');
   const impact=runs?.hostSettingsActivityImpact(identity.owner_id,body.session_refs)??{kind:'unknown' as const};
   if(impact.kind!=='ready')return{kind:'unknown',identity};
   if(!Number.isSafeInteger(impact.active_runs)||impact.active_runs<0||!Number.isSafeInteger(impact.active_sessions)||impact.active_sessions<0)
    throw Error('host_settings_activity_source_invalid');
   return{kind:'ready',identity,active_runs:impact.active_runs,active_sessions:impact.active_sessions};
  }}],
  ['/internal/v1/host-settings/version/read',{keys:['identity','observed'],run:body=>store.readVersion(body.identity as any,body.observed as any)}],
  ['/internal/v1/host-settings/version/inspect',{keys:['identity'],run:body=>inspectVersion(body.identity)}],
  ['/internal/v1/host-settings/version/reconcile',{keys:['identity','observed','expected_version','approval_sha256'],run:body=>{
   if(!exact(body.identity,['owner_id','profile_id','namespace'])||!exact(body.observed,['dsh_revision','schema_fingerprint','settings_sha256']))throw Error('host_settings_version_input_invalid');
   return store.reconcileVersion({...body.identity as object,...body.observed as object,expected_version:body.expected_version,approval_sha256:body.approval_sha256} as Parameters<typeof store.reconcileVersion>[0]);
  }}],
  ['/internal/v1/host-settings/receipt/lookup',{keys:['identity','operation','idempotency_key','namespace','expected_version','schema_fingerprint','patch'],run:body=>store.lookupOriginal({...(body.identity as any),operation:body.operation as any,idempotency_key:body.idempotency_key as string,
    ...(body.namespace===null?{}:{namespace:body.namespace as string}),...(body.expected_version===null?{}:{expected_version:body.expected_version as number}),
    ...(body.schema_fingerprint===null?{}:{schema_fingerprint:body.schema_fingerprint as string}),...(body.patch===null?{}:{patch:body.patch as Record<string,unknown>})})}],
  ['/internal/v1/host-settings/receipt/reserve',{keys:['scope'],run:body=>store.reserve(body.scope as any)}],
  ['/internal/v1/host-settings/receipt/dispatched',{keys:['operation_id','reservation_token','request_sha256'],run:body=>store.markDispatched(body as any)}],
  ['/internal/v1/host-settings/receipt/complete',{keys:['operation_id','request_sha256','result','proof'],run:body=>store.complete(body as any)}],
  ['/internal/v1/host-settings/receipt/reject',{keys:['operation_id','request_sha256','reservation_token','result','proof'],run:body=>store.rejectNoSideEffect(body as any)}],
  ['/internal/v1/host-settings/receipt/unknown',{keys:['operation_id','request_sha256','reason'],run:body=>store.markUnknown(body as any)}],
  ['/internal/v1/host-settings/admission/begin',{keys:[],run:()=>fence.beginAdmission()}],
  ['/internal/v1/host-settings/admission/end',{keys:['admission_id'],run:body=>fence.endAdmission(String(body.admission_id))}],
  ['/internal/v1/host-settings/fence/close',{keys:['scope','admission_id'],run:body=>fence.close(body.scope,body.admission_id as string)}],
  ['/internal/v1/host-settings/fence/status',{keys:['fence_id','admission_id'],run:body=>fence.status(body.fence_id as string,body.admission_id as string)}],
  ['/internal/v1/host-settings/fence/release',{keys:['fence_id','admission_id'],run:body=>fence.release(body.fence_id as string,body.admission_id as string)}],
 ]);
 for(const [path,route] of routes){
  app.post(path,{config:{hostSettingsInternal:true}},async(request,reply)=>{
   reply.headers(privateHeaders);
   if(!enabled)return reply.code(404).send({error:'not_found'});
   if(!componentAllowed(request.headers.authorization,token))return reply.code(401).send({error:'unauthorized'});
   if(!exact(request.body,route.keys))return reply.code(422).send({error:'invalid_host_settings_internal_input'});
   try{return reply.code(200).send({result:route.run(request.body as Record<string,unknown>)});}
   catch{return reply.code(503).send({error:'host_settings_internal_unavailable'});}
  });
 }
 return store;
}
