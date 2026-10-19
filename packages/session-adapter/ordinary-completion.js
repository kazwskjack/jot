import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readOrdinaryInputAuthority} from './ordinary-input-resume.js';
import {readOrdinarySteeringAuthority} from './ordinary-steering-authority.js';
const valid=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const hash=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const fail=()=>{throw Error('ordinary_completion_unconfirmed');};
function waitForIdle(agent,signal){return new Promise((resolve,reject)=>{signal.throwIfAborted();const abort=()=>{cleanup();reject(signal.reason);},cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>agent.whenIdle()).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});});}
/** Inspect only the existing Agent and immutable admissions. No resolve, prompt,
 * maintenance, wake, entry reservation, persistence write or cost settlement. */
export function createOrdinaryCompletionReader({agents,bridge,profile,admissions,ordinaryPresets,readGoal,attachmentSteeringProtocol}){
 if(attachmentSteeringProtocol!==undefined&&attachmentSteeringProtocol!==1||attachmentSteeringProtocol===1&&admissions?.steeringAttachmentAdmissionProtocol!==1)fail();
 if(typeof agents?.get!=='function'||typeof bridge?.request!=='function'||typeof profile?.read!=='function'||typeof admissions?.read!=='function'||!(ordinaryPresets instanceof Set)||!ordinaryPresets.size||typeof readGoal!=='function')fail();
 return async({binding,commandIds,signal})=>{
  if(!binding||Object.keys(binding).sort().join(',')!=='executionLease,runId,sessionRef'||!valid(binding.runId)||!valid(binding.sessionRef)||!Array.isArray(commandIds)||commandIds.some(id=>!valid(id)||id===binding.runId)||new Set(commandIds).size!==commandIds.length||!signal)fail();
  const agent=agents.get(binding.sessionRef),session=agent?.session;
  const identity=()=>{signal.throwIfAborted();if(!agent||agents.get(binding.sessionRef)!==agent||agent.id!==binding.sessionRef||agent.session!==session||session?.id!==binding.sessionRef||!ordinaryPresets.has(session.header?.agentPreset)||session.header.parentSession!==undefined||session.header.origin==='subagent')fail();};
  identity();if(typeof agent.whenIdle!=='function'||typeof session.snapshotEvents!=='function')fail();
  const busy=()=>{const log=session.snapshotEvents(0),start=log.findLast(e=>e.type==='turn/start'),end=log.findLast(e=>e.type==='turn/end');return{protocol:1,status:'busy',wait_for:agent.inbox.nextStep.length||agent.inbox.nextTurn.length||start&&(!end||start.seq>end.seq)?'events':'idle',execution_authorized:false};};
  const root=await readOrdinaryInputAuthority({bridge,binding,signal,assertActive:identity});
  const current=session.snapshotEvents(0),latestStart=current.findLast(e=>e.type==='turn/start'),latestEnd=current.findLast(e=>e.type==='turn/end');
  if(agent.inbox.nextStep.length||agent.inbox.nextTurn.length||latestStart&&(!latestEnd||latestStart.seq>latestEnd.seq))return busy();
  await waitForIdle(agent,signal);identity();
  if(agent.status!=='idle'||agent.inbox.nextStep.length||agent.inbox.nextTurn.length)return busy();
  const seq=session.seq,goal=readGoal(agent);if(goal?.phase==='active'&&goal.activation==='armed')return busy();
  const stable=()=>{identity();return agent.status==='idle'&&session.seq===seq&&!agent.inbox.nextStep.length&&!agent.inbox.nextTurn.length&&isDeepStrictEqual(readGoal(agent),goal);};
  const reviewed=await profile.read({agent,presetId:session.header.agentPreset,phase:'bound',signal});if(!stable())return busy();if(!/^[a-f0-9]{64}$/.test(reviewed?.fingerprint??''))fail();
  const commands=[];
  const attachmentOptions=attachmentSteeringProtocol===1?{attachmentProtocol:1}:{};
  for(const commandId of commandIds){const proof=await readOrdinarySteeringAuthority({bridge,binding:{...binding,commandId},signal,assertActive:identity,...attachmentOptions});if(!stable())return busy();if(proof.owner_id!==root.owner_id||proof.conversation_id!==root.conversation_id||proof.original_input_message_id!==root.input_message_id||proof.original_input_sha256!==root.input_sha256)fail();commands.push(proof);}
  const events=structuredClone(session.snapshotEvents(0));if(!Array.isArray(events)||events.length!==seq||events.some((e,i)=>e.seq!==i))fail();
  const end=events.findLast(e=>e.type==='turn/end'),start=events.findLast(e=>e.type==='turn/start');
  if(!end||!start||start.seq>end.seq)return busy();if(end.data?.reason?.kind!=='completed'||start.data?.turn!==end.data?.turn)fail();
  const answer=events.findLast(e=>e.type==='assistant/message'&&e.data?.turn===end.data.turn&&e.seq>start.seq&&e.seq<end.seq),parts=answer?.data?.message?.content;
  const text=Array.isArray(parts)?parts.map(p=>p.type==='text'&&typeof p.text==='string'?p.text:'').join('').trim():'';if(!text)fail();
  const wanted=[root,...commands],rpcIds=new Set(wanted.map(p=>p.request_id)),nativeIds=[];
  if(events.some(e=>e.type==='user/message'&&e.seq>start.seq&&e.data?.source?.kind==='user'&&!rpcIds.has(e.data.source.rpcId)))return busy();
  for(const proof of wanted){
   const matches=events.filter(e=>e.type==='user/message'&&e.data?.source?.kind==='user'&&e.data.source.rpcId===proof.request_id);if(matches.length===0)return busy();if(matches.length!==1||matches[0].seq>=answer.seq)fail();
   const message=matches[0].data,steering=proof.kind==='ordinary_steer'||proof.kind==='ordinary_steer_attachments',attachment=steering&&proof.protocol===2,stamp=await admissions.read({session,runId:binding.runId,messageId:message.id,signal});if(!stable())return busy();
   const expected={protocol:steering?(attachment?4:3):2,...(steering?{request_id:proof.request_id,original_input_message_id:proof.original_input_message_id,original_input_sha256:proof.original_input_sha256,command_sha256:proof.command_sha256,native_content_sha256:attachment?hash(JSON.stringify(message.content)):proof.native_content_sha256,...(attachment?{attachment_manifest_sha256:proof.attachment_manifest_sha256}:{})}:{}),run_id:proof.run_id,input_message_id:proof.input_message_id,conversation_id:proof.conversation_id,owner_id:proof.owner_id,session_id:proof.session_id,session_created_at:session.header.createdAt,input_sha256:proof.input_sha256,native_message_id:message.id,native_message_sha256:hash(canonical(message)),profile_fingerprint:reviewed.fingerprint};
   if(!isDeepStrictEqual(stamp,expected))fail();nativeIds.push(message.id);
  }
  for(const proof of commands){const current=await readOrdinarySteeringAuthority({bridge,binding:{...binding,commandId:proof.command_id},signal,assertActive:identity,...attachmentOptions});if(!isDeepStrictEqual(current,proof))fail();}
  if(!isDeepStrictEqual(await readOrdinaryInputAuthority({bridge,binding,signal,assertActive:identity}),root))fail();if(!stable())return busy();
  return{protocol:1,status:'complete',run_id:binding.runId,session_id:binding.sessionRef,execution_lease:structuredClone(binding.executionLease),input_sha256:root.input_sha256,command_ids:[...commandIds],native_message_ids:nativeIds,answer_sha256:hash(text),answer_seq:answer.seq,turn_end_seq:end.seq,snapshot_seq:seq,execution_authorized:false};
 };
}
