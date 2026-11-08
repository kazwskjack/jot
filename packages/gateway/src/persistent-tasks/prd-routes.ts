import type {FastifyInstance,FastifyRequest,FastifyReply,FastifyError} from 'fastify';
import {randomUUID} from 'node:crypto';
import type {TaskPrdService} from './prd.ts';
import * as AjvModule from 'ajv/dist/2020.js';
import type {ValidateFunction} from 'ajv';
const Ajv=(AjvModule as unknown as {default:new(options:Record<string,unknown>)=>{compile(schema:unknown):ValidateFunction}}).default;
const ajv=new Ajv({strict:false,coerceTypes:false,removeAdditional:false});
const validatorCompiler=({schema}:{schema:unknown})=>ajv.compile(schema);
declare module 'fastify' {interface FastifyContextConfig {taskPrdCommand?:'preview'|'bind'|'template-preview'|'project-prd-preview'|'runtime-version'}}
export const prdSelectionSchema={oneOf:[
 {type:'object',additionalProperties:false,required:['kind','path','version','sha256'],properties:{kind:{const:'logical_file'},path:{type:'string',minLength:1,maxLength:1024},version:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}},
 {type:'object',additionalProperties:false,required:['kind','artifact_id','version','sha256'],properties:{kind:{const:'upload'},artifact_id:{type:'string',minLength:1,maxLength:200},version:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}},
]};
export const prdPreviewRequestSchema={type:'object',additionalProperties:false,required:['source'],properties:{source:prdSelectionSchema,research:{type:'boolean'},append:{type:'boolean'},num_tasks:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}}};
export const prdBindRequestSchema={type:'object',additionalProperties:false,required:['source','preview_sha256'],properties:{source:prdSelectionSchema,research:{type:'boolean'},append:{type:'boolean'},num_tasks:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},preview_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}};
export const prdTemplateRequestSchema={type:'object',additionalProperties:false,required:['template_id','file_name'],properties:{
 template_id:{type:'string',enum:['task-request','web-app','api','mobile-app','data-analysis']},file_name:{type:'string',minLength:1,maxLength:200},
 values:{type:'object',maxProperties:32,propertyNames:{minLength:1,maxLength:100},additionalProperties:{type:'string',maxLength:1048576}},
},if:{properties:{template_id:{const:'task-request'}}},then:{required:['values'],properties:{values:{additionalProperties:false,required:['任务提示词'],properties:{
 '任务提示词':{type:'string',minLength:1,maxLength:1048576},'优先级':{type:'string',enum:['high','medium','low']},'依赖原生ID':{type:'string',maxLength:10240},
}}}},else:{properties:{values:{additionalProperties:{type:'string',maxLength:2000}}}}};
export const prdTemplateApplySchema={...prdTemplateRequestSchema,required:['template_id','file_name','preview_sha256'],properties:{
 ...prdTemplateRequestSchema.properties,preview_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
}};
export const prdProjectDocumentRequestSchema={type:'object',additionalProperties:false,required:['file_name'],properties:{file_name:{type:'string',minLength:1,maxLength:255}}};
export const prdProjectDocumentImportSchema={...prdProjectDocumentRequestSchema,required:['file_name','preview_sha256'],properties:{
 ...prdProjectDocumentRequestSchema.properties,preview_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
}};
export const prdWorkPlanAcceptanceSchema={type:'object',additionalProperties:false,
 required:['plan_id','preview_sha256','expected_task_version','expected_role_version','expected_role_epoch'],properties:{
  plan_id:{type:'string',pattern:'^prd-plan-[a-f0-9]{64}$'},preview_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
  expected_task_version:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},
  expected_role_version:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},expected_role_epoch:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},
 }};
export const prdWorkCycleCommandSchema={oneOf:[
 {type:'object',additionalProperties:false,required:['action','plan_id','preview_sha256'],properties:{
  action:{const:'create'},plan_id:{type:'string',pattern:'^prd-plan-[a-f0-9]{64}$'},preview_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
 }},
 {type:'object',additionalProperties:false,required:['action','plan_id','preview_sha256','cycle_id','expected_version'],properties:{
  action:{const:'close'},plan_id:{type:'string',pattern:'^prd-plan-[a-f0-9]{64}$'},preview_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
  cycle_id:{type:'string',minLength:1,maxLength:256},expected_version:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},
 }},
]};
export const prdWorkHandoffRequestSchema={type:'object',additionalProperties:false,
 required:['plan_id','cycle_id','preview_sha256','run_id','expected_run_version'],properties:{
  plan_id:{type:'string',pattern:'^prd-plan-[a-f0-9]{64}$'},cycle_id:{type:'string',minLength:1,maxLength:256},
  preview_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},run_id:{type:'string',minLength:1,maxLength:200},
  expected_run_version:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},
 }};
