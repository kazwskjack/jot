import {sessionHeaderIdentity} from './session-header-identity.js'

export class SessionBindingConflict extends Error {}

// Conversation creation may mint a new id for a nonblank Session. The adapter's
// endpoint instead names one durable identity: inspect before activation, resume
// that exact identity, and create only when the official absence contract proves
// there is no saved Session. Keep this inside the claimed composer's scope.
export async function createOrResumeSession({controller,request,agents,sessions,sessionNotFoundError,signal,beforeAdmission}) {
  if(typeof controller.inspect!=='function'||typeof controller.resolveAgent!=='function')return controller.create(request)
  const {sessionId,cwd,agentPreset}=request
  const identity=sessionHeaderIdentity
  const checkHeader=header=>{
    if(header?.id!==sessionId||header.cwd!==cwd||agentPreset!==undefined&&header.agentPreset!==agentPreset)throw new SessionBindingConflict()
  }
  signal?.throwIfAborted()
  let saved,absent=false
  try{saved=await controller.inspect(sessionId,signal)}catch(error){
    if(error?.code!=='session/not-found'&&!(typeof sessionNotFoundError==='function'&&error instanceof sessionNotFoundError))throw error
    if(agents?.get?.(sessionId)||sessions?.get?.(sessionId))throw new SessionBindingConflict()
    absent=true
  }
  signal?.throwIfAborted()
  if(!absent){
    // Missing/malformed inspection is unavailable history, never native absence.
    if(!saved?.meta)throw Error('session_inspection_unavailable')
    checkHeader(saved.meta)
    const expected=identity(saved.meta),resident=agents?.get?.(sessionId),cached=sessions?.get?.(sessionId)
    if(resident&&(resident.id!==sessionId||resident.session?.id!==sessionId||identity(resident.session.header)!==expected)
      ||cached&&(cached.id!==sessionId||identity(cached.header)!==expected))throw new SessionBindingConflict()
    await beforeAdmission?.();signal?.throwIfAborted()
    const result=await controller.resolveAgent(sessionId)
    signal?.throwIfAborted()
    // A failed exact resume must never be repaired with conversation creation.
    if(result?.error)throw result.error
    const agent=result?.agent
    if(agent?.id!==sessionId||agent.session?.id!==sessionId||identity(agent.session.header)!==expected
      ||typeof agents?.get==='function'&&agents.get(sessionId)!==agent
      ||typeof sessions?.get==='function'&&sessions.get(sessionId)!==agent.session)throw new SessionBindingConflict()
    return{sessionId,...(agent.session.header.agentPreset===undefined?{}:{agentPreset:agent.session.header.agentPreset})}
  }
  await beforeAdmission?.();signal?.throwIfAborted()
  if(agents?.get?.(sessionId)||sessions?.get?.(sessionId))throw new SessionBindingConflict()
  const value=await controller.create(request)
  signal?.throwIfAborted()
  if(value?.sessionId!==sessionId)throw new SessionBindingConflict()
  const agent=agents?.get?.(sessionId)
  if(typeof agents?.get==='function'&&!agent)throw new SessionBindingConflict()
  if(agent){if(agent.id!==sessionId||agent.session?.id!==sessionId)throw new SessionBindingConflict();checkHeader(agent.session.header)
    if(typeof sessions?.get==='function'&&sessions.get(sessionId)!==agent.session)throw new SessionBindingConflict()}
  return value
}

