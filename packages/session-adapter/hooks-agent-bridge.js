import {AsyncLocalStorage} from 'node:async_hooks';
import {isDeepStrictEqual} from 'node:util';

const blocked = result => result.effects.find(effect => effect.type === 'block'
  || effect.type === 'permission_decision' && effect.behavior === 'deny'
  || effect.type === 'permission_request_result' && effect.result?.behavior === 'deny');
const reason = effect => typeof effect?.reason === 'string' ? effect.reason
  : typeof effect?.result?.message === 'string' ? effect.result.message : 'HOOK_BLOCKED';

/** Borrow native Agent event scopes. Hook execution authority remains with the Host port. */
export function createAgentHooksBridge({runtime,configuration,resolveSource}) {
  if (typeof runtime?.run !== 'function' || configuration?.protocol !== 1 || typeof resolveSource !== 'function') {
    throw new Error('hooks_agent_bridge_invalid');
  }
  const agents = new Map(), running = new AsyncLocalStorage();
  let closed = false;
  const configured = event => configuration.settings[event]?.some(matcher => matcher.hooks.length) === true;
  async function invoke(agent,event,payload,signal,execution) {
    if (closed || running.getStore()?.has(agent) || !configured(event)) return null;
    const source = await resolveSource(agent,signal);
    if (!source) return null;
    const header = agent.session?.header;
    if (source.agent !== agent || source.scope.session_ref !== agent.id || agent.session?.id !== agent.id
      || typeof header?.cwd !== 'string' || typeof source.assertCurrent !== 'function') throw new Error('hook_native_context_invalid');
    await source.assertCurrent(signal);
    const ancestors = new Set(running.getStore()); ancestors.add(agent);
    const context = Object.freeze({...source,event,execution});
    const result = await running.run(ancestors, () => runtime.run({
      event,base:{sessionId:agent.id,transcriptPath:'',cwd:header.cwd,agentId:source.scope.agent_id},
      payload:{...payload,transcriptAvailable:false},matchQuery:payload.toolName??event,context,signal,
    }));
    await source.assertCurrent(signal);
    return result;
  }
  function setup(agentCtx,agent) {
    if (closed) throw new Error('hooks_agent_bridge_closed');
    if (agents.has(agent)) return;
    if (typeof agentCtx?.on !== 'function' || typeof agentCtx?.effect !== 'function') throw new Error('hook_native_context_invalid');
    const disposers = [];
    const dispose = () => {
      if (!agents.delete(agent)) return;
      for (const remove of disposers.splice(0).reverse()) remove();
    };
    agents.set(agent,dispose);
    try {
      if (configured('PreToolUse')) disposers.push(agentCtx.on('tools/pre-execute',async(exec,next)=>{
        const decision = await next();
        if (exec.agent !== agent || ['deny','cancel'].includes(decision.kind)) return decision;
        const result = await invoke(agent,'PreToolUse',{toolName:exec.name,toolInput:exec.arguments,toolUseId:exec.callId},exec.signal,exec);
        if (!result) return decision;
        const refusal = blocked(result);
        if (refusal) return {kind:'deny',reason:reason(refusal)};
        const update = result.effects.find(effect=>effect.type==='updated_tool_input');
        const permissionUpdate = result.effects.find(effect=>effect.type==='permission_request_result'&&effect.result?.updatedInput)?.result.updatedInput;
        if (update && !isDeepStrictEqual(update.input,exec.arguments)
          || permissionUpdate && !isDeepStrictEqual(permissionUpdate,exec.arguments)) {
          return {kind:'deny',reason:'HOOK_INPUT_UPDATE_REQUIRES_NEW_CALL',info:{
            name:'HookInputUpdateRequired',code:'HOOK_INPUT_UPDATE_REQUIRES_NEW_CALL',
            reason:JSON.stringify({proposed_input:update?.input??permissionUpdate})
          }};
        }
        const ask = result.effects.find(effect=>effect.type==='permission_decision'&&effect.behavior==='ask');
        if (decision.kind === 'allow' && ask) return {kind:'ask',reason:reason(ask)};
        return decision;
      }));
      if (configured('PostToolUse') || configured('PostToolUseFailure')) disposers.push(agentCtx.on('tools/post-execute',async(exec,outcome,next)=>{
        const decision = await next();
        if (exec.agent !== agent || decision.kind === 'block') return decision;
        const event = outcome.isError ? 'PostToolUseFailure' : 'PostToolUse';
        let result;
        try {
          result = await invoke(agent,event,{toolName:exec.name,toolInput:exec.arguments,toolUseId:exec.callId,
            ...(outcome.isError?{error:outcome.error.message,isInterrupt:['ABORTED','ABORTED_BEFORE_DISPATCH'].includes(outcome.error.info?.code)}
              :{toolResponse:outcome.value??outcome.content})},exec.signal,exec);
        } catch {return decision;}
        if (!result) return decision;
        const refusal = blocked(result);
        if (refusal) return {kind:'block',feedback:[{type:'text',text:'Hook blocked the result after tool dispatch. Recover the original operation before repeating an effect. '+reason(refusal)}]};
        // Preserve the original structured outcome and execution receipt. Projection
        // updates require the native content/finalization boundary in the effect adapter.
        return decision;
      }));
      if (configured('UserPromptSubmit')) disposers.push(agentCtx.on('agent/pre-step',async(event,next)=>{
        if (event.agent !== agent) return next();
        const messages = event.messages.filter(message=>message.source?.kind==='user');
        if (!messages.length) return next();
        const prompt = messages.flatMap(message=>message.content.filter(block=>block.type==='text').map(block=>block.text)).join('\n');
        const result = await invoke(agent,'UserPromptSubmit',{prompt,turn:event.turn,step:event.step},event.signal);
        if (result && blocked(result)) return {kind:'reject'};
        return next();
      },{prepend:true}));
      if (configured('PreModelRequest')) disposers.push(agentCtx.on('agent/request',async(event,next)=>{
        const request = await next();
        if (event.agent !== agent) return request;
        const result = await invoke(agent,'PreModelRequest',{provider:request.provider,model:request.model,turn:event.turn,step:event.step},event.signal);
        if (result && blocked(result)) throw new Error('HOOK_MODEL_REQUEST_BLOCKED');
        return request;
      }));
      agentCtx.effect(()=>dispose,'jotAgentHooksBridge()');
    } catch (error) {dispose();throw error;}
  }
  return Object.freeze({
    setup,
    close() {
      if (closed) return;
      closed = true;
      for (const dispose of [...agents.values()]) dispose();
    },
  });
}
