const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA256=/^[a-f0-9]{64}$/;

/** Mount an original-run read-only view for ordinary and role conversations. */
export function catalogMountForRun(runId,ownerScope,ordinary){
 if(typeof ordinary!=='boolean'||typeof runId!=='string'||!ID.test(runId)||typeof ownerScope!=='string'||!SHA256.test(ownerScope))return null;
 return {runId,ownerScope};
}
/** Add the native DSH gesture to the composer draft; sending remains an explicit user action. */
export function skillGestureDraft(draft,name){
 if(typeof name!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))throw Error('skill_catalog_invalid');
 const current=typeof draft==='string'?draft:'';
 return current.trim()?`${current}${current.endsWith('\n')?'':'\n'}/${name}`:`/${name}`;
}
