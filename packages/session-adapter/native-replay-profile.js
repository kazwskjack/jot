import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
/** A trusted host audit plus exact installed-artifact hashes. This verifies
 * continuity of a reviewed composition; hashes alone do not prove hook safety. */
export function createNativeReplayProfile({id,presetId=null,auditId,artifacts,verifyComposition}={}){
 if(!valid(id)||presetId!==null&&!valid(presetId)||!valid(auditId)||!Array.isArray(artifacts)||!artifacts.length||typeof verifyComposition!=='function')throw Error('native_replay_profile_config_invalid');
 const files=artifacts.map(item=>{if(!item||!valid(item.id)||typeof item.path!=='string'||!isAbsolute(item.path)||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error('native_replay_profile_config_invalid');return Object.freeze({...item});}).sort((a,b)=>a.id.localeCompare(b.id));
 if(new Set(files.map(item=>item.id)).size!==files.length)throw Error('native_replay_profile_config_invalid');
 return Object.freeze({async read({presetId:requested=null,signal,agent,phase='prepared'}={}){
  signal?.throwIfAborted();if(requested!==presetId)throw Error('native_replay_profile_preset_changed');if(!['prepared','bound'].includes(phase))throw Error('native_replay_profile_phase_invalid');
  for(const file of files){const bytes=await readFile(file.path,{signal});signal?.throwIfAborted();if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('native_replay_profile_source_changed');}
  const manifest=Object.freeze(files.map(({id,sha256})=>Object.freeze({id,sha256})));
  if((await verifyComposition({presetId,auditId,manifest,signal,agent,phase}))?.verified!==true)throw Error('native_replay_profile_unreviewed');signal?.throwIfAborted();
  const fingerprint=createHash('sha256').update(JSON.stringify({id,presetId,auditId,manifest})).digest('hex');
  return Object.freeze({protocol:1,profile_id:id,preset_id:presetId,audit_id:auditId,fingerprint});
 }});
}
