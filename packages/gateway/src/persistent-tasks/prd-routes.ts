import type {FastifyInstance,FastifyRequest,FastifyReply,FastifyError} from 'fastify';
import {randomUUID} from 'node:crypto';
import type {TaskPrdService} from './prd.ts';
import * as AjvModule from 'ajv/dist/2020.js';
import type {ValidateFunction} from 'ajv';
const Ajv=(AjvModule as unknown as {default:new(options:Record<string,unknown>)=>{compile(schema:unknown):ValidateFunction}}).default;
const ajv=new Ajv({strict:false,coerceTypes:false,removeAdditional:false});
const validatorCompiler=({schema}:{schema:unknown})=>ajv.compile(schema);
declare module 'fastify' {interface FastifyContextConfig {taskPrdCommand?:'preview'|'bind'}}
export const prdSelectionSchema={oneOf:[
 {type:'object',additionalProperties:false,required:['kind','path','version','sha256'],properties:{kind:{const:'logical_file'},path:{type:'string',minLength:1,maxLength:1024},version:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}},
 {type:'object',additionalProperties:false,required:['kind','artifact_id','version','sha256'],properties:{kind:{const:'upload'},artifact_id:{type:'string',minLength:1,maxLength:200},version:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}},
]};
export const prdPreviewRequestSchema={type:'object',additionalProperties:false,required:['source'],properties:{source:prdSelectionSchema}};
export const prdBindRequestSchema={type:'object',additionalProperties:false,required:['source','preview_sha256'],properties:{source:prdSelectionSchema,preview_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}};
/** Outer server retains actor/origin/CSRF validation. taskPrdCommand routes must
 * bypass its generic ledger: preview is read-only; bind has an atomic receipt. */
export function registerTaskPrdRoutes(app:FastifyInstance,service:TaskPrdService,actor:(r:FastifyRequest)=>string){
 const task=(r:FastifyRequest)=>(r.params as {taskId:string}).taskId;
 const errorHandler=(error:FastifyError,r:FastifyRequest,reply:FastifyReply)=>{
  const code=error.validation?'invalid_workbench_request':error.message;
  const status=code==='unauthorized'?401:['origin_forbidden','csrf_invalid'].includes(code)?403:['task_not_found','agent_not_found'].includes(code)?404:
   code.startsWith('invalid_')||code==='contract_request_invalid'||code==='idempotency_key_required'||code==='prd_source_unsupported'?422:
   code.startsWith('prd_')||['version_conflict','idempotency_conflict'].includes(code)?409:500;
  const publicCode=status===500?'INTERNAL_ERROR':code.toUpperCase(),requestId=/^[A-Za-z0-9][A-Za-z0-9_:\-]{0,127}$/.test(r.id)?r.id:randomUUID();
  return reply.code(status).send({error:{code:publicCode,message:publicCode,retryable:status>=500},request_id:requestId});
 };
 const params={type:'object',additionalProperties:false,required:['taskId'],properties:{taskId:{type:'string',minLength:1,maxLength:200}}};
 app.get('/v1/persistent-tasks/:taskId/prd/sources',{validatorCompiler,errorHandler,schema:{params}},async r=>service.sources(actor(r),task(r)));
 app.post('/v1/persistent-tasks/:taskId/prd/preview',{validatorCompiler,errorHandler,config:{taskPrdCommand:'preview'},schema:{params,body:prdPreviewRequestSchema}},async r=>service.preview(actor(r),task(r),r.body));
 app.post('/v1/persistent-tasks/:taskId/prd/bind',{validatorCompiler,errorHandler,config:{taskPrdCommand:'bind'},schema:{params,body:prdBindRequestSchema}},async r=>service.bind(actor(r),task(r),r.body,r.headers['idempotency-key']));
}
