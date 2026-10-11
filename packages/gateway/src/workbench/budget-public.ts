import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {withImmediateTransaction} from '../db/database.ts';
import {dailyBudgetDefinitions,taskBudgetKey,type WorkbenchBudgetPolicy} from './model-budget-policy.ts';
import type {ModelBudgetLimits} from './model-budget.ts';

const fields=['tokens','nano_usd','model_calls'] as const;
const strings=(value:ModelBudgetLimits)=>Object.fromEntries(fields.map(key=>[key,String(value[key])]));
const zero=()=>({tokens:'0',nano_usd:'0',model_calls:'0'});
type TaskRow={task_id:string;agent_id:string;workspace_id:string;project_id:string};
/** User projection has no model routes, native sessions, scope identities or machine paths. */
export class TaskBudgetService {
  private readonly db:DatabaseSync;
  private readonly policy:WorkbenchBudgetPolicy|undefined;
  constructor(db:DatabaseSync,policy?:WorkbenchBudgetPolicy){this.db=db;this.policy=policy;}
  private task(owner:string,id:string):TaskRow {
    const row=this.db.prepare(`SELECT t.task_id,t.agent_id,a.workspace_id,a.project_id FROM wb_persistent_tasks t
      JOIN wb_agents a ON a.agent_id=t.agent_id WHERE t.task_id=? AND t.owner_id=? AND a.owner_id=?`).get(id,owner,owner) as TaskRow|undefined;
    if(!row)throw new Error('task_not_found');return row;
  }
  get(owner:string,id:string) {
    return withImmediateTransaction(this.db,()=>this.view(owner,this.task(owner,id)));
  }
  private view(owner:string,task:TaskRow) {
    if(!this.policy)return {configured:false as const,task_id:task.task_id,reason:'BUDGET_POLICY_NOT_CONFIGURED' as const};
    const settings=this.policy.budgetSettings(),key=taskBudgetKey(task.task_id),ledger=this.policy.ledger;
    const revision=ledger.limitPolicy(owner,key,settings.limits.task_total);
    const daily=dailyBudgetDefinitions(task.workspace_id,task.project_id,task.agent_id,settings.instant);
    function remaining(limits:Record<string,string>,used:Record<string,string>,held:Record<string,string>){
      return Object.fromEntries(fields.map(field=>{const n=BigInt(limits[field]!)-BigInt(used[field]!)-BigInt(held[field]!);return [field,String(n>0n?n:0n)];}));
    }
    const summary=(kind:string,scopeKey:string,base:ModelBudgetLimits,window?:{starts_at:string;ends_at:string})=>{
      const row=this.db.prepare('SELECT scope_id FROM wb_model_budget_scopes WHERE owner_id=? AND scope_key=?').get(owner,scopeKey) as {scope_id:string}|undefined;
      const balance=row?ledger.balance(owner,row.scope_id):{limits:strings(ledger.limitPolicy(owner,scopeKey,base).limits),used:zero(),held:zero()};
      return {kind,limits:balance.limits,used:balance.used,held:balance.held,remaining:remaining(balance.limits,balance.used,balance.held),starts_at:window?.starts_at??null,ends_at:window?.ends_at??null};
    };
    const root=summary('task_total',key,settings.limits.task_total);
    const shared=daily.definitions.map(item=>summary(item.category,item.key,settings.limits[item.category],daily.window));
    const usage=this.db.prepare(`WITH task_runs AS (
      SELECT run_id FROM wb_task_run_occurrences WHERE task_id=?
      UNION SELECT run_id FROM wb_task_auxiliary_runs WHERE task_id=? AND owner_id=?)
      SELECT COALESCE(SUM(CASE WHEN a.state='unknown' THEN 1 ELSE 0 END),0) AS unknown_calls,
      COALESCE(SUM(CASE WHEN a.state='settled' AND json_extract(a.route_json,'$.billing.unit')='dispatched_call' THEN 1 ELSE 0 END),0) AS unmetered_calls
      FROM wb_model_budget_attempts a JOIN wb_model_budget_bindings b ON b.run_id=a.run_id
      JOIN task_runs r ON r.run_id=a.run_id WHERE b.owner_id=?`).get(task.task_id,task.task_id,owner,owner) as {unknown_calls:number;unmetered_calls:number};
    const blocking_reasons:string[]=[];
    for(const scope of [root,...shared])for(const field of fields){
      if(BigInt(scope.remaining[field]!)<settings.nextCall[field])blocking_reasons.push(`${scope.kind}:${field}`);
    }
    for(const field of fields)if(BigInt(settings.limits.occurrence[field])<settings.nextCall[field])blocking_reasons.push(`occurrence:${field}`);
    if(usage.unknown_calls)blocking_reasons.push('usage_unknown');
    return {configured:true as const,task_id:task.task_id,version:revision.version,root,ceiling:strings(settings.limits.task_total),shared,
      can_start_next_call:blocking_reasons.length===0,blocking_reasons,pending_unknown:Number(usage.unknown_calls),
      token_accounting:'metered_routes_only' as const,unmetered_token_calls:Number(usage.unmetered_calls),
      cost_basis:'configured_rates' as const,currency:'USD' as const,as_of:settings.instant.toISOString()};
  }
  update(owner:string,id:string,input:unknown) {
    return withImmediateTransaction(this.db,()=>{
      const task=this.task(owner,id);
      if(!this.policy)throw new Error('budget_service_unavailable');
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['expected_version','limits'].includes(key)))throw new Error('budget_limit_invalid');
      const body=input as {expected_version:number;limits:ModelBudgetLimits};
      this.policy.ledger.setLimits(owner,taskBudgetKey(id),body.expected_version,body.limits,this.policy.budgetSettings().limits.task_total);
      return this.view(owner,task);
    });
  }
}
export function registerTaskBudgetRoutes(app:FastifyInstance,service:TaskBudgetService,actor:(request:FastifyRequest)=>string){
  const id=(request:FastifyRequest)=>(request.params as {taskId:string}).taskId;
  app.get('/v1/persistent-tasks/:taskId/model-budget',async request=>service.get(actor(request),id(request)));
  app.patch('/v1/persistent-tasks/:taskId/model-budget',async request=>service.update(actor(request),id(request),request.body));
}