export const prdWorkResourceRequestSchema={type:'object',additionalProperties:false,required:['plan_id','cycle_id','preview_sha256'],properties:{
 plan_id:{type:'string',pattern:'^prd-plan-[a-f0-9]{64}$'},cycle_id:{type:'string',minLength:1,maxLength:256},preview_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
}};
export const prdWorkPreparationRequestSchema={...prdWorkResourceRequestSchema,required:[...prdWorkResourceRequestSchema.required,'expected_cycle_version'],properties:{
 ...prdWorkResourceRequestSchema.properties,expected_cycle_version:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},
}};
export const prdWorkAdmissionRequestSchema={...prdWorkResourceRequestSchema,required:[...prdWorkResourceRequestSchema.required,'grant_id'],properties:{
 ...prdWorkResourceRequestSchema.properties,grant_id:{type:'string',minLength:1,maxLength:256},
}};
/** Outer server retains actor/origin/CSRF validation. taskPrdCommand routes must
 * bypass its generic ledger: preview is read-only; bind has an atomic receipt. */
export function registerTaskPrdRoutes(app:FastifyInstance,service:TaskPrdService,actor:(r:FastifyRequest)=>string,atomicCommand?:<T>(request:FastifyRequest,status:number,operation:()=>T)=>T){
 const task=(r:FastifyRequest)=>(r.params as {taskId:string}).taskId;
 const errorHandler=(error:FastifyError,r:FastifyRequest,reply:FastifyReply)=>{
  const code=error.validation?'invalid_workbench_request':error.message;
  const status=['prd_taskmaster_unavailable','prd_taskmaster_runtime_unavailable','prd_taskmaster_project_unavailable','prd_taskmaster_import_unavailable','prd_taskmaster_import_unconfirmed','prd_work_plan_integrity_failed','prd_append_source_integrity_failed','prd_work_plan_acceptance_integrity_failed','prd_work_plan_acceptance_unavailable','work_cycle_corrupt','prd_work_handoff_unavailable','prd_work_handoff_integrity_failed','prd_work_preparation_integrity_failed','prd_work_preparation_unavailable','prd_work_admission_unavailable','prd_work_admission_integrity_failed','work_admission_corrupt','work_grant_corrupt','workspace_journal_corrupt','work_cycle_source_corrupt'].includes(code)?503:code==='unauthorized'?401:['origin_forbidden','csrf_invalid'].includes(code)?403:['task_not_found','agent_not_found','prd_template_not_found','prd_work_plan_not_found','work_cycle_not_found'].includes(code)?404:
   code.startsWith('invalid_')||code==='work_cycle_invalid'||code==='contract_request_invalid'||code==='idempotency_key_required'||code==='idempotency_key_invalid'||code==='prd_source_unsupported'?422:
   code.startsWith('prd_')||code.startsWith('work_cycle_')||code.startsWith('work_grant_')||code.startsWith('workspace_journal_')||['version_conflict','idempotency_conflict','workspace_coordination_required'].includes(code)?409:500;
  const publicCode=status===500?'INTERNAL_ERROR':code.toUpperCase(),requestId=/^[A-Za-z0-9][A-Za-z0-9_:\-]{0,127}$/.test(r.id)?r.id:randomUUID();
  return reply.code(status).send({error:{code:publicCode,message:publicCode,retryable:status>=500},request_id:requestId});
 };
 const params={type:'object',additionalProperties:false,required:['taskId'],properties:{taskId:{type:'string',minLength:1,maxLength:200}}};
 app.get('/v1/persistent-tasks/:taskId/prd/work-plans',{validatorCompiler,errorHandler,schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before_id:{type:'string',minLength:1,maxLength:200}}}}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.workPlans(actor(r),task(r),(r.query as {before_id?:string}).before_id);
 });
 app.get('/v1/persistent-tasks/:taskId/prd/work-plans/:planId',{validatorCompiler,errorHandler,schema:{params:{...params,required:['taskId','planId'],properties:{...params.properties,planId:{type:'string',minLength:1,maxLength:200}}}}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.workPlan(actor(r),task(r),(r.params as {planId:string}).planId);
 });
 app.get('/v1/persistent-tasks/:taskId/prd/work-plans/:planId/acceptance',{validatorCompiler,errorHandler,schema:{params:{...params,required:['taskId','planId'],properties:{...params.properties,planId:{type:'string',pattern:'^prd-plan-[a-f0-9]{64}$'}}}}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.workPlanAcceptance(actor(r),task(r),(r.params as {planId:string}).planId);
 });
 app.post('/v1/persistent-tasks/:taskId/prd/work-plan-accept',{validatorCompiler,errorHandler,schema:{params,body:prdWorkPlanAcceptanceSchema}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');if(!atomicCommand)throw Error('prd_work_plan_acceptance_unavailable');
  return atomicCommand(r,200,()=>service.acceptWorkPlan(actor(r),task(r),r.body,r.headers['idempotency-key']));
 });
 app.get('/v1/persistent-tasks/:taskId/prd/work-plans/:planId/cycle',{validatorCompiler,errorHandler,schema:{params:{...params,required:['taskId','planId'],properties:{...params.properties,planId:{type:'string',pattern:'^prd-plan-[a-f0-9]{64}$'}}}}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.workPlanCycle(actor(r),task(r),(r.params as {planId:string}).planId);
 });
 app.post('/v1/persistent-tasks/:taskId/prd/work-plan-cycle',{validatorCompiler,errorHandler,schema:{params,body:prdWorkCycleCommandSchema}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');if(!atomicCommand)throw Error('prd_work_plan_acceptance_unavailable');
  return atomicCommand(r,200,()=>service.controlWorkPlanCycle(actor(r),task(r),r.body,r.headers['idempotency-key']));
 });
 app.get('/v1/persistent-tasks/:taskId/prd/work-plans/:planId/handoff',{validatorCompiler,errorHandler,schema:{params:{...params,required:['taskId','planId'],properties:{...params.properties,planId:{type:'string',pattern:'^prd-plan-[a-f0-9]{64}$'}}}}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.workPlanHandoff(actor(r),task(r),(r.params as {planId:string}).planId);
 });
 app.post('/v1/persistent-tasks/:taskId/prd/work-plan-handoff',{validatorCompiler,errorHandler,schema:{params,body:prdWorkHandoffRequestSchema}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');if(!atomicCommand)throw Error('prd_work_handoff_unavailable');
  return atomicCommand(r,200,()=>service.requestWorkPlanHandoff(actor(r),task(r),r.body));
 });
 app.get('/v1/persistent-tasks/:taskId/prd/work-plans/:planId/resources',{validatorCompiler,errorHandler,schema:{params:{...params,required:['taskId','planId'],properties:{...params.properties,planId:{type:'string',pattern:'^prd-plan-[a-f0-9]{64}$'}}}}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.workResources(actor(r),task(r),(r.params as {planId:string}).planId);
 });
 app.post('/v1/persistent-tasks/:taskId/prd/work-plan-prepare',{validatorCompiler,errorHandler,schema:{params,body:prdWorkPreparationRequestSchema}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');if(!atomicCommand)throw Error('prd_work_preparation_unavailable');
  const controller=new AbortController(),aborted=()=>controller.abort(),closed=()=>{if(!reply.raw.writableEnded)controller.abort();};
  r.raw.once('aborted',aborted);reply.raw.once('close',closed);if(r.raw.aborted||reply.raw.destroyed)controller.abort();
  try{const commit=await service.prepareWorkSnapshot(actor(r),task(r),r.body,r.headers['idempotency-key'],controller.signal);return atomicCommand(r,200,commit);}
  finally{r.raw.off('aborted',aborted);reply.raw.off('close',closed);}
 });
 app.post('/v1/persistent-tasks/:taskId/prd/work-plan-grant',{validatorCompiler,errorHandler,schema:{params,body:prdWorkResourceRequestSchema}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');if(!atomicCommand)throw Error('prd_work_preparation_unavailable');
  return atomicCommand(r,200,()=>service.authorizeWork(actor(r),task(r),r.body,r.headers['idempotency-key']));
 });
 app.get('/v1/persistent-tasks/:taskId/prd/work-plans/:planId/admission',{validatorCompiler,errorHandler,schema:{params:{...params,required:['taskId','planId'],properties:{...params.properties,planId:{type:'string',pattern:'^prd-plan-[a-f0-9]{64}$'}}}}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.workAdmission(actor(r),task(r),(r.params as {planId:string}).planId);
 });
 app.post('/v1/persistent-tasks/:taskId/prd/work-plan-admit',{validatorCompiler,errorHandler,schema:{params,body:prdWorkAdmissionRequestSchema}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');if(!atomicCommand)throw Error('prd_work_admission_unavailable');
  return atomicCommand(r,200,()=>service.requestWorkAdmission(actor(r),task(r),r.body,r.headers['idempotency-key']));
 });
 app.get('/v1/persistent-tasks/:taskId/prd/templates',{validatorCompiler,errorHandler,schema:{params}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.templates(actor(r),task(r));
 });
 app.post('/v1/persistent-tasks/:taskId/prd/template-preview',{validatorCompiler,errorHandler,config:{taskPrdCommand:'template-preview'},schema:{params,body:prdTemplateRequestSchema}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.templatePreview(actor(r),task(r),r.body);
 });
 app.post('/v1/persistent-tasks/:taskId/prd/template-apply',{validatorCompiler,errorHandler,schema:{params,body:prdTemplateApplySchema}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');if(!atomicCommand)throw Error('prd_taskmaster_import_unavailable');
  return atomicCommand(r,200,()=>service.applyTemplate(actor(r),task(r),r.body,r.headers['idempotency-key']));
 });
 app.get('/v1/persistent-tasks/:taskId/prd/sources',{validatorCompiler,errorHandler,schema:{params}},async r=>service.sources(actor(r),task(r)));
 app.get('/v1/persistent-tasks/:taskId/prd/taskmaster-installation',{validatorCompiler,errorHandler,schema:{params}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.taskmasterInstallation(actor(r),task(r));
 });
 app.post('/v1/persistent-tasks/:taskId/prd/taskmaster-runtime-version',{validatorCompiler,errorHandler,config:{taskPrdCommand:'runtime-version'},schema:{params,body:{type:'object',additionalProperties:false,required:['profile_id','manifest_sha256','cli_entry_sha256'],properties:{
  profile_id:{type:'string',pattern:'^dsh-profile-[a-f0-9]{48}$'},manifest_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},cli_entry_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
 }}}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');
  const controller=new AbortController(),aborted=()=>controller.abort(),closed=()=>{if(!reply.raw.writableEnded)controller.abort();};
  r.raw.once('aborted',aborted);reply.raw.once('close',closed);if(r.raw.aborted||reply.raw.destroyed)controller.abort();
  try{return await service.taskmasterRuntimeVersion(actor(r),task(r),r.body,controller.signal);}
  finally{r.raw.off('aborted',aborted);reply.raw.off('close',closed);}
 });
 app.get('/v1/persistent-tasks/:taskId/prd/taskmaster-project',{validatorCompiler,errorHandler,schema:{params}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.taskmasterProject(actor(r),task(r));
 });
 app.get('/v1/persistent-tasks/:taskId/prd/taskmaster-prd-files',{validatorCompiler,errorHandler,schema:{params,querystring:{type:'object',additionalProperties:false,properties:{after:{type:'string',minLength:1,maxLength:255}}}}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.taskmasterPrdFiles(actor(r),task(r),(r.query as {after?:string}).after);
 });
 app.post('/v1/persistent-tasks/:taskId/prd/taskmaster-prd-preview',{validatorCompiler,errorHandler,config:{taskPrdCommand:'project-prd-preview'},schema:{params,body:prdProjectDocumentRequestSchema}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');return service.taskmasterPrdPreview(actor(r),task(r),r.body);
 });
 app.post('/v1/persistent-tasks/:taskId/prd/taskmaster-prd-import',{validatorCompiler,errorHandler,schema:{params,body:prdProjectDocumentImportSchema}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');if(!atomicCommand)throw Error('prd_taskmaster_import_unavailable');
  const commit=await service.prepareTaskmasterPrdImport(actor(r),task(r),r.body,r.headers['idempotency-key']);
  return atomicCommand(r,200,commit);
 });
 app.post('/v1/persistent-tasks/:taskId/prd/taskmaster-import',{validatorCompiler,errorHandler,schema:{params,body:{type:'object',additionalProperties:false,required:['preview_sha256'],properties:{preview_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}}}},async(r,reply)=>{
  reply.header('cache-control','private, no-store');if(!atomicCommand)throw Error('prd_taskmaster_import_unavailable');
  const commit=await service.prepareTaskmasterImport(actor(r),task(r),r.body,r.headers['idempotency-key']);
  return atomicCommand(r,200,commit);
 });
 app.post('/v1/persistent-tasks/:taskId/prd/preview',{validatorCompiler,errorHandler,config:{taskPrdCommand:'preview'},schema:{params,body:prdPreviewRequestSchema}},async r=>service.preview(actor(r),task(r),r.body));
 app.post('/v1/persistent-tasks/:taskId/prd/bind',{validatorCompiler,errorHandler,config:{taskPrdCommand:'bind'},schema:{params,body:prdBindRequestSchema}},async r=>service.bind(actor(r),task(r),r.body,r.headers['idempotency-key']));
}
