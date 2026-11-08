import {request,taskDraftScope} from './client';
import {validateSkillCatalogView,validateSkillResourceView,validateSkillDefinitionView,catalogDigestInput} from '../../packages/skills/catalog-contract.js';
type SkillCatalogObservation=Omit<ReturnType<typeof validateSkillCatalogView>,'items'>&{items:Array<ReturnType<typeof import('../../packages/skills/catalog-contract.js').skillManifest>>};
type SkillResourceView=Awaited<ReturnType<typeof validateSkillResourceView>>;
export interface SkillCatalogViewScope{conversation_id:string;workspace_id:string;project_id:string;agent_id:string;run_id:string;capability_epoch:number}
export interface SkillCatalogResponse extends SkillCatalogObservation{viewScope:SkillCatalogViewScope}
export interface SkillResourceResponse extends SkillResourceView{viewScope:SkillCatalogViewScope}
export type SkillDefinitionResponse=Awaited<ReturnType<typeof validateSkillDefinitionView>>&{viewScope:SkillCatalogViewScope};
export interface SkillCatalogState{runId:string;ownerScope:string;value?:SkillCatalogResponse;error?:boolean}
export function catalogForScope(state:SkillCatalogState|null,runId:string,ownerScope:string){return state?.runId===runId&&state.ownerScope===ownerScope?state:null;}
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SKILL=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function viewScope(value:unknown,runId:string):SkillCatalogViewScope{
 const keys=['conversation_id','workspace_id','project_id','agent_id','run_id','capability_epoch'];
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('skill_catalog_invalid');
 const scope=value as Record<string,unknown>;
 if(Object.keys(scope).sort().join(',')!==keys.sort().join(',')||scope.run_id!==runId
  ||keys.filter(k=>k!=='capability_epoch').some(k=>typeof scope[k]!=='string'||!ID.test(String(scope[k])))
  ||!Number.isSafeInteger(scope.capability_epoch)||Number(scope.capability_epoch)<1)throw Error('skill_catalog_invalid');
 return {conversation_id:scope.conversation_id as string,workspace_id:scope.workspace_id as string,project_id:scope.project_id as string,agent_id:scope.agent_id as string,run_id:scope.run_id as string,capability_epoch:scope.capability_epoch as number};
}
export async function readSkillCatalog(runId:string,ownerScope:string,signal:AbortSignal):Promise<SkillCatalogResponse>{
 if(!ID.test(runId))throw Error('skill_catalog_invalid');
 const current=()=>{signal.throwIfAborted();if(!/^[a-f0-9]{64}$/.test(ownerScope)||taskDraftScope()!==ownerScope)throw Error('SKILL_CATALOG_SCOPE_CHANGED');};
 current();const raw=await request<SkillCatalogResponse>(`/runs/${encodeURIComponent(runId)}/skills?commands=1`,'GET',undefined,undefined,signal);current();
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('skill_catalog_invalid');
 const {viewScope:rawScope,...candidate}=raw,catalog=validateSkillCatalogView(candidate),scope=viewScope(rawScope,runId);
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(catalogDigestInput(catalog))))].map(v=>v.toString(16).padStart(2,'0')).join('');current();
 if(hash!==catalog.catalogSha256)throw Error('skill_catalog_invalid');return {...catalog,viewScope:scope};
}
export async function readSelectedSkillDefinition(runId:string,ownerScope:string,name:string,signal:AbortSignal,includeSourceManifest=false):Promise<SkillDefinitionResponse>{
 if(!ID.test(runId)||!SKILL.test(name)||name.length>128)throw Error('skill_catalog_invalid');
 const current=()=>{signal.throwIfAborted();if(!/^[a-f0-9]{64}$/.test(ownerScope)||taskDraftScope()!==ownerScope)throw Error('SKILL_CATALOG_SCOPE_CHANGED');};
 current();const query=new URLSearchParams({name});if(includeSourceManifest)query.set('manifest','source');
 const raw=await request<SkillDefinitionResponse>(`/runs/${encodeURIComponent(runId)}/skills?${query}`,'GET',undefined,undefined,signal);current();
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('skill_catalog_invalid');
 const {viewScope:rawScope,...candidate}=raw,definition=await validateSkillDefinitionView(candidate),scope=viewScope(rawScope,runId);current();
 if(definition.name!==name||includeSourceManifest&&!definition.manifest.original)throw Error('skill_catalog_invalid');
 return {...definition,viewScope:scope};
}
export async function readSelectedSkillResource(runId:string,ownerScope:string,skillName:string,relativePath:string,signal:AbortSignal):Promise<SkillResourceResponse>{
 if(!ID.test(runId)||!SKILL.test(skillName)||typeof relativePath!=='string'||relativePath.length<1||relativePath.length>512)throw Error('skill_catalog_invalid');
 const current=()=>{signal.throwIfAborted();if(!/^[a-f0-9]{64}$/.test(ownerScope)||taskDraftScope()!==ownerScope)throw Error('SKILL_CATALOG_SCOPE_CHANGED');};
 current();const query=new URLSearchParams({name:skillName,path:relativePath});
 const raw=await request<SkillResourceResponse>(`/runs/${encodeURIComponent(runId)}/skills?${query}`,'GET',undefined,undefined,signal);current();
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('skill_catalog_invalid');
 const {viewScope:rawScope,...candidate}=raw,resource=await validateSkillResourceView(candidate),scope=viewScope(rawScope,runId);current();
 if(resource.name!==skillName||resource.relativePath!==relativePath)throw Error('skill_catalog_invalid');
 return {...resource,viewScope:scope};
}
