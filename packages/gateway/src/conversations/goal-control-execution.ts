import type {FastifyInstance} from 'fastify';
import {timingSafeEqual} from 'node:crypto';
import {normalizeExecutionLease} from '../workbench/execution-lease.ts';
import type {ConversationGoalControls} from './goal-controls.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** Existing service credential plus exact original run/Session/lease, never a
 * user-controlled owner header or general native mutation endpoint.
 */
export function registerConversationGoalExecution(app:FastifyInstance,controls:ConversationGoalControls,token:string|undefined){
 app.post('/internal/v1/workbench/conversation-goal-control',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const body=request.body as Record<string,unknown>;
  const keys=body&&typeof body==='object'&&!Array.isArray(body)?Object.keys(body).sort().join(','):'';
  const allowed={inspect:'control_id,execution_lease,operation,run_id,session_ref',begin:'control_id,cursor,execution_lease,observer_id,operation,run_id,session_ref',applied:'control_id,execution_lease,observer_id,operation,receipt,run_id,session_ref',rejected:'control_id,execution_lease,observer_id,operation,reason_code,run_id,session_ref'};
  if(!body||typeof body.operation!=='string'||!Object.hasOwn(allowed,body.operation)||keys!==allowed[body.operation as keyof typeof allowed]||!['control_id','run_id','session_ref'].every(key=>typeof body[key]==='string'&&ID.test(body[key] as string)))return reply.code(422).send({error:{code:'GOAL_CONTROL_INPUT_INVALID'}});
  let lease;try{lease=normalizeExecutionLease(body.execution_lease);}catch{return reply.code(422).send({error:{code:'GOAL_CONTROL_INPUT_INVALID'}});}
  if(body.operation!=='inspect'&&(typeof body.observer_id!=='string'||!ID.test(body.observer_id)))return reply.code(422).send({error:{code:'GOAL_CONTROL_INPUT_INVALID'}});
  try{
   const controlId=body.control_id as string,control=controls.inspect(controlId,lease);
   if(control.run_id!==body.run_id||control.session_id!==body.session_ref)throw Error('goal_control_identity_invalid');
   if(body.operation==='begin')return {...controls.begin(controlId,lease,body.cursor as number,body.observer_id as string),control:controls.inspect(controlId,lease)};
   if(body.operation==='applied')controls.applied(controlId,lease,body.receipt,body.observer_id as string);
   if(body.operation==='rejected')controls.rejectBeforeNative(controlId,lease,body.reason_code as string,body.observer_id as string);
   return {control:controls.inspect(controlId,lease)};
  }catch{return reply.code(409).send({error:{code:'GOAL_CONTROL_REJECTED'}});}
 });
}
