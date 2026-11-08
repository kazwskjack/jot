/** Read the current stop boundary through the native persistence read contract. */
export async function readHookStopPayload({agent,turn,signal,sessions,persistence,readAgent}) {
  const session = agent.session;
  const check = () => {
    signal.throwIfAborted();
    if (readAgent(agent.id)!==agent || agent.session!==session || session?.id!==agent.id
      || !Number.isSafeInteger(turn) || turn<0) throw new Error('hook_stop_source_invalid');
  };
  check();
  const end = session.seq;
  if (!Number.isSafeInteger(end) || end<1) throw new Error('hook_stop_source_invalid');
  if (await sessions.flush(session)!==true) throw new Error('hook_stop_source_unavailable');
  check();
  const handle = await persistence.open(agent.id,'read',{signal});
  try {
    check();
    if (handle.id!==session.id || handle.header.createdAt!==session.header.createdAt) {
      throw new Error('hook_stop_source_invalid');
    }
    let cursor = end, step, assistant;
    while (cursor>0) {
      const start = Math.max(0,cursor-256);
      const {events} = await handle.read(start,cursor-start,{signal});
      check();
      if (events.length!==cursor-start || events.some((event,index)=>event.seq!==start+index)) {
        throw new Error('hook_stop_source_invalid');
      }
      for (let index=events.length-1;index>=0;index--) {
        const event = events[index];
        if (event.type==='turn/end') throw new Error('hook_stop_source_invalid');
        if (event.data?.turn!==turn) continue;
        if (event.type==='step/end' && step===undefined) step=event.data.step;
        if (event.type==='assistant/message' && assistant===undefined) assistant=event.data.message;
        if (event.type==='turn/start') {
          if (!Number.isSafeInteger(step) || step<1) throw new Error('hook_stop_source_invalid');
          return {turn,step,stopHookActive:false,lastAssistantMessage:assistant?.content
            ?.filter(block=>block.type==='text').map(block=>block.text).join('\n')??''};
        }
      }
      cursor=start;
    }
    throw new Error('hook_stop_source_invalid');
  } finally {await handle.close();}
}
