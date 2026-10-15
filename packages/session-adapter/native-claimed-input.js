const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const valid=value=>typeof value==='string'&&ID.test(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const queues=['next-step','next-turn'];
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** Host-only setup for the official resume factory, before publication. It
 * repairs input, never grants execution or calls a send/Goal/wake API. */
export function createNativeClaimedInputRecoverySetup({Session,agents,sessions,query,projections,validateLog,authorize,confirmReplaySafety,signal}={}){
 if(typeof Session?.create!=='function'||typeof agents?.get!=='function'||typeof sessions?.get!=='function'||typeof query?.readSession!=='function'||typeof projections?.snapshot!=='function'||[validateLog,authorize,confirmReplaySafety].some(fn=>typeof fn!=='function'))throw Error('claim_recovery_config_invalid');
 const results=new WeakMap();
 const setup=async(_ctx,agent)=>{
  const session=agent?.session;
  const identity=()=>{signal?.throwIfAborted();if(!valid(agent?.id)||session?.id!==agent.id||agent.session!==session||agent.status!=='idle'||agents.get(agent.id)!==undefined||sessions.get(agent.id)!==undefined)throw Error('claim_recovery_identity_changed');};
  identity();if((await authorize({agent,signal}))?.authorized!==true)throw Error('claim_recovery_forbidden');identity();
  if(session.inheritedEventCount!==0||session.header?.isSeeded!==false||typeof agent.inbox?.splice!=='function')throw Error('claim_recovery_history_invalid');
  const liveCount=session.seq,header=canonical(session.header),loaded=await query.readSession(agent.id);identity();
  const events=freeze(structuredClone(loaded?.events)),count=events?.length,baseline=canonical(loaded);
  // SessionQuery exposes the complete logical cold log, including rc2's
  // end-seed marker. Match that marker to this factory lifecycle; reject
  // prior setup mutations instead of reading the live Session synchronously.
  // A failed prior setup can have durably flushed the neutral trailing marker;
  // then the constructor reuses it and firstLiveSeq equals count.
  const normalized=value=>canonical({...value,delegationDepth:value?.delegationDepth??0});
  if(!Array.isArray(events)||loaded?.session?.id!==agent.id||loaded.inheritedEventCount!==0||normalized(loaded.session)!==normalized(session.header)||![count-1,count].includes(session.firstLiveSeq)||liveCount!==count||events.at(-1)?.type!=='session/end-seed'||canonical(events.at(-1)?.data)!=='{}')throw Error('claim_recovery_history_invalid');
  const check=()=>{identity();if(session.seq!==liveCount||canonical(session.header)!==header)throw Error('claim_recovery_history_changed');};
  if(!Array.isArray(events)||events.length!==count||events.some((event,index)=>event?.seq!==index||typeof event.type!=='string'))throw Error('claim_recovery_history_invalid');
  const cold=(end=count)=>{
   const detached=Session.create(agent.id,events.slice(0,end),loaded.session,0),marker=events[end-1]?.type==='session/end-seed'?0:1;
   if(detached.id!==agent.id||detached.firstLiveSeq!==end||detached.seq!==end+marker)throw Error('claim_recovery_projection_invalid');
   return detached;
  };
  if((await validateLog(cold(),{signal}))?.validated!==true)throw Error('claim_recovery_history_invalid');check();
  const snapshot=end=>{
   // Use a real detached Session, not a structural stand-in. Its local
   // constructor may add a neutral end-seed marker; no live store is entered.
   const detached=cold(end),result=projections.snapshot(detached,['inbox']),inbox=result?.values?.inbox;check();
   if(result?.asOfSeq!==detached.seq-1||queues.some(target=>!Array.isArray(inbox?.[target])))throw Error('claim_recovery_projection_invalid');
   const ids=new Set();for(const message of queues.flatMap(target=>inbox[target])){if(!valid(message?.id)||ids.has(message.id))throw Error('claim_recovery_projection_invalid');ids.add(message.id);}
   return inbox;
  };
  const pending=snapshot(count);
  if(queues.some(target=>canonical(pending[target])!==canonical(target==='next-step'?agent.inbox.nextStep:agent.inbox.nextTurn)))throw Error('claim_recovery_projection_invalid');
  let opened,interrupted;
  for(const event of events){if(event.type==='turn/start')opened=event;if(event.type==='turn/end'){if(event.data?.reason?.kind==='interrupted')interrupted={start:opened,end:event};opened=undefined;}}
  const receipt=(state,restored=0,already_pending=0,goal_owned=0)=>Object.freeze({state,restored,already_pending,goal_owned,execution_authorized:false});
  if(!interrupted){results.set(agent,receipt('none'));return;}
  const {start,end}=interrupted;
  if(!start||start.data?.turn!==end.data?.turn)throw Error('claim_recovery_history_invalid');
  const tail=events.slice(start.seq+1,end.seq),claims=[],targets=new Set();
  if(tail.some(event=>event.type==='step/start'||event.type==='user/message'||event.type==='request/header'||event.type==='tool/call'))throw Error('claim_recovery_started');
  const metadata=new Set(['agent/inbox/spliced','subagent/catalog','team/member','goal/change']);
  if(tail.some(event=>!metadata.has(event.type)||event.surfaceOp!==undefined&&event.surfaceOp!=='append'))throw Error('claim_recovery_history_invalid');
  for(const event of tail){
   if(event.type!=='agent/inbox/spliced')continue;const d=event.data,removed=d?.removedCount??0;
   if(removed===0)continue;
   if(d.outcome==='canceled')throw Error('claim_recovery_cancelled');
   const prior=snapshot(event.seq),items=prior[d.target];
   if(!queues.includes(d.target)||d.outcome!==undefined||d.start!==0||!Array.isArray(d.inserted)||d.inserted.length||!Number.isSafeInteger(removed)||removed<1||targets.has(d.target)||removed!==(d.target==='next-step'?items.length:1))throw Error('claim_recovery_history_invalid');
   targets.add(d.target);for(const message of items.slice(0,removed)){
    if(message?.role!=='user'||typeof message.source?.kind!=='string'||!Array.isArray(message.content)||claims.some(item=>item.message.id===message.id))throw Error('claim_recovery_history_invalid');
    claims.push({target:d.target,message});
   }
  }
  const goalOwned=claims.filter(item=>item.message.source.kind==='goal').length,originals=claims.filter(item=>item.message.source.kind!=='goal');
  // Only the Controller's human user source has an established replay
  // contract here. Approval, scheduling and internal sources keep their owners.
  if(originals.some(item=>item.message.source.kind!=='user'))throw Error('claim_recovery_source_unsupported');
  if(!originals.length){results.set(agent,receipt('none',0,0,goalOwned));return;}
  // A later committed original means the input has already been recovered;
  // otherwise later work makes the missing input's ordering ambiguous.
  const committed=new Map(events.filter(event=>event.type==='user/message').map(event=>[event.data.id,event.data]));
  if(originals.every(({message})=>canonical(committed.get(message.id))===canonical(message))){results.set(agent,receipt('none',0,0,goalOwned));return;}
  if(events.slice(end.seq+1).some(event=>['turn/start','step/start','user/message','tool/call','request/header'].includes(event.type)))throw Error('claim_recovery_later_work');
  if(originals.some(({message})=>committed.has(message.id)))throw Error('claim_recovery_started');
  const originalIds=new Set(originals.map(({message})=>message.id));
  for(const event of events.slice(end.seq+1)){
   if(event.type!=='agent/inbox/spliced'||!(event.data?.removedCount>0))continue;
   const d=event.data,prior=snapshot(event.seq),removed=prior[d.target]?.slice(d.start,d.start+d.removedCount);
   if(!removed)throw Error('claim_recovery_projection_invalid');
   if(removed.some(message=>originalIds.has(message.id)))throw Error(d.outcome==='canceled'?'claim_recovery_cancelled':'claim_recovery_history_invalid');
  }
  const working=Object.fromEntries(queues.map(target=>[target,[...pending[target]]])),plan=[];let already=0;
  for(const target of queues){let index=0;for(const {message} of originals.filter(item=>item.target===target)){
   const found=queues.flatMap(key=>working[key].filter(item=>item.id===message.id).map(item=>({key,item,index:working[key].indexOf(item)})));
   if(found.length){if(found.length!==1||found[0].key!==target||found[0].index!==index||canonical(found[0].item)!==canonical(message))throw Error('claim_recovery_pending_conflict');already++;}
   else{working[target].splice(index,0,message);plan.push({target,index,message});}index++;
  }}
  if(plan.length){const candidates=freeze(originals.map(({target,message})=>({message_id:message.id,target,source:structuredClone(message.source)})));if((await confirmReplaySafety({agent,signal,turn:start.data.turn,candidates}))?.safe!==true)throw Error('claim_recovery_safety_unconfirmed');check();if((await authorize({agent,signal,candidates}))?.authorized!==true)throw Error('claim_recovery_forbidden');check();if(canonical(await query.readSession(agent.id))!==baseline)throw Error('claim_recovery_history_changed');check();}
  // Synchronous append-only insertion keeps the original native targets and
  // positions. The official factory flushes this suffix before publication.
  for(const {target,index,message} of plan)agent.inbox.splice(target,index,0,[message]);
  if(queues.some(target=>canonical(working[target])!==canonical(target==='next-step'?agent.inbox.nextStep:agent.inbox.nextTurn)))throw Error('claim_recovery_restore_conflict');
  results.set(agent,receipt(plan.length?'restored':'none',plan.length,already,goalOwned));
 };
 setup.resultFor=agent=>results.get(agent);return setup;
}
