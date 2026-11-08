import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {compactionImageReferences} from '../session-adapter/compaction-images.js';
export const name='jot-work-native-compaction';
export const inject=['profileContext'];
export async function apply(ctx,config={}){
 const anchor=ctx.get('profileContext')?.installAnchor;
 if(typeof anchor!=='string')throw Error('jot_host_installation_missing');
 const require=createRequire(anchor);
 const {BasicCompactionEngine}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-compaction-basic')).href);
 if(typeof BasicCompactionEngine!=='function'||typeof BasicCompactionEngine.prototype.summarize!=='function')throw Error('work_compaction_host_incompatible');
 class WorkImageCompactionEngine extends BasicCompactionEngine{
  summarize(input,agent,signal){
   return super.summarize({...input,messages:compactionImageReferences(input.messages)},agent,signal);
  }
 }
 ctx.plugin(WorkImageCompactionEngine,config);
}
