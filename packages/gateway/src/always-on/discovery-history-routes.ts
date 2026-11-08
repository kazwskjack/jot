import type {FastifyInstance,FastifyRequest} from 'fastify';
import {DatabaseSync} from 'node:sqlite';
import {DiscoveryHistory,type DiscoveryHistoryScope} from './discovery-history.ts';
import {WorkCycles,type CreateWorkCycle} from './work-cycles.ts';
type Options={history:DiscoveryHistory;actor:(request:FastifyRequest)=>string;role:(owner:string,id:string)=>DiscoveryHistoryScope};
export function registerDiscoveryHistoryRoutes(app:FastifyInstance,options:Options){
 const scope=(request:FastifyRequest)=>{const owner=options.actor(request),role=options.role(owner,(request.params as {agentId:string}).agentId);return {owner,scope:{agent_id:role.agent_id,project_id:role.project_id,workspace_id:role.workspace_id}};};
 // server.ts already injects the shared DatabaseSync through DiscoveryHistory;
 // M08.01 keeps that registration unchanged and validates the existing handle here.
 const cycles=()=>{const db=Reflect.get(options.history,'db');if(!(db instanceof DatabaseSync))throw Error('work_cycle_service_unavailable');return new WorkCycles(db);};
 const key=(request:FastifyRequest)=>{const value=request.headers['idempotency-key'];if(typeof value!=='string'||!/^[\x21-\x7e]{8,128}$/.test(value))throw Error('idempotency_key_invalid');return value;};
 app.get('/v1/agents/:agentId/discovery-history',async request=>{const owned=scope(request),query=request.query as Record<string,unknown>;
  if(Object.keys(query).some(key=>key!=='before_id')||query.before_id!==undefined&&typeof query.before_id!=='string')throw Error('invalid_discovery_history_cursor');
  return options.history.list(owned.owner,owned.scope,query.before_id as string|undefined);});
 app.get('/v1/agents/:agentId/discovery-history/:admissionId',async request=>{const owned=scope(request),query=request.query as Record<string,unknown>;
  if(Object.keys(query).some(key=>key!=='after_plan_id')||query.after_plan_id!==undefined&&typeof query.after_plan_id!=='string')throw Error('invalid_discovery_history_cursor');
  return options.history.detail(owned.owner,owned.scope,(request.params as {admissionId:string}).admissionId,query.after_plan_id as string|undefined);});
 app.post('/v1/agents/:agentId/discovery-history/:admissionId/work-cycles',async (request,reply)=>{
  const owned=scope(request);
  try{
   const body=request.body as Record<string,unknown>,allowed=['report_sha256','plan_ids','expected_policy_version','expected_role_version','expected_role_epoch'];
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(name=>!allowed.includes(name)))throw Error('work_cycle_invalid');
   const input={...body,admission_id:(request.params as {admissionId:string}).admissionId} as CreateWorkCycle;
   return cycles().create(owned.owner,owned.scope,input,key(request));
  }
  catch(error){
   const code=error instanceof Error?error.message:'';
   if(code==='work_cycle_invalid')return reply.code(422).send({error:{code:'WORK_CYCLE_INVALID'}});
   if(code==='work_cycle_not_found')return reply.code(404).send({error:{code:'WORK_CYCLE_NOT_FOUND'}});
   if(code==='work_cycle_service_unavailable')return reply.code(503).send({error:{code:'WORK_CYCLE_SERVICE_UNAVAILABLE'}});
   if(['work_cycle_authority_revoked','work_cycle_budget_binding_unconfirmed','work_cycle_report_unaccepted','work_cycle_version_conflict','work_cycle_slot_occupied','work_cycle_corrupt','idempotency_conflict'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
   throw error;
  }
 });
}
