import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {DiscoveryPolicies} from './discovery-policy.ts';
type Options={policies:DiscoveryPolicies;actor:(request:FastifyRequest)=>string;role:(owner:string,id:string)=>{project_id:string;workspace_id:string;agent_id:string};atomic:<T>(request:FastifyRequest,status:number,operation:()=>T)=>T};
export function registerDiscoveryPolicyRoutes(app:FastifyInstance,options:Options){
 const scope=(request:FastifyRequest)=>{const owner=options.actor(request),role=options.role(owner,(request.params as {agentId:string}).agentId);return {owner,scope:{project_id:role.project_id,workspace_id:role.workspace_id,agent_id:role.agent_id}};};
 const key=(request:FastifyRequest)=>{const value=request.headers['idempotency-key'];if(typeof value!=='string'||!/^[\x21-\x7e]{8,128}$/.test(value))throw Error('idempotency_key_invalid');return value;};
 app.get('/v1/agents/:agentId/discovery-policy',async request=>{const owned=scope(request);return options.policies.get(owned.owner,owned.scope);});
 app.patch('/v1/agents/:agentId/discovery-policy',async request=>{const owned=scope(request),command=key(request);return options.atomic(request,200,()=>options.policies.save(owned.owner,owned.scope,request.body,command));});
 app.post('/v1/agents/:agentId/discovery-policy/control',async request=>{const owned=scope(request),command=key(request);return options.atomic(request,200,()=>options.policies.control(owned.owner,owned.scope,request.body,command));});
}
