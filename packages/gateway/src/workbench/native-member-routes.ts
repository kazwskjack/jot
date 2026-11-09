import type {FastifyInstance} from 'fastify';
import {NativeMemberOwnerControls,type NativeMemberControlClient} from './native-member-owner-controls.ts';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
function actor(request:{headers:Record<string,unknown>}){
 const id=String(request.headers['x-user-id']??'');if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))throw Error('unauthorized');return id;
}
function params(request:{params:unknown}){
 const value=request.params as Record<string,unknown>;
 if(!value||typeof value.runId!=='string'||!ID.test(value.runId)||typeof value.childSessionRef!=='string'||!ID.test(value.childSessionRef))throw Error('invalid_native_member_message');
 return {runId:value.runId,childSessionRef:value.childSessionRef};
}
function runId(request:{params:unknown}){
 const value=request.params as Record<string,unknown>;
 if(!value||typeof value.runId!=='string'||!ID.test(value.runId))throw Error('invalid_native_member_message');
 return value.runId;
}
function failure(reply:{code(status:number):{send(value:unknown):unknown}},error:unknown){
 const code=(error as Error)?.message;
 if(code==='unauthorized')return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
 if(code==='invalid_native_member_message'||code==='invalid_native_member_interrupt'||code==='invalid_native_member_history')return reply.code(400).send({error:{code:'NATIVE_MEMBER_INPUT_INVALID'}});
 if(code==='conversation_not_found'||code==='run_not_found'||code==='native_member_not_found')return reply.code(404).send({error:{code:'NATIVE_MEMBER_NOT_FOUND'}});
 if(code==='run_state_conflict'||code==='run_version_conflict'||code==='idempotency_conflict')return reply.code(409).send({error:{code:'RUN_CONFLICT'}});
 if(code==='native_member_roster_invalid'||code==='native_member_interrupt_receipt_invalid'||code==='native_member_execution_invalid')return reply.code(502).send({error:{code:'NATIVE_MEMBER_RESPONSE_INVALID'}});
 return reply.code(503).send({error:{code:'NATIVE_MEMBER_UNAVAILABLE'}});
}

export function registerNativeMemberRoutes(app:FastifyInstance,controls:NativeMemberOwnerControls,client?:NativeMemberControlClient){
 app.get('/v1/conversations/:conversationId/native-member-runs',async(request,reply)=>{
  reply.header('cache-control','no-store');
  try{
   const value=request.params as Record<string,unknown>;
   if(typeof value.conversationId!=='string'||!ID.test(value.conversationId))throw Error('invalid_native_member_history');
   return controls.parentHistory(actor(request),value.conversationId,request.query as {cursor?:unknown;limit?:unknown});
  }catch(error){return failure(reply,error);}
 });
 app.get('/v1/runs/:runId/native-member-executions',async(request,reply)=>{
  reply.header('cache-control','no-store');
  try{return controls.executionHistory(actor(request),runId(request),request.query as {cursor?:unknown;limit?:unknown});}
  catch(error){return failure(reply,error);}
 });
 app.get('/v1/runs/:runId/native-members/:childSessionRef/execution',async(request,reply)=>{
  reply.header('cache-control','no-store');
  try{const scope=params(request),query=request.query as {child_run_id?:string};return controls.execution(actor(request),scope.runId,scope.childSessionRef,query.child_run_id);}
  catch(error){return failure(reply,error);}
 });
 app.get('/v1/runs/:runId/native-members',async(request,reply)=>{
  try{return await controls.list(actor(request),runId(request),client);}
  catch(error){return failure(reply,error);}
 });
 app.post('/v1/runs/:runId/native-members/:childSessionRef/interrupt',async(request,reply)=>{
  try{
   const {runId,childSessionRef}=params(request),body=request.body as Record<string,unknown>|undefined;
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='expected_run_version,request_id'
    ||typeof body.request_id!=='string'||!ID.test(body.request_id)||String(request.headers['idempotency-key']??'')!==body.request_id
    ||!Number.isSafeInteger(body.expected_run_version)||Number(body.expected_run_version)<1)throw Error('invalid_native_member_interrupt');
   return reply.code(202).send(await controls.interrupt(actor(request),runId,childSessionRef,body,body.request_id,client));
  }catch(error){return failure(reply,error);}
 });
 app.get('/v1/runs/:runId/native-members/:childSessionRef/interrupts/:requestId',async(request,reply)=>{
  try{
   const {runId,childSessionRef}=params(request),value=request.params as Record<string,unknown>,requestId=value.requestId;
   if(typeof requestId!=='string'||!ID.test(requestId))throw Error('invalid_native_member_interrupt');
   const receipt=controls.readInterrupt(actor(request),runId,childSessionRef,requestId);
   return receipt?reply.send(receipt):reply.code(404).send({error:{code:'NATIVE_MEMBER_NOT_FOUND'}});
  }catch(error){return failure(reply,error);}
 });
 app.post('/v1/runs/:runId/native-members/:childSessionRef/messages',async(request,reply)=>{
  try{
   const {runId,childSessionRef}=params(request),owner=actor(request),body=request.body as Record<string,unknown>|undefined;
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='expected_run_version,request_id,text'
    ||typeof body.request_id!=='string'||!ID.test(body.request_id)||String(request.headers['idempotency-key']??'')!==body.request_id
    ||!Number.isSafeInteger(body.expected_run_version)||Number(body.expected_run_version)<1||typeof body.text!=='string'||!body.text.trim()
    ||Buffer.byteLength(body.text,'utf8')>32768)throw Error('invalid_native_member_message');
   return reply.code(202).send(controls.wake(owner,runId,childSessionRef,body,body.request_id));
  }catch(error){return failure(reply,error);}
 });
 app.get('/v1/runs/:runId/native-members/:childSessionRef/messages/:requestId',async(request,reply)=>{
  const {runId,childSessionRef}=params(request),value=request.params as Record<string,unknown>,requestId=value.requestId;
  if(typeof requestId!=='string'||!ID.test(requestId))throw Error('invalid_native_member_message');
  const result=controls.read(actor(request),runId,childSessionRef,requestId);
  return result?reply.send(result):reply.code(404).send({error:{code:'RUN_NOT_FOUND'}});
 });
}
