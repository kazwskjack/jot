import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {WorkbenchService} from '../workbench/service.ts';
export type SkillCatalogScope=Readonly<{owner_id:string;project_id:string;workspace_id:string;agent_id:string;run_id:string;session_ref:string;capability_epoch:number}>;
export type SkillCatalogHost=Readonly<{
 read:(input:{scope:SkillCatalogScope;signal?:AbortSignal;include_commands?:true})=>Promise<unknown>;
 readResource?:(input:{scope:SkillCatalogScope;skill_name:string;relative_path:string;signal?:AbortSignal})=>Promise<unknown>;
 readDefinition?:(input:{scope:SkillCatalogScope;name:string;signal?:AbortSignal;include_source_manifest?:true})=>Promise<unknown>;
}>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SKILL=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
type Row=Record<string,any>;
async function contract(){
 const path=import.meta.url.endsWith('/dist/src/skills/catalog.js')?'../../../../skills/catalog-contract.js':'../../../skills/catalog-contract.js';
 return import(new URL(path,import.meta.url).href) as Promise<{validateSkillCatalogView:(value:unknown)=>Row;validateSkillResourceView:(value:unknown)=>Row;validateSkillDefinitionView:(value:unknown)=>Promise<Row>;catalogDigestInput:(value:unknown)=>string}>;
}
/** Read existing bindings only. Browser values never select a physical root,
 * Host principal, new Session, registry provider or execution permission. */
