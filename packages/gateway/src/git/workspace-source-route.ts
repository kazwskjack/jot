import {timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {GitIndexExecutions} from './index-executions.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** Original service-only inventory, not native quiescence or dispatch. The
 * executor derives membership from its admitted operation and held reservation;
 * no supplied member list, root, run or permission is accepted here. */
export function registerGitWorkspaceSource(app:FastifyInstance,executions:GitIndexExecutions,token:string|undefined){
 app.post('/internal/v1/workbench/git-workspace-source',async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  const actual=Buffer.from(String(request.headers.authorization??'')),expected=Buffer.from(`Bearer ${token??''}`);
  if(!token||token.length<16||actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const input=request.body as Record<string,unknown>;
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='execution_id,owner_id,project_id'
   ||!['owner_id','project_id','execution_id'].every(key=>typeof input[key]==='string'&&ID.test(input[key] as string))
   ||Object.keys(request.query as object).length)return reply.code(422).send({error:{code:'GIT_WORKSPACE_SOURCE_INVALID'}});
  try{return{source:executions.workspaceFamily(input.owner_id as string,input.project_id as string,input.execution_id as string)};}
  catch{return reply.code(409).send({error:{code:'GIT_WORKSPACE_SOURCE_UNCONFIRMED'}});}
 });
}
