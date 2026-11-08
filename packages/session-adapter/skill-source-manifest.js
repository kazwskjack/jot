import {relative,isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readSkillResource} from '../skills/registry.js';
import {skillManifest} from '../skills/catalog-contract.js';

/** Inspect only the original registry-selected instruction file through DSH FS. */
export async function readSkillSourceManifest({definition,skills,fs,cwd,scope,signal,parseYaml}) {
  const base=definition.resourceBase;
  if(base?.kind!=='directory'||typeof base.path!=='string'||!isAbsolute(base.path)
    ||typeof definition.path!=='string'||!isAbsolute(definition.path)||typeof parseYaml!=='function') {
    throw new Error('skill_resource_provider_unsupported');
  }
  const identity=value=>({...skillManifest(value),path:value.path,resourceBase:value.resourceBase});
  const original=structuredClone(identity(definition));
  const check=async()=>{
    signal?.throwIfAborted();
    const catalog=await skills.snapshot({cwd,scope,signal});
    const selected=catalog.skills?.find(value=>value.name===definition.name);
    if(catalog.complete!==true||!selected||!isDeepStrictEqual(identity(selected),original))throw new Error('skill_definition_changed');
    signal?.throwIfAborted();
  };
  await check();
  const path=relative(base.path,definition.path).replaceAll('\\','/');
  const resource=await readSkillResource({skills,fs,name:definition.name,relativePath:path,cwd,scope,signal,maxBytes:1024*1024});
  await check();
  const match=/^---\r?\n([\s\S]*?)^---(?:\r?\n|$)([\s\S]*)$/m.exec(resource.text);
  if(!match||match.index!==0||match[2].trim()!==definition.content)throw new Error('skill_definition_changed');
  let data;
  try{data=parseYaml(match[1],{maxAliasCount:100});}catch{throw new Error('skill_definition_changed');}
  if(!data||typeof data!=='object'||Array.isArray(data)||data.name!==definition.name||data.description!==definition.description) {
    throw new Error('skill_definition_changed');
  }
  const text=value=>{
    if(typeof value==='number'&&Number.isFinite(value))value=String(value);
    return typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/u.test(value)?value:null;
  };
  return {version:text(data.version),license:text(data.license),source:'selected-skill-frontmatter',textSha256:resource.textSha256};
}