export class SkillCatalogService{
 private readonly db:DatabaseSync;
 private readonly workbench:Pick<WorkbenchService,'contextForRun'|'assertRunActive'>;
 private readonly host:SkillCatalogHost;
 constructor(db:DatabaseSync,workbench:Pick<WorkbenchService,'contextForRun'|'assertRunActive'>,host:SkillCatalogHost){this.db=db;this.workbench=workbench;this.host=host;}
 private bound(owner:string,runId:string){
  if(!ID.test(owner)||!ID.test(runId))throw Error('skill_catalog_scope_forbidden');
  const row=this.db.prepare(`SELECT c.id AS conversation_id,c.owner_id,c.workspace_id,c.project_id,
   r.native_session_ref,r.native_owner_id,r.native_conversation_id,b.session_id,b.owner_id AS binding_owner
   FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
   LEFT JOIN ga_harness_session_bindings b ON b.conversation_id=c.id
   WHERE r.id=? AND c.owner_id=? AND c.archived_at IS NULL`).get(runId,owner) as Row|undefined;
  if(!row)throw Error('skill_catalog_scope_forbidden');
  const context=this.workbench.contextForRun(runId);
  if(!context||context.owner_id!==owner||context.workspace_id!==row.workspace_id||context.project_id!==row.project_id)throw Error('skill_catalog_scope_forbidden');
  this.workbench.assertRunActive(runId);
  let session:string;
  if(row.native_session_ref!==null){
   if(row.native_owner_id!==owner||row.native_conversation_id!==row.conversation_id)throw Error('skill_catalog_scope_forbidden');session=String(row.native_session_ref);
  }else{
   if(row.binding_owner!==owner)throw Error('skill_catalog_scope_forbidden');session=String(row.session_id);
  }
  if(!ID.test(session))throw Error('skill_catalog_scope_forbidden');
  const scope:SkillCatalogScope={owner_id:owner,project_id:context.project_id,workspace_id:context.workspace_id,agent_id:context.agent_id,
   run_id:runId,session_ref:session,capability_epoch:context.capability_epoch};
  return {scope,conversation_id:String(row.conversation_id)};
 }
 async read(owner:string,runId:string,signal?:AbortSignal,includeCommands=false){
  signal?.throwIfAborted();const before=this.bound(owner,runId);
  const response=await this.host.read({scope:before.scope,...(signal?{signal}:{}),...(includeCommands?{include_commands:true as const}:{})}) as Row;
  signal?.throwIfAborted();const after=this.bound(owner,runId);
  if(JSON.stringify(before)!==JSON.stringify(after))throw Error('skill_catalog_scope_changed');
  if(!response||Object.keys(response).sort().join(',')!=='catalog,scope'||!response.scope||typeof response.scope!=='object'||Array.isArray(response.scope)
   ||Object.keys(response.scope).length!==Object.keys(before.scope).length
   ||Object.entries(before.scope).some(([key,value])=>response.scope[key]!==value))throw Error('skill_catalog_scope_changed');
  const api=await contract(),catalog=api.validateSkillCatalogView(response.catalog);
  const hash=createHash('sha256').update(api.catalogDigestInput(catalog)).digest('hex');
  if(hash!==catalog.catalogSha256)throw Error('skill_catalog_invalid');
  return {...catalog,viewScope:{conversation_id:before.conversation_id,project_id:before.scope.project_id,workspace_id:before.scope.workspace_id,
   agent_id:before.scope.agent_id,run_id:runId,capability_epoch:before.scope.capability_epoch}};
 }
 async readDefinition(owner:string,runId:string,name:string,signal?:AbortSignal,includeSourceManifest=false){
  signal?.throwIfAborted();
  if(typeof name!=='string'||!SKILL.test(name)||name.length>128)throw Error('skill_catalog_invalid');
  const before=this.bound(owner,runId);
  if(typeof this.host.readDefinition!=='function')throw Error('skill_catalog_host_unavailable');
  const response=await this.host.readDefinition({scope:before.scope,name,...(signal?{signal}:{}),
   ...(includeSourceManifest?{include_source_manifest:true as const}:{})}) as Row;
  signal?.throwIfAborted();
  if(JSON.stringify(before)!==JSON.stringify(this.bound(owner,runId))||!response
   ||Object.keys(response).sort().join(',')!=='execution_authorized,scope,skill'||response.execution_authorized!==false
   ||!response.scope||typeof response.scope!=='object'||Array.isArray(response.scope)
   ||Object.keys(response.scope).length!==Object.keys(before.scope).length
   ||Object.entries(before.scope).some(([key,value])=>response.scope[key]!==value))throw Error('skill_catalog_scope_changed');
  const definition=await (await contract()).validateSkillDefinitionView(response.skill);
  signal?.throwIfAborted();
  if(definition.name!==name||includeSourceManifest&&!definition.manifest.original
   ||JSON.stringify(before)!==JSON.stringify(this.bound(owner,runId)))throw Error('skill_catalog_scope_changed');
  return {...definition,viewScope:{conversation_id:before.conversation_id,project_id:before.scope.project_id,
   workspace_id:before.scope.workspace_id,agent_id:before.scope.agent_id,run_id:runId,capability_epoch:before.scope.capability_epoch}};
 }
 async readResource(owner:string,runId:string,skill_name:string,relative_path:string,signal?:AbortSignal){
  signal?.throwIfAborted();if(!SKILL.test(skill_name)||typeof relative_path!=='string'||relative_path.length<1||relative_path.length>512)throw Error('skill_catalog_invalid');
  const before=this.bound(owner,runId);if(typeof this.host.readResource!=='function')throw Error('skill_catalog_host_unavailable');
  const response=await this.host.readResource({scope:before.scope,skill_name,relative_path,...(signal?{signal}:{})}) as Row;
  signal?.throwIfAborted();const after=this.bound(owner,runId);
  if(JSON.stringify(before)!==JSON.stringify(after))throw Error('skill_catalog_scope_changed');
  if(!response||Object.keys(response).sort().join(',')!=='resource,scope'||!response.scope||typeof response.scope!=='object'||Array.isArray(response.scope)
   ||Object.keys(response.scope).length!==Object.keys(before.scope).length
   ||Object.entries(before.scope).some(([key,value])=>response.scope[key]!==value))throw Error('skill_catalog_scope_changed');
  const api=await contract(),resource=await api.validateSkillResourceView(response.resource);
  if(resource.name!==skill_name||resource.relativePath!==relative_path)throw Error('skill_catalog_scope_changed');
  return {...resource,viewScope:{conversation_id:before.conversation_id,project_id:before.scope.project_id,workspace_id:before.scope.workspace_id,
   agent_id:before.scope.agent_id,run_id:runId,capability_epoch:before.scope.capability_epoch}};
 }
}
