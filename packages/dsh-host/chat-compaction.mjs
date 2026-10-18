import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createAccountedChatCompactionEngine} from '../session-adapter/chat-compaction-engine.js';
export const name='jot-chat-native-compaction';
export const inject=['llm','tokenMeter','sessions','profileContext','jotChatCompactionRuntime'];
export async function apply(ctx,config={}){
 if(Object.keys(config).some(key=>key!=='auto')||config.auto!==false)throw Error('chat_compaction_config_invalid');
 const runtime=ctx.get('jotChatCompactionRuntime');if(runtime?.protocol!==1||typeof runtime.get!=='function')throw Error('chat_compaction_runtime_unavailable');
 const require=createRequire(ctx.get('profileContext').installAnchor),{BasicCompactionEngine}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-compaction-basic')).href),{BlockAssembler}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
 const Engine=createAccountedChatCompactionEngine({BasicCompactionEngine,BlockAssembler,getOperation:runtime.get});ctx.plugin(Engine,{auto:false});
}
