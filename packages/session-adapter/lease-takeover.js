const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const SCOPE_KEYS='kind,lease_generation,lease_owner,owner_id,protocol,run_id,session_id,workspace_id'

export function normalizeLeaseTakeoverRequest(value,sessionId){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==`kind,lease_generation,lease_owner,owner_id,protocol,purpose,run_id,session_id,workspace_id`
    ||value.purpose!=='lease_takeover')throw Error('lease_takeover_input_invalid')
  const scope={protocol:value.protocol,kind:value.kind,run_id:value.run_id,owner_id:value.owner_id,workspace_id:value.workspace_id,
    session_id:value.session_id,lease_owner:value.lease_owner,lease_generation:value.lease_generation}
  if(Object.keys(scope).sort().join(',')!==SCOPE_KEYS||scope.protocol!==1||scope.kind!=='lease_takeover'||scope.session_id!==sessionId
    ||['run_id','owner_id','workspace_id','session_id','lease_owner'].some(key=>typeof scope[key]!=='string'||!ID.test(scope[key]))
    ||!Number.isSafeInteger(scope.lease_generation)||scope.lease_generation<1)throw Error('lease_takeover_input_invalid')
  return Object.freeze(scope)
}

const response=(scope,status,settled)=>Object.freeze({protocol:1,kind:'lease_takeover',scope,status,settled,execution_authorized:false})

export async function settleLeaseTakeover({agent,agents,controller,bridge,scope,signal}){
  const unknown=()=>response(scope,'unknown',false)
  try{
    signal?.throwIfAborted()
    const agentContext=agent?.ctx,agentSession=agent?.session
    if(!scope||Object.keys(scope).sort().join(',')!==SCOPE_KEYS||!agent||typeof agents?.get!=='function'
      ||agents.get(scope.session_id)!==agent||agent.id!==scope.session_id||typeof agent.whenIdle!=='function'
      ||typeof bridge?.matchesBrowserTakeover!=='function'||!bridge.matchesBrowserTakeover(agent,scope)
      ||typeof bridge.observeBrowserQuiescence!=='function')return unknown()
    const stopped=await controller.cancel({sessionId:scope.session_id})
    if(stopped?.accepted!==true||agents.get(scope.session_id)!==agent||agent.ctx!==agentContext||agent.session!==agentSession||!bridge.matchesBrowserTakeover(agent,scope))return unknown()
    await agent.whenIdle()
    signal?.throwIfAborted()
    if(agents.get(scope.session_id)!==agent||agent.ctx!==agentContext||agent.session!==agentSession||agent.status!=='idle'||!bridge.matchesBrowserTakeover(agent,scope))return unknown()
    const proof=await bridge.observeBrowserQuiescence(agent,scope,signal)
    signal?.throwIfAborted()
    if(agents.get(scope.session_id)!==agent||agent.ctx!==agentContext||agent.session!==agentSession||!bridge.matchesBrowserTakeover(agent,scope)||!proof
      ||proof.protocol!==1||proof.execution_authorized!==false||!['quiescent','outcome_unknown','unknown'].includes(proof.status))return unknown()
    return proof.status==='quiescent'?response(scope,'quiescent',true)
      :proof.status==='outcome_unknown'?response(scope,'outcome_unknown',true):unknown()
  }catch{return unknown()}
}
