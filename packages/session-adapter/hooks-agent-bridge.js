import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const blocked = result => result.effects.find(effect => effect.type === 'block'
  || effect.type === 'permission_decision' && effect.behavior === 'deny'
  || effect.type === 'permission_request_result' && effect.result?.behavior === 'deny');
const reason = effect => typeof effect?.reason === 'string' ? effect.reason
  : typeof effect?.result?.message === 'string' ? effect.result.message : 'HOOK_BLOCKED';

/** Borrow native Agent event scopes. Hook execution authority remains with the Host port. */
export function createAgentHooksBridge({runtime,configuration,resolveSource,createUserMessage,readStopPayload}) {
  if (typeof runtime?.run !== 'function' || configuration?.protocol !== 1 || typeof resolveSource !== 'function') {
    throw new Error('hooks_agent_bridge_invalid');
  }
  const agents = new Map(), running = new AsyncLocalStorage();
  let closed = false;
  const configured = event => runtime.hasEvent(event);
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
    return {...result,scope:source.scope};
  }
  function additionalContexts(result,event,execution) {
    const effects = result.effects.filter(effect=>effect.type==='additional_context');
    if (!effects.length || typeof createUserMessage!=='function') return [];
    return effects.map(effect=>createUserMessage({
      source:{kind:'jot-hooks',form:'notice',summary:'Hook context after tool execution',
        ...result.scope,hook_event:event,hook_name:effect.source,tool_call_id:execution.callId,
        content_sha256:createHash('sha256').update(effect.content,'utf8').digest('hex')},
      content:[{type:'text',text:effect.content}],
    }));
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
      disposers.push(agentCtx.on('tools/pre-execute',async(exec,next)=>{
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
      disposers.push(agentCtx.on('tools/post-execute',async(exec,outcome,next)=>{
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
        let contexts;
        try {contexts = [...(decision.additionalContexts??[]),...additionalContexts(result,event,exec)];}
        catch {return decision;}
        const refusal = blocked(result);
        if (refusal) return {kind:'block',feedback:[{type:'text',text:'Hook blocked the result after tool dispatch. Recover the original operation before repeating an effect. '+reason(refusal)}],
          ...(contexts.length?{additionalContexts:contexts}:{})};
        // The native scheduler commits these contexts with the original result.
        // Preserve the structured value, content projection and execution receipt.
        return contexts.length ? {...decision,additionalContexts:contexts} : decision;
      }));
      disposers.push(agentCtx.on('agent/pre-step',async(event,next)=>{
        if (event.agent !== agent || !configured('UserPromptSubmit')) return next();
        const messages = event.messages.filter(message=>message.source?.kind==='user');
        if (!messages.length) return next();
        const prompt = messages.flatMap(message=>message.content.filter(block=>block.type==='text').map(block=>block.text)).join('\n');
        const result = await invoke(agent,'UserPromptSubmit',{prompt,turn:event.turn,step:event.step},event.signal);
        if (result && blocked(result)) return {kind:'reject'};
        return next();
      },{prepend:true}));
      disposers.push(agentCtx.on('agent/request',async(event,next)=>{
        const request = await next();
        if (event.agent !== agent) return request;
        const result = await invoke(agent,'PreModelRequest',{provider:request.provider,model:request.model,turn:event.turn,step:event.step},event.signal);
        if (result && blocked(result)) throw new Error('HOOK_MODEL_REQUEST_BLOCKED');
        return request;
      }));
      disposers.push(agentCtx.on('agent/turn-stopping',async event=>{
        if (event.agent!==agent || !configured('Stop') || closed || running.getStore()?.has(agent)) return;
        if (!await resolveSource(agent,event.signal)) return;
        if (typeof readStopPayload!=='function') throw new Error('hook_stop_source_unavailable');
        const payload = await readStopPayload(agent,event.turn,event.signal);
        const result = await invoke(agent,'Stop',payload,event.signal);
        const refusal = result && blocked(result);
        // Upstream Stop refusal is a terminal lifecycle failure. The native
        // turn owner records that error and closes its original turn boundary.
        if (refusal) throw Object.assign(new Error(reason(refusal)),{code:'HOOK_STOP_BLOCKED'});
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
