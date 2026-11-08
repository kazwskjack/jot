import type {FastifyInstance,FastifyReply} from 'fastify';
import type {HostNamespaceSettingsSnapshot} from '../harness/session-controller-client.ts';
import {validateHostSettingsProductCommand,validateHostSettingsProductResult,validateHostSettingsEditor,validateHostSettingsApprovalRequest,type HostSettingsProductCommand,type HostSettingsApprovalRequest} from './settings-product-contract.ts';

export type HostSettingsClient={
 redeemHostBootstrap(state:string,code:string):Promise<{ticket:string;expires_at:number}>;
 readHostSettings(ticket:string,namespace:string):Promise<HostNamespaceSettingsSnapshot>;
 readHostReadiness?:(ticket:string,namespace:string)=>Promise<Readonly<Record<string,unknown>>>;
 readHostSettingsEditor?:(ticket:string,namespace:string)=>Promise<Record<string,unknown>>;
 saveHostSettings?:(ticket:string,namespace:string,command:HostSettingsProductCommand,key:string)=>Promise<Record<string,unknown>>;
 queryHostSettingsAttempt?:(ticket:string,namespace:string,key:string)=>Promise<Record<string,unknown>>;
 prepareHostSettingsApproval?:(ticket:string,namespace:string,actorId:string,input:HostSettingsApprovalRequest)=>Promise<Record<string,unknown>>;
};

const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const NAMESPACE=/^[a-z][a-z0-9._-]{0,127}$/;
const deny=(reply:FastifyReply,status:number,code:string)=>reply.code(status).header('cache-control','no-store').send({error:{code}});
function failure(reply:FastifyReply,error:unknown,scope:'bootstrap'|'settings'|'readiness'){
 const status=Number((error as {status?:unknown})?.status);
 if(status===401||status===403||status===409)return deny(reply,status,scope==='bootstrap'?'HOST_BOOTSTRAP_DENIED':scope==='readiness'?'HOST_READINESS_DENIED':'HOST_SETTINGS_DENIED');
 if(status===422)return deny(reply,422,scope==='bootstrap'?'HOST_BOOTSTRAP_INVALID':scope==='readiness'?'HOST_READINESS_INVALID':'HOST_SETTINGS_INVALID');
 return deny(reply,503,scope==='bootstrap'?'HOST_BOOTSTRAP_UNAVAILABLE':scope==='readiness'?'HOST_READINESS_UNAVAILABLE':'HOST_SETTINGS_UNAVAILABLE');
}

/** Exact, BFF-facing routes. The ticket is accepted only in a private header
 * and never included in a settings response or a Gateway actor context. */
