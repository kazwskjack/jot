import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WorkbenchService } from './service.ts';
import type { WorkspaceCheckpointService } from './workspace-checkpoints.ts';
type Input = Record<string, unknown>;
type Actor = (request: FastifyRequest) => string;
function object(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_workbench_request');
  return value as Input;
}
function body(request: FastifyRequest, allowed: string[]): Input {
  const input = object(request.body);
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('invalid_workbench_request');
  return input;
}
function param(request: FastifyRequest, key: string): string {
  const value = object(request.params)[key];
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('invalid_workbench_request');
  return value;
}
function query(request: FastifyRequest): Input { return object(request.query); }
function version(input: Input): number {
  if (!Number.isSafeInteger(input.expected_version) || Number(input.expected_version) < 1) throw new Error('invalid_expected_version');
  return Number(input.expected_version);
}
function fileLifecyclePreviewQuery(request:FastifyRequest,action:'rename'|'delete'):Input{
  const input=query(request),allowed=action==='rename'?['project_id','path','target_path','expected_version']:['project_id','path','expected_version'];
  if(Object.keys(input).some(key=>!allowed.includes(key))||typeof input.project_id!=='string'||!input.project_id||input.project_id.length>128||
    typeof input.path!=='string'||typeof input.expected_version!=='string'||!/^[1-9][0-9]{0,15}$/.test(input.expected_version)||!Number.isSafeInteger(Number(input.expected_version))||
    action==='rename'&&(typeof input.target_path!=='string'||!input.target_path))throw new Error('invalid_file_lifecycle_request');
  return {...input,expected_version:Number(input.expected_version)};
}
function fileLifecycleRouteError(reply:{code:(status:number)=>{send:(body:unknown)=>unknown}},error:unknown):unknown{
  const code=error instanceof Error?error.message:'';
  if(code==='file_lifecycle_receipt_unavailable')return reply.code(503).send({error:{code:'FILE_LIFECYCLE_RECEIPT_UNAVAILABLE'}});
  if(code==='invalid_file_lifecycle_request'||code==='file_lifecycle_command_key_invalid'||code.startsWith('invalid_file_'))return reply.code(422).send({error:{code:code.toUpperCase()}});
  if(code.endsWith('_not_found'))return reply.code(404).send({error:{code:code.toUpperCase()}});
  if(['file_target_exists','file_integrity_failed','file_lifecycle_preview_conflict','workspace_project_busy','version_conflict','idempotency_conflict'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
  throw error;
}
const binaryFileLimit=104_857_600;
async function binaryFileBody(value:unknown):Promise<Buffer>{
  if(Buffer.isBuffer(value)||value instanceof Uint8Array){const bytes=Buffer.from(value);if(bytes.byteLength>binaryFileLimit)throw new Error('invalid_binary_file_content');return bytes;}
  if(!value||typeof value!=='object'||typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator]!=='function')throw new Error('invalid_binary_file_content');
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of value as AsyncIterable<Uint8Array>){
    if(!(chunk instanceof Uint8Array))throw new Error('invalid_binary_file_content');
    size+=chunk.byteLength;if(size>binaryFileLimit)throw new Error('invalid_binary_file_content');chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks,size);
}
function binaryFileRouteError(reply:{code:(status:number)=>{send:(body:unknown)=>unknown}},error:unknown):unknown{
  const code=error instanceof Error?error.message:'';
  if(['invalid_binary_file_content','invalid_binary_file_read','invalid_file_path','invalid_project_id','invalid_expected_version','file_lifecycle_command_key_invalid'].includes(code))return reply.code(422).send({error:{code:code.toUpperCase()}});
  if(code.endsWith('_not_found'))return reply.code(404).send({error:{code:code.toUpperCase()}});
  if(['version_conflict','idempotency_conflict','file_source_stale','file_integrity_failed','workspace_coordination_required'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
  if(code==='file_lifecycle_receipt_corrupt')return reply.code(503).send({error:{code:'FILE_BINARY_IMPORT_RECEIPT_CORRUPT'}});
  throw error;
}
function memoryImportPage(request:FastifyRequest){
 const input=query(request),keys=Object.keys(input);if(!keys.length)return undefined;
 if(keys.some(key=>!['offset','limit'].includes(key))||typeof input.offset!=='string'||! /^(?:0|[1-9][0-9]{0,15})$/.test(input.offset)
  ||typeof input.limit!=='string'||! /^(?:[1-9][0-9]?|100)$/.test(input.limit)||!Number.isSafeInteger(Number(input.offset)))throw Error('invalid_memory_import');
 return {offset:Number(input.offset),limit:Number(input.limit)};
}
const agentFields = ['name', 'instructions', 'workspace_id', 'project_id', 'allowed_tools'];
const teamFields = ['name', 'workspace_id', 'project_id', 'member_ids'];
export function registerWorkbenchRoutes(app: FastifyInstance, service: WorkbenchService, actor: Actor,restoreCommand:(request:FastifyRequest,operation:()=>unknown)=>unknown=(_request,operation)=>operation(),checkpoints?:WorkspaceCheckpointService): void {
  const checkpointService=()=>{if(!checkpoints)throw new Error('workspace_checkpoint_service_unavailable');return checkpoints;};
  const privateReply=(reply:{header:(name:string,value:string)=>unknown})=>reply.header('cache-control','private, no-store');
  app.get('/v1/agents', async request => service.listAgents(actor(request)));
  app.post('/v1/agents', async (request, reply) => reply.code(201).send(service.createAgent(actor(request), body(request, agentFields))));
  app.get('/v1/agents/:agentId', async request => service.getAgent(actor(request), param(request, 'agentId')));
  app.get('/v1/agents/:agentId/memory-capture-policy',async request=>service.memoryCapture.policy(actor(request),param(request,'agentId')));
  app.patch('/v1/agents/:agentId/memory-capture-policy',async request=>restoreCommand(request,()=>service.memoryCapture.setPolicy(actor(request),param(request,'agentId'),body(request,['expected_version','mode','include_assistant','include_automation']))));
  app.get('/v1/agents/:agentId/memory-dream-policy',async request=>service.memoryDreamPolicy(actor(request),param(request,'agentId')));
  app.patch('/v1/agents/:agentId/memory-dream-policy',async request=>restoreCommand(request,()=>service.setMemoryDreamPolicy(actor(request),param(request,'agentId'),body(request,['expected_version','enabled','interval_seconds']))));
  app.post('/v1/agents/:agentId/memory-capture-policy/collect',async request=>restoreCommand(request,()=>{body(request,[]);return service.memoryCapture.collect(actor(request),param(request,'agentId'));}));
  app.get('/v1/agents/:agentId/memory-captures',async request=>{const input=query(request);if(Object.keys(input).some(key=>key!=='before_id')||(input.before_id!==undefined&&(typeof input.before_id!=='string'||!input.before_id||input.before_id.length>128)))throw new Error('invalid_memory_capture');return service.memoryCapture.list(actor(request),param(request,'agentId'),input.before_id as string|undefined);});
  app.get('/v1/agents/:agentId/memory-captures/:captureId',async request=>{if(Object.keys(query(request)).length)throw new Error('invalid_memory_capture');return service.memoryCapture.get(actor(request),param(request,'agentId'),param(request,'captureId'));});
  app.get('/v1/agents/:agentId/memory-captures/:captureId/recovery',async(request,reply)=>{privateReply(reply);if(Object.keys(query(request)).length)throw new Error('invalid_memory_capture');return service.memoryCapture.recovery(actor(request),param(request,'agentId'),param(request,'captureId'));});
  app.post('/v1/agents/:agentId/memory-captures/:captureId/reconcile',async request=>restoreCommand(request,()=>service.memoryCapture.reconcile(actor(request),param(request,'agentId'),param(request,'captureId'),body(request,['expected_capture_version','expected_policy_version','expected_epoch','attempt_id','evidence_ref']))));
  for(const action of ['apply','reject'] as const)app.post(`/v1/agents/:agentId/memory-captures/:captureId/${action}`,async request=>restoreCommand(request,()=>service.memoryCapture[action](actor(request),param(request,'agentId'),param(request,'captureId'),version(body(request,['expected_version'])))));
  app.patch('/v1/agents/:agentId', async request => service.updateAgent(actor(request), param(request, 'agentId'), body(request, [...agentFields, 'expected_version', 'status'])));
  app.get('/v1/agents/:agentId/deletion-preview', async request => service.deletionPreview(actor(request), param(request, 'agentId')));
  app.delete('/v1/agents/:agentId', async request => service.deleteAgent(actor(request), param(request, 'agentId'), version(body(request, ['expected_version']))));
  app.post('/v1/agents/:agentId/messages', async (request, reply) => {
    const commit=await service.prepareAgentMessage(actor(request),param(request,'agentId'),body(request,['text','client_message_id']));
    return reply.code(202).send(commit());
  });
  app.get('/v1/teams', async request => service.listTeams(actor(request)));
  app.post('/v1/teams', async (request, reply) => reply.code(201).send(service.createTeam(actor(request), body(request, teamFields))));
  app.get('/v1/teams/:teamId', async request => service.getTeam(actor(request), param(request, 'teamId')));
  app.patch('/v1/teams/:teamId', async request => service.updateTeam(actor(request), param(request, 'teamId'), body(request, ['name', 'member_ids', 'expected_version'])));
  app.delete('/v1/teams/:teamId', async request => service.deleteTeam(actor(request), param(request, 'teamId'), version(body(request, ['expected_version']))));
  app.get('/v1/workspaces/:workspaceId', async request => service.getWorkspace(actor(request), param(request, 'workspaceId')));
  app.get('/v1/workspaces/:workspaceId/agent-messages', async request => {
    const input=query(request);
    if(Object.keys(input).some(key=>key!=='occurrence_id') || (input.occurrence_id!==undefined&&typeof input.occurrence_id!=='string'))throw new Error('invalid_workbench_request');
    return service.listMessages(actor(request),param(request,'workspaceId'),undefined,input.occurrence_id as string|undefined);
  });
  app.post('/v1/workspaces/:workspaceId/agent-messages', async (request, reply) => reply.code(201).send(service.sendMessage(actor(request), param(request, 'workspaceId'), body(request, ['sender_agent_id', 'recipient_agent_id', 'text', 'client_message_id', 'auto_reply', 'max_replies', 'task_run_id']))));
  app.get('/v1/workspaces/:workspaceId/memory-retrievals',async request=>{
    const input=query(request);
    if(Object.keys(input).some(key=>!['agent_id','before_id'].includes(key))||typeof input.agent_id!=='string'||!input.agent_id||input.agent_id.length>128||(input.before_id!==undefined&&(typeof input.before_id!=='string'||!input.before_id||input.before_id.length>128)))throw new Error('invalid_memory_retrieval_query');
    return service.memoryRetrievals.list(actor(request),param(request,'workspaceId'),input.agent_id,input.before_id as string|undefined);
  });
  app.get('/v1/workspaces/:workspaceId/memory-retrievals/:retrievalId',async request=>{
    if(Object.keys(query(request)).length)throw new Error('invalid_memory_retrieval_query');
    return service.memoryRetrievals.get(actor(request),param(request,'workspaceId'),param(request,'retrievalId'));
  });
  app.get('/v1/workspaces/:workspaceId/memory-consolidations',async request=>{
    const input=query(request);if(Object.keys(input).some(key=>!['project_id','scope','agent_id'].includes(key)))throw new Error('invalid_memory_consolidation');
    return service.memoryConsolidations.list(actor(request),param(request,'workspaceId'),input);
  });
  app.post('/v1/workspaces/:workspaceId/memory-consolidations',async request=>restoreCommand(request,()=>service.memoryConsolidations.stage(actor(request),param(request,'workspaceId'),body(request,['project_id','scope','agent_id','memory_ids']))));
  app.get('/v1/workspaces/:workspaceId/memory-consolidations/:consolidationId',async request=>service.memoryConsolidations.get(actor(request),param(request,'workspaceId'),param(request,'consolidationId')));
  app.post('/v1/workspaces/:workspaceId/memory-consolidations/:consolidationId/propose',async request=>restoreCommand(request,()=>service.memoryConsolidations.propose(actor(request),param(request,'workspaceId'),param(request,'consolidationId'),body(request,['expected_version','summary','changes']))));
  for(const action of ['apply','rollback','reject'] as const)app.post(`/v1/workspaces/:workspaceId/memory-consolidations/:consolidationId/${action}`,async request=>restoreCommand(request,()=>service.memoryConsolidations[action](actor(request),param(request,'workspaceId'),param(request,'consolidationId'),version(body(request,['expected_version'])))));
  app.post('/v1/workspaces/:workspaceId/memory/import/preview',{bodyLimit:20_100_000},async(request,reply)=>{privateReply(reply);return restoreCommand(request,()=>service.memoryImports.preview(actor(request),param(request,'workspaceId'),body(request,['import_id','document','target','mode']),memoryImportPage(request)));});
  app.get('/v1/workspaces/:workspaceId/memory/import/:importId',async(request,reply)=>{
    privateReply(reply);
    return service.memoryImports.get(actor(request),param(request,'workspaceId'),param(request,'importId'),memoryImportPage(request));
  });
  app.get('/v1/workspaces/:workspaceId/memory/import/:importId/replacement/:memoryId',async(request,reply)=>{
    privateReply(reply);const input=query(request);
    if(Object.keys(input).join(',')!=='preview_version'||typeof input.preview_version!=='string'||!/^[1-9][0-9]{0,15}$/.test(input.preview_version))throw Error('invalid_memory_import');
    return service.memoryImports.replacementSource(actor(request),param(request,'workspaceId'),param(request,'importId'),param(request,'memoryId'),Number(input.preview_version));
  });
  app.get('/v1/workspaces/:workspaceId/memory/import/:importId/source/history',async(request,reply)=>{
    privateReply(reply);const input=query(request);
    if(Object.keys(input).some(key=>!['section','offset','limit'].includes(key))
      ||!['metadata','case','index','dream'].includes(String(input.section))||typeof input.section!=='string'
      ||input.offset!==undefined&&(typeof input.offset!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(input.offset))
      ||input.limit!==undefined&&(typeof input.limit!=='string'||!/^[1-9][0-9]{0,4}$/.test(input.limit)))throw Error('invalid_memory_import');
    return service.memoryImports.source(actor(request),param(request,'workspaceId'),param(request,'importId'),{
      section:input.section as 'metadata'|'case'|'index'|'dream',offset:Number(input.offset??0),limit:Number(input.limit??4096)});
  });
  app.get('/v1/workspaces/:workspaceId/memory/import/:importId/source',async(request,reply)=>{
    privateReply(reply);if(Object.keys(query(request)).length)throw Error('invalid_memory_import');
    return service.memoryImports.source(actor(request),param(request,'workspaceId'),param(request,'importId'));
  });
  app.post('/v1/workspaces/:workspaceId/memory/import/:importId/apply',async(request,reply)=>{privateReply(reply);return restoreCommand(request,()=>service.memoryImports.apply(actor(request),param(request,'workspaceId'),{...body(request,['expected_version']),import_id:param(request,'importId')},memoryImportPage(request)));});
  app.get('/v1/workspaces/:workspaceId/memory', async request => service.listMemory(actor(request), param(request, 'workspaceId'), query(request)));
  app.get('/v1/workspaces/:workspaceId/memory/export', async request => service.exportMemory(actor(request), param(request, 'workspaceId'), query(request)));
  app.get('/v1/workspaces/:workspaceId/memory/:memoryId/history',async request=>{
    const input=query(request);
    if(Object.keys(input).some(key=>key!=='before_version'))throw new Error('invalid_workbench_request');
    if(input.before_version!==undefined&&(typeof input.before_version!=='string'||!/^[1-9][0-9]{0,15}$/.test(input.before_version)||!Number.isSafeInteger(Number(input.before_version))))throw new Error('invalid_memory_history_cursor');
    return service.memoryHistory(actor(request),param(request,'workspaceId'),param(request,'memoryId'),input.before_version===undefined?undefined:Number(input.before_version));
  });
  app.post('/v1/workspaces/:workspaceId/memory/:memoryId/restore',async request=>restoreCommand(request,()=>service.restoreMemory(actor(request),param(request,'workspaceId'),param(request,'memoryId'),body(request,['expected_version','source_version']))));
  app.post('/v1/workspaces/:workspaceId/memory', async (request, reply) => reply.code(201).send(service.saveMemory(actor(request), param(request, 'workspaceId'), body(request, ['scope', 'agent_id', 'project_id', 'content', 'verified', 'memory_id', 'expected_version', 'provenance', 'source_revision', 'expires_at', 'supersedes']))));
  app.delete('/v1/workspaces/:workspaceId/memory/:memoryId', async request => service.deleteMemory(actor(request), param(request, 'workspaceId'), param(request, 'memoryId'), version(body(request, ['expected_version']))));
  app.get('/v1/workspaces/:workspaceId/files', async request => {
    const input=query(request),project = input.project_id;
    if (typeof project !== 'string') throw new Error('invalid_project_id');
    if(Object.keys(input).some(key=>!['project_id','limit','cursor'].includes(key))||
      (input.limit!==undefined&&(typeof input.limit!=='string'||!/^(?:[1-9][0-9]?|1[0-9]{2}|200)$/.test(input.limit)))||
      (input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor||input.cursor.length>2048)))throw new Error('invalid_file_list_query');
    return service.listFiles(actor(request), param(request, 'workspaceId'), project,undefined,{...(input.limit===undefined?{}:{limit:Number(input.limit)}),...(input.cursor===undefined?{}:{cursor:input.cursor as string})});
  });
  app.get('/v1/workspaces/:workspaceId/files/lifecycle-history',async(request,reply)=>{
    privateReply(reply);try{
      const input=query(request);
      if(Object.keys(input).some(key=>!['project_id','limit','cursor'].includes(key))||typeof input.project_id!=='string'||!input.project_id||input.project_id.length>128||
        (input.limit!==undefined&&(typeof input.limit!=='string'||! /^(?:[1-9][0-9]?|100)$/.test(input.limit)))||
        (input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor||input.cursor.length>2048)))throw new Error('invalid_file_lifecycle_history_query');
      return service.listFileLifecycleHistory(actor(request),param(request,'workspaceId'),{project_id:input.project_id,
        ...(input.limit===undefined?{}:{limit:Number(input.limit)}),...(input.cursor===undefined?{}:{cursor:input.cursor})});
    }catch(error){return fileLifecycleRouteError(reply,error);}
  });
  app.get('/v1/workspaces/:workspaceId/files/content', async request => {
    const input = query(request);
    if(Object.keys(input).some(key=>!['project_id','path','version','sha256','offset_bytes','limit_bytes'].includes(key)))throw new Error('invalid_workbench_request');
    if (typeof input.project_id !== 'string' || typeof input.path !== 'string') throw new Error('invalid_file_path');
    const rangeRequested=input.offset_bytes!==undefined||input.limit_bytes!==undefined;
    if(!rangeRequested&&input.sha256!==undefined)throw new Error('invalid_file_range');
    if(input.version!==undefined){
      if(typeof input.version!=='string'||! /^[1-9][0-9]{0,15}$/.test(input.version)||!Number.isSafeInteger(Number(input.version)))throw new Error('invalid_file_version');
    }
    if(rangeRequested){
      if(input.offset_bytes===undefined||input.limit_bytes===undefined||input.version===undefined||typeof input.sha256!=='string'
        ||!/^[a-f0-9]{64}$/.test(input.sha256)
        ||typeof input.offset_bytes!=='string'||! /^(?:0|[1-9][0-9]{0,15})$/.test(input.offset_bytes)||!Number.isSafeInteger(Number(input.offset_bytes))
        ||typeof input.limit_bytes!=='string'||! /^[1-9][0-9]{0,4}$/.test(input.limit_bytes)||!Number.isSafeInteger(Number(input.limit_bytes))||Number(input.limit_bytes)>65_536)throw new Error('invalid_file_range');
      return {workspace_id:param(request,'workspaceId'),project_id:input.project_id,...service.readFileVersionRange(actor(request),param(request,'workspaceId'),input.project_id,input.path,Number(input.version),input.sha256,Number(input.offset_bytes),Number(input.limit_bytes))};
    }
    if(input.version!==undefined){
      const {created_at,...file}=service.readFileVersion(actor(request),param(request,'workspaceId'),input.project_id,input.path,Number(input.version));
      return {...file,updated_at:created_at};
    }
    return service.readFile(actor(request), param(request, 'workspaceId'), input.project_id, input.path);
  });
  app.get('/v1/workspaces/:workspaceId/files/binary',async(request,reply)=>{
    privateReply(reply);try{
      const input=query(request);
      if(Object.keys(input).some(key=>!['project_id','path','version','sha256'].includes(key))
        ||typeof input.project_id!=='string'||!input.project_id||input.project_id.length>128||typeof input.path!=='string'
        ||typeof input.version!=='string'||! /^[1-9][0-9]{0,15}$/.test(input.version)||!Number.isSafeInteger(Number(input.version))
        ||typeof input.sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.sha256))throw new Error('invalid_binary_file_read');
      const file=service.readBinaryFile(actor(request),param(request,'workspaceId'),input.project_id,input.path,Number(input.version),input.sha256);
      return reply.type('application/octet-stream').header('x-workspace-file-sha256',file.sha256).header('x-workspace-file-size',String(file.size)).send(file.content);
    }catch(error){return binaryFileRouteError(reply,error);}
  });
  app.get('/v1/workspaces/:workspaceId/files/versions', async request => {
    const input=query(request);
    if(Object.keys(input).some(key=>!['project_id','path','before_version','limit'].includes(key))
      ||typeof input.project_id!=='string'||typeof input.path!=='string')throw new Error('invalid_file_history_query');
    let beforeVersion:number|undefined;
    if(input.before_version!==undefined){
      if(typeof input.before_version!=='string'||! /^[1-9][0-9]{0,15}$/.test(input.before_version)||!Number.isSafeInteger(Number(input.before_version)))throw new Error('invalid_file_history_cursor');
      beforeVersion=Number(input.before_version);
    }
    let limit=50;
    if(input.limit!==undefined){
      if(typeof input.limit!=='string'||! /^(?:[1-9][0-9]?|100)$/.test(input.limit)||!Number.isSafeInteger(Number(input.limit)))throw new Error('invalid_file_history_query');
      limit=Number(input.limit);
    }
    return service.listFileVersions(actor(request),param(request,'workspaceId'),input.project_id,input.path,beforeVersion,limit);
  });
  app.put('/v1/workspaces/:workspaceId/files', async request => service.writeFile(actor(request), param(request, 'workspaceId'), body(request, ['project_id', 'path', 'content', 'expected_version'])));
  app.put('/v1/workspaces/:workspaceId/files/binary',{bodyLimit:binaryFileLimit},async(request,reply)=>{
    privateReply(reply);try{
      const input=query(request);
      if(Object.keys(input).some(key=>!['project_id','path','expected_version'].includes(key))||typeof input.project_id!=='string'||!input.project_id||input.project_id.length>128
        ||typeof input.path!=='string'||typeof input.expected_version!=='string'||! /^(?:0|[1-9][0-9]{0,15})$/.test(input.expected_version)||!Number.isSafeInteger(Number(input.expected_version)))
        throw new Error('invalid_binary_file_read');
      if(String(request.headers['content-type']??'').split(';',1)[0]?.trim().toLowerCase()!=='application/octet-stream')throw new Error('invalid_binary_file_content');
      const content=await binaryFileBody(request.body),receipt=service.writeBinaryFile(actor(request),param(request,'workspaceId'),{
        project_id:input.project_id,path:input.path,expected_version:Number(input.expected_version),command_key:request.headers['idempotency-key'],
      },content);
      return reply.code(200).send(receipt);
    }catch(error){return binaryFileRouteError(reply,error);}
  });
  app.get('/v1/workspaces/:workspaceId/files/rename-preview',async(request,reply)=>{
    privateReply(reply);try{return service.previewFileRename(actor(request),param(request,'workspaceId'),fileLifecyclePreviewQuery(request,'rename'));}
    catch(error){return fileLifecycleRouteError(reply,error);}
  });
  app.get('/v1/workspaces/:workspaceId/files/delete-preview',async(request,reply)=>{
    privateReply(reply);try{return service.previewFileDelete(actor(request),param(request,'workspaceId'),fileLifecyclePreviewQuery(request,'delete'));}
    catch(error){return fileLifecycleRouteError(reply,error);}
  });
  for(const action of ['rename','delete'] as const)app.post(`/v1/workspaces/:workspaceId/files/${action}`,async(request,reply)=>{
    privateReply(reply);try{
      const allowed=action==='rename'?['project_id','path','target_path','expected_version','preview_sha256']:['project_id','path','expected_version','preview_sha256'];
      const input=body(request,allowed),command_key=String(request.headers['idempotency-key']??'');
      return await restoreCommand(request,()=>action==='rename'
        ?service.applyFileRename(actor(request),param(request,'workspaceId'),{...input,command_key})
        :service.applyFileDelete(actor(request),param(request,'workspaceId'),{...input,command_key}));
    }catch(error){return fileLifecycleRouteError(reply,error);}
  });
  app.get('/v1/workspaces/:workspaceId/files/lifecycle-commands/:commandKey',async(request,reply)=>{
    privateReply(reply);try{
      const input=query(request);if(Object.keys(input).some(key=>key!=='project_id')||typeof input.project_id!=='string'||!input.project_id)throw new Error('invalid_file_lifecycle_request');
      return service.reconcileFileLifecycle(actor(request),param(request,'workspaceId'),{project_id:input.project_id,command_key:param(request,'commandKey')});
    }catch(error){return fileLifecycleRouteError(reply,error);}
  });
  app.get('/v1/workspaces/:workspaceId/checkpoints',async(request,reply)=>{
    privateReply(reply);const input=query(request);
    if(Object.keys(input).some(key=>!['project_id','limit','before_checkpoint_id'].includes(key))||typeof input.project_id!=='string'||!input.project_id||input.project_id.length>128||input.limit!==undefined&&(typeof input.limit!=='string'||!/^(?:[1-9][0-9]?|100)$/.test(input.limit))||input.before_checkpoint_id!==undefined&&(typeof input.before_checkpoint_id!=='string'||!input.before_checkpoint_id||input.before_checkpoint_id.length>200))throw new Error('workspace_checkpoint_list_invalid');
    return checkpointService().list(actor(request),param(request,'workspaceId'),input.project_id,{...(input.limit===undefined?{}:{limit:Number(input.limit)}),...(input.before_checkpoint_id===undefined?{}:{before_checkpoint_id:input.before_checkpoint_id})});
  });
  app.post('/v1/workspaces/:workspaceId/checkpoints',async(request,reply)=>{
    privateReply(reply);const input=body(request,['project_id','paths']);
    return reply.code(201).send(await checkpointService().create(actor(request),param(request,'workspaceId'),{...input,command_key:String(request.headers['idempotency-key']??'')}));
  });
  app.get('/v1/workspaces/:workspaceId/checkpoints/:checkpointId',async(request,reply)=>{
    privateReply(reply);const input=query(request);if(Object.keys(input).some(key=>key!=='project_id'))throw new Error('workspace_checkpoint_get_invalid');
    if(typeof input.project_id!=='string')throw new Error('workspace_checkpoint_get_invalid');
    return checkpointService().get(actor(request),param(request,'workspaceId'),input.project_id,param(request,'checkpointId'));
  });
  app.post('/v1/workspaces/:workspaceId/checkpoints/:checkpointId/restore-review',async(request,reply)=>{
    privateReply(reply);const input=body(request,['project_id','path']);
    return reply.code(201).send(await checkpointService().reviewRestore(actor(request),param(request,'workspaceId'),{...input,checkpoint_id:param(request,'checkpointId'),command_key:String(request.headers['idempotency-key']??'')}));
  });
  app.post('/v1/workspaces/:workspaceId/checkpoints/:checkpointId/restore',async(request,reply)=>{
    privateReply(reply);const input=body(request,['project_id','path','review_id','review_sha256']);
    return checkpointService().restore(actor(request),param(request,'workspaceId'),{...input,checkpoint_id:param(request,'checkpointId'),command_key:String(request.headers['idempotency-key']??'')});
  });
  app.get('/v1/workspaces/:workspaceId/checkpoints/:checkpointId/restore-requests/:commandKey',async(request,reply)=>{
    privateReply(reply);return checkpointService().restoreRequestStatus(actor(request),param(request,'workspaceId'),param(request,'checkpointId'),param(request,'commandKey'),query(request));
  });
  app.get('/v1/workspaces/:workspaceId/checkpoint-restores/:operationId',async(request,reply)=>{
    privateReply(reply);const input=query(request);
    if(Object.keys(input).some(key=>key!=='project_id')||typeof input.project_id!=='string')throw new Error('workspace_checkpoint_restore_status_invalid');
    return checkpointService().restoreStatus(actor(request),param(request,'workspaceId'),input.project_id,param(request,'operationId'));
  });
  app.post('/v1/workspaces/:workspaceId/checkpoint-restores/:operationId/reconcile',async(request,reply)=>{
    privateReply(reply);const input=body(request,['project_id']);
    if(typeof input.project_id!=='string')throw new Error('workspace_checkpoint_restore_status_invalid');
    return checkpointService().reconcileRestore(actor(request),param(request,'workspaceId'),input.project_id,param(request,'operationId'));
  });
}
