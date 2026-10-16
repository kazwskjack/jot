import {isDeepStrictEqual} from 'node:util';
import {normalizeHostExecutionLease} from './workbench.js';
import {readOrdinaryInputAuthority} from './ordinary-input-resume.js';
import {createNativeClaimedInputRecoverySetup} from './native-claimed-input.js';
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=()=>{throw Error('ordinary_claimed_input_unconfirmed');};
/** Trusted unpublished-factory setup only. Restores admitted original input;
 * never opens a Session, publishes an Agent, grants execution or wakes a driver.
 * Admissions must come from a separately audited original prompt-admission path,
 * not be inferred or created from the current cold message during recovery. */
export function createOrdinaryClaimedInputRecoverySetup({binding,bridge,ordinaryPresets,profile,admissions,signal,...native}={}){
 if(!binding||Object.keys(binding).sort().join(',')!=='executionLease,runId,sessionRef'||!valid(binding.runId)||!valid(binding.sessionRef)||typeof bridge?.request!=='function'||!(ordinaryPresets instanceof Set)||!ordinaryPresets.size||typeof profile?.read!=='function'||admissions?.entryReservationProtocol!==1||typeof admissions.readReplayCandidate!=='function')fail();
 let lease;try{lease=normalizeHostExecutionLease(binding.executionLease);}catch{fail();}
 const owned=freeze({runId:binding.runId,sessionRef:binding.sessionRef,executionLease:lease}),results=new WeakMap(),used=new WeakSet();
 const setup=async(ctx,agent)=>{
  if(used.has(agent))fail();used.add(agent);let original,reviewed,approved=[];
  const check=()=>{signal?.throwIfAborted();const header=agent?.session?.header;
   if(agent?.id!==owned.sessionRef||agent.session?.id!==owned.sessionRef||agent.status!=='idle'||native.agents?.get(agent.id)!==undefined||native.sessions?.get(agent.id)!==undefined||!header||!Number.isSafeInteger(header.createdAt)||header.createdAt<0||!ordinaryPresets.has(header.agentPreset)||header.parentSession!==undefined||header.origin==='subagent')fail();
   const goal=native.projections.snapshot(agent.session,['goal'])?.values?.goal;
   if(goal!=null&&(!valid(goal.goal?.id)||!['active','complete'].includes(goal.goal?.phase)))fail();
  };
  const readProfile=async()=>{check();const current=await profile.read({presetId:agent.session.header.agentPreset,agent,phase:'prepared',signal});check();
   if(!current||Object.keys(current).sort().join(',')!=='audit_id,fingerprint,preset_id,profile_id,protocol'||current.protocol!==1||!valid(current.profile_id)||!valid(current.audit_id)||current.preset_id!==agent.session.header.agentPreset||!hash(current.fingerprint))fail();
   if(reviewed&&!isDeepStrictEqual(current,reviewed))fail();reviewed??=freeze(structuredClone(current));
  };
  const verifyAdmissions=async candidates=>{for(const candidate of candidates){
   check();if(candidate.source?.kind!=='user'||candidate.source.rpcId!==owned.runId||!valid(candidate.message_id)||!hash(candidate.message_sha256)||!['next-step','next-turn'].includes(candidate.target))fail();
   const row=await admissions.readReplayCandidate({session:agent.session,runId:owned.runId,messageId:candidate.message_id,signal});check();
   const expected={protocol:2,run_id:original.run_id,input_message_id:original.input_message_id,conversation_id:original.conversation_id,owner_id:original.owner_id,session_id:original.session_id,session_created_at:agent.session.header.createdAt,input_sha256:original.input_sha256,native_message_id:candidate.message_id,native_message_sha256:candidate.message_sha256,profile_fingerprint:reviewed.fingerprint};
   if(!isDeepStrictEqual(row,expected))fail();
  }};
  const authorize=async()=>{check();const current=await readOrdinaryInputAuthority({bridge,binding:owned,signal,assertActive:check});check();
   if(original&&!isDeepStrictEqual(current,original))fail();original??=current;await readProfile();await verifyAdmissions(approved);if(!isDeepStrictEqual(await readOrdinaryInputAuthority({bridge,binding:owned,signal,assertActive:check}),original))fail();check();return {authorized:true};
  };
  const recovery=createNativeClaimedInputRecoverySetup({...native,signal,authorize,
   confirmReplaySafety:async({candidates})=>{await authorize();approved=freeze(structuredClone(candidates));await verifyAdmissions(approved);return {safe:true};}});
  await recovery(ctx,agent);check();results.set(agent,recovery.resultFor(agent));
 };
 setup.resultFor=agent=>results.get(agent);return setup;
}
