// Explicit test trigger only; no scheduling or automatic readiness activation.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
export function installChatCompactionProbe(ctx,{requestPath,receiptPath}){
 let started=false;
 const timer=setInterval(async()=>{
  if(started)return;let body;try{body=JSON.parse(await readFile(requestPath,'utf8'));}catch{return;}started=true;
  const agent=ctx.agents.get(body.scope.session_ref),session=agent.session,before=session.seq;
  try{
   const result=await ctx.get('jotChatCompactionManager').run(body),events=session.snapshotEvents(before);
   const {Session}=await import(pathToFileURL(createRequire(ctx.get('profileContext').installAnchor).resolve('@deepseek-ai/dsh-session')).href);
   Session.create(session.id,session.snapshotEvents(0),session.header,0);
   await writeFile(receiptPath,JSON.stringify({status:result.status,events,durable:await ctx.sessions.flush(session),replayValid:true,checkpointPublished:false}));
  }catch(error){await writeFile(receiptPath,JSON.stringify({error:error.message,stack:error.stack,causes:[error.cause?.stack,error.cause?.cause?.stack],engine:{protocol:ctx.get('agentPresets').serviceFor(agent,'compaction')?.jotChatCompactionProtocol,auto:ctx.get('agentPresets').serviceFor(agent,'compaction')?.config?.auto},status:agent.status,events:session.snapshotEvents(before),durable:await ctx.sessions.flush(session)}));}
 },40);ctx.effect(()=>()=>clearInterval(timer));
}
