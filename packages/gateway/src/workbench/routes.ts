import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WorkbenchService } from './service.ts';
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
const agentFields = ['name', 'instructions', 'workspace_id', 'project_id', 'allowed_tools'];
const teamFields = ['name', 'workspace_id', 'project_id', 'member_ids'];
export function registerWorkbenchRoutes(app: FastifyInstance, service: WorkbenchService, actor: Actor): void {
  app.get('/v1/agents', async request => service.listAgents(actor(request)));
  app.post('/v1/agents', async (request, reply) => reply.code(201).send(service.createAgent(actor(request), body(request, agentFields))));
  app.get('/v1/agents/:agentId', async request => service.getAgent(actor(request), param(request, 'agentId')));
  app.patch('/v1/agents/:agentId', async request => service.updateAgent(actor(request), param(request, 'agentId'), body(request, [...agentFields, 'expected_version', 'status'])));
  app.get('/v1/agents/:agentId/deletion-preview', async request => service.deletionPreview(actor(request), param(request, 'agentId')));
  app.delete('/v1/agents/:agentId', async request => service.deleteAgent(actor(request), param(request, 'agentId'), version(body(request, ['expected_version']))));
  app.post('/v1/agents/:agentId/messages', async (request, reply) => reply.code(202).send(service.enqueueAgentMessage(actor(request), param(request, 'agentId'), body(request, ['text', 'client_message_id']))));
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
  app.get('/v1/workspaces/:workspaceId/memory', async request => service.listMemory(actor(request), param(request, 'workspaceId'), query(request)));
  app.get('/v1/workspaces/:workspaceId/memory/export', async request => service.exportMemory(actor(request), param(request, 'workspaceId'), query(request)));
  app.post('/v1/workspaces/:workspaceId/memory', async (request, reply) => reply.code(201).send(service.saveMemory(actor(request), param(request, 'workspaceId'), body(request, ['scope', 'agent_id', 'project_id', 'content', 'verified', 'memory_id', 'expected_version', 'provenance', 'source_revision', 'expires_at', 'supersedes']))));
  app.delete('/v1/workspaces/:workspaceId/memory/:memoryId', async request => service.deleteMemory(actor(request), param(request, 'workspaceId'), param(request, 'memoryId'), version(body(request, ['expected_version']))));
  app.get('/v1/workspaces/:workspaceId/files', async request => {
    const project = query(request).project_id;
    if (typeof project !== 'string') throw new Error('invalid_project_id');
    return service.listFiles(actor(request), param(request, 'workspaceId'), project);
  });
  app.get('/v1/workspaces/:workspaceId/files/content', async request => {
    const input = query(request);
    if(Object.keys(input).some(key=>!['project_id','path','version'].includes(key)))throw new Error('invalid_workbench_request');
    if (typeof input.project_id !== 'string' || typeof input.path !== 'string') throw new Error('invalid_file_path');
    if(input.version!==undefined){
      if(typeof input.version!=='string'||! /^[1-9][0-9]{0,15}$/.test(input.version)||!Number.isSafeInteger(Number(input.version)))throw new Error('invalid_file_version');
      const {created_at,...file}=service.readFileVersion(actor(request),param(request,'workspaceId'),input.project_id,input.path,Number(input.version));
      return {...file,updated_at:created_at};
    }
    return service.readFile(actor(request), param(request, 'workspaceId'), input.project_id, input.path);
  });
  app.put('/v1/workspaces/:workspaceId/files', async request => service.writeFile(actor(request), param(request, 'workspaceId'), body(request, ['project_id', 'path', 'content', 'expected_version'])));
}
