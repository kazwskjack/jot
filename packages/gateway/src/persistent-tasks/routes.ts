import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PersistentTaskService } from './service.ts';
import type {TaskDelegationService} from '../workbench/task-delegation.ts';
import type {TaskCollaborationService} from '../workbench/task-collaboration.ts';
import * as AjvModule from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import * as AddFormatsModule from 'ajv-formats';

const Ajv=(AjvModule as unknown as {default:new(options:Record<string,unknown>)=>{compile(schema:unknown):ValidateFunction}}).default;
const ajv=new Ajv({strict:false,coerceTypes:false,removeAdditional:false});
const addFormats=(AddFormatsModule as unknown as {default:(instance:unknown)=>void}).default;
addFormats(ajv);
const validatorCompiler=({schema}:{schema:unknown})=>ajv.compile(schema);

const idSchema={type:'object',required:['taskId'],additionalProperties:false,properties:{taskId:{type:'string',minLength:1,maxLength:200}}};
const intervalSeconds={type:'integer',minimum:60,maximum:31536000};
const calendarFields={time:{type:'string',pattern:'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'},timezone:{type:'string',minLength:1,maxLength:100}};
const trigger={oneOf:[
  ...['conversation_message','conversation_result'].map(kind=>({type:'object',additionalProperties:false,required:['kind','conversation_id'],properties:{kind:{const:kind},conversation_id:{type:'string',minLength:1,maxLength:200}}})),
  {type:'object',additionalProperties:false,required:['kind'],properties:{kind:{const:'once'},run_at:{type:'string',format:'date-time'}}},
  {type:'object',additionalProperties:false,required:['kind'],properties:{kind:{const:'interval'},interval_seconds:intervalSeconds}},
  {type:'object',additionalProperties:false,required:['kind','url'],properties:{kind:{const:'page_change'},interval_seconds:intervalSeconds,url:{type:'string',minLength:1,maxLength:2048,pattern:'^https?://'}}},
  {type:'object',additionalProperties:false,required:['kind','time','timezone'],properties:{kind:{const:'daily'},...calendarFields}},
  {type:'object',additionalProperties:false,required:['kind','time','timezone','weekdays'],properties:{kind:{const:'weekly'},...calendarFields,weekdays:{type:'array',minItems:1,maxItems:7,uniqueItems:true,items:{type:'integer',minimum:0,maximum:6}}}},
]};
const fields={title:{type:'string',minLength:1,maxLength:200},agent_id:{type:'string',minLength:1,maxLength:200},objective:{type:'string',minLength:1,maxLength:12000},trigger,priority:{type:'integer',minimum:0,maximum:100},budget:{type:'object',additionalProperties:false,required:['max_runs'],properties:{max_runs:{type:['integer','null'],minimum:1,maximum:10000}}}};
const modelBudget={type:'object',additionalProperties:false,required:['tokens','nano_usd','model_calls'],properties:Object.fromEntries(['tokens','nano_usd','model_calls'].map(key=>[key,{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}]))};
function body(request: FastifyRequest) { return (request.body ?? {}) as Record<string,unknown>; }
function taskId(request: FastifyRequest) { return (request.params as {taskId:string}).taskId; }
function expected(request: FastifyRequest) {
  const value=body(request).expected_version;
  if(typeof value!=='number'||!Number.isInteger(value)||value<1)throw new Error('invalid_expected_version');return value;
}
function requestKey(request: FastifyRequest) {
  const key=request.headers['idempotency-key'] ?? body(request).client_message_id;
  if(typeof key!=='string'||!key.trim()||key.length>200)throw new Error('idempotency_key_required');return key;
}
export function registerPersistentTaskRoutes(app: FastifyInstance, service: PersistentTaskService, actor: (request: FastifyRequest)=>string,delegations:TaskDelegationService,collaboration:TaskCollaborationService) {
  app.get('/v1/persistent-tasks/:taskId/collaboration',async request=>collaboration.get(actor(request),taskId(request)));
  app.patch('/v1/persistent-tasks/:taskId/collaboration',async request=>collaboration.save(actor(request),taskId(request),body(request)));
  app.post('/v1/persistent-tasks/:taskId/delegations',{validatorCompiler,schema:{params:idSchema,body:{type:'object',additionalProperties:false,
    required:['occurrence_id','subtask_id','expected_subtask_version','recipient_agent_id','client_message_id'],properties:{
      ...Object.fromEntries(['occurrence_id','subtask_id','recipient_agent_id','client_message_id'].map(key=>[key,{type:'string',minLength:1,maxLength:200}])),
      expected_subtask_version:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER}}}}},async(request,reply)=>
      reply.code(201).send(delegations.delegate(actor(request),taskId(request),body(request) as Parameters<TaskDelegationService['delegate']>[2])));
  app.get('/v1/persistent-tasks',async request=>service.list(actor(request)));
  app.post('/v1/persistent-tasks/preview',{validatorCompiler,schema:{body:{type:'object',additionalProperties:false,required:['trigger'],properties:{trigger}}}},async request=>{
    actor(request);return service.previewTrigger(body(request).trigger);
  });
  app.post('/v1/persistent-tasks',{validatorCompiler,schema:{body:{type:'object',additionalProperties:false,required:['title','agent_id','objective','trigger'],properties:{...fields,model_budget:modelBudget,reply_policy:{type:'object'},notification_settings:{type:'object',additionalProperties:false,required:['channel_binding_ids'],properties:{channel_binding_ids:{type:'array',maxItems:5,uniqueItems:true,items:{type:'string',minLength:1,maxLength:128}},events:{type:'array',maxItems:4,uniqueItems:true,items:{type:'string',enum:['changed','completed','failed','needs_confirmation']}},delivery_policy:{type:'object'}}},source:{type:'object',additionalProperties:false,required:['conversation_id','message_id'],properties:{conversation_id:{type:'string',minLength:1,maxLength:200},message_id:{type:'string',minLength:1,maxLength:200}}}}}}},async(request,reply)=>{
    const key=request.headers['idempotency-key'];
    if(key!==undefined && typeof key!=='string')throw new Error('idempotency_key_required');
    return reply.code(201).send(service.create(actor(request),body(request),key));
  });
  app.get('/v1/persistent-tasks/:taskId',{validatorCompiler,schema:{params:idSchema}},async request=>service.get(actor(request),taskId(request)));
  app.patch('/v1/persistent-tasks/:taskId',{validatorCompiler,schema:{params:idSchema,body:{type:'object',additionalProperties:false,required:['expected_version'],properties:{...fields,expected_version:{type:'integer',minimum:1}}}}},async request=>{
    expected(request);return service.update(actor(request),taskId(request),body(request));
  });
  for(const action of ['pause','resume','archive'] as const)app.post(`/v1/persistent-tasks/:taskId/${action}`,{validatorCompiler,schema:{params:idSchema,body:{type:'object',additionalProperties:false,required:['expected_version'],properties:{expected_version:{type:'integer',minimum:1}}}}},async request=>service[action](actor(request),taskId(request),expected(request)));
  app.post('/v1/persistent-tasks/:taskId/run-now',{validatorCompiler,schema:{params:idSchema,body:{type:'object',additionalProperties:false,properties:{client_message_id:{type:'string',minLength:1,maxLength:200}}}}},async(request,reply)=>reply.code(202).send(service.runNow(actor(request),taskId(request),requestKey(request))));
  app.get('/v1/persistent-tasks/:taskId/occurrences',{validatorCompiler,schema:{params:idSchema}},async request=>service.occurrences(actor(request),taskId(request)));
  app.post('/v1/persistent-tasks/:taskId/occurrences/:occurrenceId/cancel',{validatorCompiler,schema:{params:{type:'object',additionalProperties:false,required:['taskId','occurrenceId'],properties:{taskId:{type:'string',minLength:1,maxLength:200},occurrenceId:{type:'string',minLength:1,maxLength:200}}},body:{type:'object',additionalProperties:false,required:['expected_run_version'],properties:{expected_run_version:{type:'integer',minimum:1},client_message_id:{type:'string',minLength:1,maxLength:200}}}}},async(request,reply)=>reply.code(202).send(service.cancelOccurrence(actor(request),taskId(request),(request.params as {occurrenceId:string}).occurrenceId,Number(body(request).expected_run_version),requestKey(request))));
  app.get('/v1/persistent-tasks/:taskId/subtasks',{validatorCompiler,schema:{params:idSchema,querystring:{type:'object',additionalProperties:false,properties:{occurrence_id:{type:'string',minLength:1,maxLength:200}}}}},async request=>service.subtasks(actor(request),taskId(request),(request.query as {occurrence_id?:string}).occurrence_id));
  app.get('/v1/persistent-tasks/:taskId/readiness',{validatorCompiler,schema:{params:idSchema,querystring:{type:'object',additionalProperties:false,properties:{}}}},async request=>service.readiness(actor(request),taskId(request)));
  app.post('/v1/persistent-tasks/:taskId/subtasks',{validatorCompiler,schema:{params:idSchema,body:{type:'object',additionalProperties:false,properties:{subtask_id:{type:'string',minLength:1,maxLength:200},expected_version:{type:'integer',minimum:1},title:fields.title,acceptance:{type:'string',minLength:1,maxLength:2000},priority:fields.priority,status:{type:'string',enum:['pending','running','blocked','completed','failed','cancelled']},dependencies:{type:'array',maxItems:50,items:{type:'string',minLength:1,maxLength:200}},evidence:{type:'array',maxItems:100,items:{type:'object',additionalProperties:false,required:['kind','reference'],properties:{kind:{type:'string',minLength:1,maxLength:60},reference:{type:'string',minLength:1,maxLength:2048},hash:{type:'string',minLength:1,maxLength:128}}}}}}}},async request=>service.upsertSubtask(actor(request),taskId(request),body(request)));
}
