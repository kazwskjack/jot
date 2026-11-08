import {createHash} from 'node:crypto';
import {listSkills,readSkillResource} from './registry.js';
import {skillManifest,catalogDigestInput,validateSkillCatalogView,validateSkillResourceView} from './catalog-contract.js';
const digest=v=>createHash('sha256').update(v).digest('hex');
/** Current official registry observation, never an install manifest or a new registry/store. */
export async function readSkillCatalogView({skills,cwd,scope,signal}={}){
 const options={skills,cwd,scope,signal},first=await listSkills(options);signal?.throwIfAborted();
 if(first.skills.length>256)throw Error('skill_catalog_too_large');
 const items=first.complete?[...first.skills].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0).map(skillManifest):[];
 const value={protocol:1,complete:first.complete,items,execution_authorized:false};
 return validateSkillCatalogView({...value,catalogSha256:digest(catalogDigestInput(value))});
}

/** Load exactly one local reference selected by the user, through DSH's current registry and filesystem. */
export async function readSkillResourceView({skills,fs,name,relativePath,cwd,scope,signal}={}){
 const selected=await readSkillResource({skills,fs,name,relativePath,cwd,scope,signal});signal?.throwIfAborted();
 return validateSkillResourceView({protocol:1,name,relativePath,text:selected.text,textSha256:selected.textSha256,execution_authorized:false});
}
