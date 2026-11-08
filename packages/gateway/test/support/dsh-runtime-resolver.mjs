import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export async function resolve(specifier,context,nextResolve){
 const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
 let parentPath='',patched=process.env.JOT_DSH_PATCHED_LOOP;
 try{parentPath=fileURLToPath(context.parentURL??'');}catch{}
 const patchMatch=parentPath.match(/^(.*[\\/](?:dsh-agent-loop-patched|native-host-agent-loop-[^\\/]+))(?:[\\/]|$)/i);
 if(!patched&&patchMatch)patched=patchMatch[1];
 if(specifier==='@deepseek-ai/dsh-agent-loop'&&patched){
  return{url:pathToFileURL(join(patched,'lib/index.js')).href,shortCircuit:true};
 }
 if(specifier.startsWith('@deepseek-ai/dsh-agent-loop/')&&patched){
  return nextResolve(pathToFileURL(join(patched,specifier.slice('@deepseek-ai/dsh-agent-loop/'.length))).href,context);
 }
 const fromPatched=!!patchMatch;
 if(runtime&&fromPatched&&!specifier.startsWith('.')&&!specifier.startsWith('file:')&&!specifier.startsWith('node:')){
  const anchor=pathToFileURL(join(dirname(dirname(runtime)),'__codex-runtime-resolver__.mjs')).href;
  return nextResolve(specifier,{...context,parentURL:anchor});
 }
 return nextResolve(specifier,context);
}
