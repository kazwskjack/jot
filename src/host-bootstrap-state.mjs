import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';

const token=()=>randomBytes(32).toString('base64url');
const digest=value=>createHash('sha256').update(value,'utf8').digest('hex');
const opaque=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const constantEqual=(left,right)=>{
  const a=Buffer.from(left,'hex'),b=Buffer.from(right,'hex');
  return a.length===b.length&&timingSafeEqual(a,b);
};

export function createHostBootstrapStateStore({
  now=()=>Date.now(),
  challengeLifetimeMs=90_000,
  contextLifetimeMs=300_000,
  maxChallenges=64,
  maxContexts=64,
  maxUsedStates=256
}={}){
  if(typeof now!=='function'||!Number.isSafeInteger(challengeLifetimeMs)||challengeLifetimeMs<1||challengeLifetimeMs>90_000
    ||!Number.isSafeInteger(contextLifetimeMs)||contextLifetimeMs<1||contextLifetimeMs>300_000
    ||![maxChallenges,maxContexts,maxUsedStates].every(value=>Number.isSafeInteger(value)&&value>0&&value<=4096))throw new TypeError('host_bootstrap_store_config_invalid');
  const challenges=new Map(),usedStates=new Map(),contexts=new Map();
  function time(){try{const value=now();return Number.isSafeInteger(value)&&value>=0?value:undefined;}catch{return undefined;}}
  function reap(current){for(const map of [challenges,usedStates,contexts])for(const [key,value] of map)if(value.expiresAt<=current)map.delete(key);}
  function createChallenge(){
    const current=time();if(current===undefined)return{ok:false,reason:'clock_unavailable'};reap(current);
    if(challenges.size>=maxChallenges)return{ok:false,reason:'challenge_capacity'};
    const state=token(),pendingHandle=token(),stateHash=digest(state),key=digest(pendingHandle),expiresAt=current+challengeLifetimeMs;
    if(!Number.isSafeInteger(expiresAt)||usedStates.has(stateHash)||challenges.has(key))return{ok:false,reason:'challenge_unavailable'};
    challenges.set(key,{stateHash,expiresAt});
    return{ok:true,state,pendingHandle,expiresAt};
  }
  function consumeChallenge({pendingHandle,state}={}){
    const current=time();if(current===undefined)return{ok:false,reason:'clock_unavailable'};reap(current);
    if(!opaque(pendingHandle)||!opaque(state))return{ok:false,reason:'challenge_invalid'};
    const key=digest(pendingHandle),entry=challenges.get(key),stateHash=digest(state);
    if(!entry||!constantEqual(entry.stateHash,stateHash)||usedStates.has(stateHash))return{ok:false,reason:'challenge_invalid'};
    if(usedStates.size>=maxUsedStates)return{ok:false,reason:'challenge_capacity'};
    challenges.delete(key);
    usedStates.set(stateHash,{expiresAt:current+challengeLifetimeMs});
    return{ok:true};
  }
  function storeContext({ticket,expiresAt}={}){
    const current=time();if(current===undefined)return{ok:false,reason:'clock_unavailable'};reap(current);
    if(!opaque(ticket)||!Number.isSafeInteger(expiresAt)||expiresAt<=current||expiresAt>current+contextLifetimeMs)return{ok:false,reason:'context_invalid'};
    if(contexts.size>=maxContexts)return{ok:false,reason:'context_capacity'};
    const handle=token(),key=digest(handle);
    if(contexts.has(key))return{ok:false,reason:'context_unavailable'};
    contexts.set(key,{ticket,expiresAt});
    return{ok:true,handle,expiresAt};
  }
  function getContext(handle){
    const current=time();if(current===undefined)return{ok:false,reason:'clock_unavailable'};reap(current);
    if(!opaque(handle))return{ok:false,reason:'context_invalid'};
    const entry=contexts.get(digest(handle));
    return entry?{ok:true,ticket:entry.ticket,expiresAt:entry.expiresAt}:{ok:false,reason:'context_invalid'};
  }
  function deleteContext(handle){if(!opaque(handle))return false;return contexts.delete(digest(handle));}
  return Object.freeze({createChallenge,consumeChallenge,storeContext,getContext,deleteContext});
}
