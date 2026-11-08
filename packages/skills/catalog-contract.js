const NAME=/^[a-z0-9]+(?:-[a-z0-9]+)*$/, LABEL=/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/, SHA=/^[a-f0-9]{64}$/;
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const sha=v=>typeof v==='string'&&SHA.test(v);
const label=v=>typeof v==='string'&&LABEL.test(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const invalid=()=>{throw Error('skill_catalog_invalid');};
export function skillManifest(value){
 if(!object(value)||typeof value.name!=='string'||value.name.length>128||!NAME.test(value.name)
  ||typeof value.description!=='string'||value.description.length>16384
  ||value.whenToUse!==undefined&&(typeof value.whenToUse!=='string'||value.whenToUse.length>16384)
  ||!object(value.invocation)||typeof value.invocation.modelInvocable!=='boolean'||typeof value.invocation.userInvocable!=='boolean'
  ||!label(value.source)||!label(value.provider))invalid();
 return {name:value.name,description:value.description,...(value.whenToUse===undefined?{}:{whenToUse:value.whenToUse}),
  invocation:{modelInvocable:value.invocation.modelInvocable,userInvocable:value.invocation.userInvocable},source:value.source,provider:value.provider};
}
export function commandManifest(value){
 if(!object(value)||typeof value.name!=='string'||value.name.length>128||!/^[a-z][a-z0-9_-]*$/u.test(value.name)
  ||typeof value.description!=='string'||value.description.length>16384
  ||value.definitionId!==undefined&&(typeof value.definitionId!=='string'||value.definitionId.length<1||value.definitionId.length>512||/[\u0000-\u001f\u007f]/u.test(value.definitionId))
  ||value.input!==undefined&&(!object(value.input)||typeof value.input.hint!=='string'||value.input.hint.length>16384
   ||value.input.attachments!==undefined&&typeof value.input.attachments!=='boolean'))invalid();
 return {name:value.name,description:value.description,...(value.definitionId===undefined?{}:{definitionId:value.definitionId}),
  ...(value.input===undefined?{}:{input:{hint:value.input.hint,...(value.input.attachments===undefined?{}:{attachments:value.input.attachments})}})};
}
function commandCatalog(value){
 if(!exact(value,['available','items'])||typeof value.available!=='boolean'||!Array.isArray(value.items)
  ||value.items.length>256||!value.available&&value.items.length)invalid();
 let previous='';
 const items=value.items.map(raw=>{
  const item=commandManifest(raw);
  if(!exact(raw,Object.keys(item))||item.input&&!exact(raw.input,Object.keys(item.input))||item.name<=previous)invalid();
  previous=item.name;return item;
 });
 return {available:value.available,items};
}
export function catalogDigestInput(value){return JSON.stringify({protocol:1,complete:value.complete,items:value.items,
 ...(value.commands===undefined?{}:{commands:value.commands})});}
/** Allowlist the observation. Provider paths, opaque locators and arbitrary metadata never cross this boundary. */
export function validateSkillCatalogView(value){
 if(!exact(value,['protocol','complete','items','catalogSha256','execution_authorized',...(object(value)&&Object.hasOwn(value,'commands')?['commands']:[])])||value.protocol!==1||value.execution_authorized!==false
  ||typeof value.complete!=='boolean'||!Array.isArray(value.items)||value.items.length>256||!sha(value.catalogSha256)||!value.complete&&value.items.length)invalid();
 let previous='';
 const items=value.items.map(raw=>{
  const manifest=skillManifest(raw),keys=Object.keys(manifest);
  if(!exact(raw,keys)||!exact(raw.invocation,['modelInvocable','userInvocable'])||manifest.name<=previous)invalid();
  previous=manifest.name;return manifest;
 });
 return {protocol:1,complete:value.complete,items,catalogSha256:value.catalogSha256,execution_authorized:false,
  ...(Object.hasOwn(value,'commands')?{commands:commandCatalog(value.commands)}:{})};
}
/** Validate inert text returned for one explicitly selected DSH resource. */
export async function validateSkillResourceView(value){
 if(!exact(value,['protocol','name','relativePath','text','textSha256','execution_authorized'])||value.protocol!==1
  ||typeof value.name!=='string'||!NAME.test(value.name)||typeof value.relativePath!=='string'||value.relativePath.length<1||value.relativePath.length>512
  ||value.relativePath.startsWith('/')||value.relativePath.startsWith('\\')||value.relativePath.includes('\\')||/^[a-z]:/iu.test(value.relativePath)
  ||/[\u0000-\u001f\u007f]/u.test(value.relativePath)||value.relativePath.split('/').some(part=>part===''||part==='..'||part.includes(':'))
  ||typeof value.text!=='string'||new TextEncoder().encode(value.text).byteLength>64*1024||!sha(value.textSha256)||value.execution_authorized!==false)invalid();
 const digest=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.text)));
 const actual=[...digest].map(byte=>byte.toString(16).padStart(2,'0')).join('');if(actual!==value.textSha256)invalid();
 return {protocol:1,name:value.name,relativePath:value.relativePath,text:value.text,textSha256:value.textSha256,execution_authorized:false};
}