export function registerHostAdminRoutes(app:FastifyInstance,{enabled=false,namespaces=[],client,writeEnabled=false,writeNamespace,authenticatedActor}:{enabled?:boolean;namespaces?:string[];client?:HostSettingsClient;writeEnabled?:boolean;writeNamespace?:string;authenticatedActor?:(request:unknown)=>string}={}){
 const allowed=new Set(namespaces);
 if(writeEnabled&&(writeNamespace!=='jot-session-adapter'||!NAMESPACE.test(writeNamespace)||!allowed.has(writeNamespace)))throw Error('host_settings_write_configuration_invalid');
 const productScope=(request:any,reply:FastifyReply)=>{
  if(!writeEnabled||!client){deny(reply,404,'NOT_FOUND');return null;}
  const query=new URL(request.url,'http://gateway.invalid').searchParams,namespace=query.get('namespace'),ticket=request.headers['x-jot-host-context-ticket'];
  if(query.size!==1||!namespace||namespace!==writeNamespace){deny(reply,422,'HOST_SETTINGS_INVALID');return null;}
  if(typeof ticket!=='string'||!TOKEN.test(ticket)){deny(reply,401,'HOST_CONTEXT_REQUIRED');return null;}
  return{ticket,namespace};
 };
 const resultReply=(reply:FastifyReply,result:unknown,namespace:string)=>{
  const value=validateHostSettingsProductResult(result,namespace),status=value.status==='saved'?200:value.status==='unknown_pending'?202:value.status==='conflict'||value.status==='stale_scope'?409:value.status==='rejected'?422:value.reason_code==='host_settings_owner_approval_invalid'?403:503;
  return reply.code(status).header('cache-control','no-store').send(value);
 };
 app.post('/v1/host/bootstrap/redeem',{
  preValidation:async(request,reply)=>{
   const body=request.body;
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='code,state')return deny(reply,422,'HOST_BOOTSTRAP_INVALID');
  },
  schema:{body:{type:'object',properties:{state:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'},code:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}},required:['state','code'],additionalProperties:false}}
 },async(request,reply)=>{
  if(enabled!==true||!client)return deny(reply,404,'NOT_FOUND');
  const body=request.body as {state:string;code:string};
  if(!TOKEN.test(body.state)||!TOKEN.test(body.code))return deny(reply,422,'HOST_BOOTSTRAP_INVALID');
  try{
   const result=await client.redeemHostBootstrap(body.state,body.code);
   if(!result||!TOKEN.test(result.ticket)||!Number.isSafeInteger(result.expires_at)||result.expires_at<=Date.now())return deny(reply,503,'HOST_BOOTSTRAP_UNAVAILABLE');
   return reply.code(200).header('cache-control','no-store').send({ticket:result.ticket,expires_at:result.expires_at});
  }catch(error){return failure(reply,error,'bootstrap');}
 });
 app.get('/v1/host/settings',{
  schema:{querystring:{type:'object',properties:{namespace:{type:'string',pattern:'^[a-z][a-z0-9._-]{0,127}$'}},required:['namespace'],additionalProperties:false}}
 },async(request,reply)=>{
  if(enabled!==true||!client)return deny(reply,404,'NOT_FOUND');
  const rawQuery=new URL(request.url,'http://gateway.invalid').searchParams;
  if(rawQuery.size!==1||!rawQuery.has('namespace'))return deny(reply,422,'HOST_SETTINGS_INVALID');
  const {namespace}=(request.query as {namespace:string});
  const supplied=request.headers['x-jot-host-context-ticket'];
  if(typeof supplied!=='string'||!TOKEN.test(supplied))return deny(reply,401,'HOST_CONTEXT_REQUIRED');
  if(!NAMESPACE.test(namespace)||namespace==='jot-host-policy'||!allowed.has(namespace))return deny(reply,403,'HOST_SETTINGS_DENIED');
  try{
   const snapshot=await client.readHostSettings(supplied,namespace);
   if(!snapshot||snapshot.namespaces.length!==1||snapshot.namespaces[0]?.namespace!==namespace)return deny(reply,503,'HOST_SETTINGS_UNAVAILABLE');
   return reply.code(200).header('cache-control','no-store').send(snapshot);
  }catch(error){return failure(reply,error,'settings');}
 });
 app.get('/v1/host/readiness',{
  schema:{querystring:{type:'object',properties:{namespace:{type:'string',pattern:'^[a-z][a-z0-9._-]{0,127}$'}},required:['namespace'],additionalProperties:false}}
 },async(request,reply)=>{
  if(enabled!==true||!client)return deny(reply,404,'NOT_FOUND');
  const rawQuery=new URL(request.url,'http://gateway.invalid').searchParams;
  if(rawQuery.size!==1||!rawQuery.has('namespace'))return deny(reply,422,'HOST_READINESS_INVALID');
  const {namespace}=(request.query as {namespace:string});
  const supplied=request.headers['x-jot-host-context-ticket'];
  if(typeof supplied!=='string'||!TOKEN.test(supplied))return deny(reply,401,'HOST_CONTEXT_REQUIRED');
  if(!NAMESPACE.test(namespace)||namespace==='jot-host-policy'||!allowed.has(namespace))return deny(reply,403,'HOST_READINESS_DENIED');
  if(!client.readHostReadiness)return deny(reply,503,'HOST_READINESS_UNAVAILABLE');
  try{
   const readiness=await client.readHostReadiness(supplied,namespace);
   if(!readiness||readiness.protocol!==1||(readiness.scope as {namespace?:unknown}|undefined)?.namespace!==namespace)return deny(reply,503,'HOST_READINESS_UNAVAILABLE');
   return reply.code(200).header('cache-control','private, no-store').send(readiness);
  }catch(error){return failure(reply,error,'readiness');}
 });
 app.get('/v1/host/settings/editor',async(request,reply)=>{
  const scope=productScope(request,reply);if(!scope)return;
  if(!client?.readHostSettingsEditor)return deny(reply,503,'HOST_SETTINGS_UNAVAILABLE');
  try{return reply.header('cache-control','no-store').send(validateHostSettingsEditor(await client.readHostSettingsEditor(scope.ticket,scope.namespace),scope.namespace));}catch(error){return failure(reply,error,'settings');}
 });
 app.post('/v1/host/settings/approval-requests',async(request,reply)=>{
  const scope=productScope(request,reply);if(!scope)return;
  if(!authenticatedActor||!client?.prepareHostSettingsApproval)return deny(reply,503,'HOST_SETTINGS_UNAVAILABLE');
  let input:HostSettingsApprovalRequest;
  try{input=validateHostSettingsApprovalRequest(request.body);}catch{return deny(reply,422,'HOST_SETTINGS_INVALID');}
  try{
   const result=await client.prepareHostSettingsApproval(scope.ticket,scope.namespace,authenticatedActor(request),input);
   return reply.header('cache-control','no-store').send({approval:result});
  }catch(error){return failure(reply,error,'settings');}
 });
 app.patch('/v1/host/settings',{config:{hostSettingsReceiptProtocol:'host-settings-original-attempt-v1'},preValidation:async(request,reply)=>{try{validateHostSettingsProductCommand(request.body);}catch{return deny(reply,422,'HOST_SETTINGS_INVALID');}}},async(request,reply)=>{
  const scope=productScope(request,reply);if(!scope)return;
  const key=request.headers['idempotency-key'];if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))return deny(reply,422,'HOST_SETTINGS_INVALID');
  if(!client?.saveHostSettings)return deny(reply,503,'HOST_SETTINGS_UNAVAILABLE');
  try{return resultReply(reply,await client.saveHostSettings(scope.ticket,scope.namespace,validateHostSettingsProductCommand(request.body),key),scope.namespace);}catch(error){return failure(reply,error,'settings');}
 });
 app.get('/v1/host/settings/attempts/:key',async(request,reply)=>{
  const scope=productScope(request,reply);if(!scope)return;
  const key=(request.params as {key:string}).key;if(!/^[A-Za-z0-9_-]{8,128}$/.test(key))return deny(reply,422,'HOST_SETTINGS_INVALID');
  if(!client?.queryHostSettingsAttempt)return deny(reply,503,'HOST_SETTINGS_UNAVAILABLE');
  try{return resultReply(reply,await client.queryHostSettingsAttempt(scope.ticket,scope.namespace,key),scope.namespace);}catch(error){return failure(reply,error,'settings');}
 });
 return app;
}
