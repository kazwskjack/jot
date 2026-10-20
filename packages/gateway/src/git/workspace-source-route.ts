import {timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {GitIndexExecutions} from './index-executions.ts';
import type {DatabaseSync} from 'node:sqlite';
import {retainOriginalGitDatabase} from './database-identity.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** Original service-only inventory, not native quiescence or dispatch. The
 * executor derives membership from its admitted operation and held reservation;
 * no supplied member list, root, run or permission is accepted here. */
export function registerGitWorkspaceSource(app:FastifyInstance,executions:GitIndexExecutions,token:string|undefined,db?:DatabaseSync){
 let identity:ReturnType<typeof retainOriginalGitDatabase>|undefined;
 try{if(db)identity=retainOriginalGitDatabase(db);}catch{}
 app.post('/internal/v1/workbench/native-git-database',async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  const actual=Buffer.from(String(request.headers.authorization??'')),expected=Buffer.from(`Bearer ${token??''}`);
  if(!token||token.length<16||actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  if(!request.body||typeof request.body!=='object'||Array.isArray(request.body)||Object.keys(request.body).length||Object.keys(request.query as object).length)return reply.code(422).send({error:{code:'NATIVE_GIT_DATABASE_INVALID'}});
  try{if(!identity)throw Error();identity.assertCurrent();return{protocol:1,database_sha256:identity.sha256,execution_authorized:false};}
  catch{return reply.code(409).send({error:{code:'NATIVE_GIT_DATABASE_UNCONFIRMED'}});}
 });
 app.post('/internal/v1/workbench/native-workspace-admission',async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  const actual=Buffer.from(String(request.headers.authorization??'')),expected=Buffer.from(`Bearer ${token??''}`);
  if(!token||token.length<16||actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const input=request.body as Record<string,unknown>;
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).join(',')!=='session_ref'||typeof input.session_ref!=='string'||!ID.test(input.session_ref)
   ||Object.keys(request.query as object).length)return reply.code(422).send({error:{code:'NATIVE_WORKSPACE_ADMISSION_INVALID'}});
  try{return executions.observeNativeAdmission(input.session_ref);}
  catch{return reply.code(409).send({error:{code:'NATIVE_WORKSPACE_ADMISSION_UNCONFIRMED'}});}
 });
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
