import type {FastifyInstance,FastifyRequest} from 'fastify';
import {DiscoveryHistory,type DiscoveryHistoryScope} from './discovery-history.ts';
type Options={history:DiscoveryHistory;actor:(request:FastifyRequest)=>string;role:(owner:string,id:string)=>DiscoveryHistoryScope};
export function registerDiscoveryHistoryRoutes(app:FastifyInstance,options:Options){
 const scope=(request:FastifyRequest)=>{const owner=options.actor(request),role=options.role(owner,(request.params as {agentId:string}).agentId);return {owner,scope:{agent_id:role.agent_id,project_id:role.project_id,workspace_id:role.workspace_id}};};
 app.get('/v1/agents/:agentId/discovery-history',async request=>{const owned=scope(request),query=request.query as Record<string,unknown>;
  if(Object.keys(query).some(key=>key!=='before_id')||query.before_id!==undefined&&typeof query.before_id!=='string')throw Error('invalid_discovery_history_cursor');
  return options.history.list(owned.owner,owned.scope,query.before_id as string|undefined);});
 app.get('/v1/agents/:agentId/discovery-history/:admissionId',async request=>{const owned=scope(request),query=request.query as Record<string,unknown>;
  if(Object.keys(query).some(key=>key!=='after_plan_id')||query.after_plan_id!==undefined&&typeof query.after_plan_id!=='string')throw Error('invalid_discovery_history_cursor');
  return options.history.detail(owned.owner,owned.scope,(request.params as {admissionId:string}).admissionId,query.after_plan_id as string|undefined);});
}
