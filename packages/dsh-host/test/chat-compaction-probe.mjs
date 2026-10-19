// Explicit test trigger only; no scheduling or automatic readiness activation.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
export function installChatCompactionProbe(ctx,{requestPath,receiptPath}){
 const seen=new Set();let running=false;
 const timer=setInterval(async()=>{
  if(running)return;let body;try{body=JSON.parse(await readFile(requestPath,'utf8'));}catch{return;}if(seen.has(body.intent_id))return;seen.add(body.intent_id);running=true;
  const agent=ctx.agents.get(body.scope.session_ref),session=agent.session;let before=session.seq;
  try{
   if(body.replaceContext===true){
    const events=session.snapshotEvents(0),marker=events.find(e=>session.surface.nodes.includes(e.seq)&&e.type==='user/message'&&e.data?.source?.kind==='jot-chat-context'&&e.data.source.run_id===body.scope.run_id);
    if(!marker)throw Error('synthetic_context_marker_missing');
    const {createUserMessage}=await import(pathToFileURL(createRequire(ctx.get('profileContext').installAnchor).resolve('@deepseek-ai/dsh-llm')).href);
    session.append('user/message',createUserMessage({source:structuredClone(marker.data.source),content:structuredClone(marker.data.content)}),{surfaceOp:{op:'replace',startSeq:marker.seq,endSeq:marker.seq},sourceEventSeqs:[marker.seq]});
    if(await ctx.sessions.flush(session)!==true)throw Error('synthetic_context_replacement_not_durable');before=session.seq;
   }
   const result=await ctx.get('jotChatCompactionManager').run(body),events=session.snapshotEvents(before);
   const {Session}=await import(pathToFileURL(createRequire(ctx.get('profileContext').installAnchor).resolve('@deepseek-ai/dsh-session')).href);
   Session.create(session.id,session.snapshotEvents(0),session.header,0);
   await writeFile(receiptPath,JSON.stringify({status:result.status,events,durable:await ctx.sessions.flush(session),replayValid:true,checkpointPublished:!!result.checkpoint}));
  }catch(error){await writeFile(receiptPath,JSON.stringify({error:error.message,stack:error.stack,causes:[error.cause?.stack,error.cause?.cause?.stack],engine:{protocol:ctx.get('agentPresets').serviceFor(agent,'compaction')?.jotChatCompactionProtocol,auto:ctx.get('agentPresets').serviceFor(agent,'compaction')?.config?.auto},status:agent.status,events:session.snapshotEvents(before),durable:await ctx.sessions.flush(session)}));}finally{running=false;}
 },40);ctx.effect(()=>()=>clearInterval(timer));
}
