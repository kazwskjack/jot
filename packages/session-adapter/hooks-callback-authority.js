import {AsyncLocalStorage} from 'node:async_hooks';
import {isDeepStrictEqual} from 'node:util';
import {dshProfilePluginActionSha256 as sha256} from './dsh-profile-plugin-operation.js';
import {parseHookOutput} from './hooks-protocol.js';

const toolEvents = new Set(['PreToolUse','PostToolUse','PostToolUseFailure']);
const turnEvents = new Set(['UserPromptSubmit','PreModelRequest']);
const unavailable = code => ({outcome:'non_blocking_error',stdout:'',stderr:code,exitCode:1});

function normalize(value,event) {
  if (value === undefined) value = '';
  let stdout;
  if (typeof value === 'string') stdout = value;
  else if (value && ['sync','async'].includes(value.type)) {
    stdout = JSON.stringify({...value,async:value.type==='async',hookSpecificOutput:value.specific});
  } else throw new Error('hook_callback_result_invalid');
  const output = parseHookOutput(stdout,event);
  return JSON.parse(JSON.stringify({outcome:'success',stdout,stderr:'',exitCode:0,output}));
}

/** Only trusted native modules can register functions. Gateway owns durable dispatch. */
export function createHookCallbackAuthority({runtime,bridge,readAgent,readIdentity,approvalForAgent}) {
  const entries = new Map(), jobs = new Map(), lineage = new AsyncLocalStorage();
  const lifetime = new AbortController();
  let closed = false, closing;
  function register(declaration,handler) {
    if (closed || !declaration || typeof declaration !== 'object' || Array.isArray(declaration)
      || Object.keys(declaration).some(key=>!['event','name','matcher','if','statusMessage'].includes(key))
      || typeof declaration.event !== 'string' || typeof declaration.name !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(declaration.name) || typeof handler !== 'function'
      || ['matcher','if','statusMessage'].some(key=>declaration[key]!==undefined
        && (typeof declaration[key]!=='string'||declaration[key].length>4096))) throw new Error('hook_callback_invalid');
    const descriptor = JSON.parse(JSON.stringify(declaration));
    const key = `${descriptor.event}/${descriptor.name}`;
    if (entries.has(key)) throw new Error('hook_callback_duplicate');
    const removeMatcher = runtime.registerCallbackMatcher(descriptor);
    const entry = {descriptor,handler,removeMatcher,controller:new AbortController(),hookId:sha256(descriptor)};
    entries.set(key,entry);
    return () => {
      if (entries.get(key)!==entry) return;
      entries.delete(key);removeMatcher();entry.controller.abort(new Error('hook_callback_removed'));
    };
  }
  async function execute(input,entry,signal) {
    const {event,hookInput,context} = input, agent = context?.agent;
    const key = `${event}/${entry.descriptor.name}`;
    const identity = readIdentity();
    async function current() {
      signal.throwIfAborted();
      if (closed || entries.get(key)!==entry || !agent || readAgent(agent.id)!==agent
        || !isDeepStrictEqual(readIdentity(),identity)) throw new Error('hook_original_binding_changed');
      const source = await bridge.hooksSource(agent,signal);
      if (!source || source.binding!==context.binding || !isDeepStrictEqual(source.scope,context.scope)
        || source.scope.owner_id!==identity.ownerId || hookInput.sessionId!==agent.session?.id
        || hookInput.agentId!==source.scope.agent_id || hookInput.cwd!==agent.session?.header?.cwd
        || hookInput.hookEventName!==event) throw new Error('hook_original_binding_changed');
      await source.assertCurrent(signal);
      signal.throwIfAborted();
      if (readAgent(agent.id)!==agent || entries.get(key)!==entry
        || !isDeepStrictEqual(readIdentity(),identity)) throw new Error('hook_original_binding_changed');
      return source;
    }
    const source = await current();
    let eventIdentity;
    if (toolEvents.has(event)) {
      const execution = context.execution;
      if (execution?.agent!==agent || typeof execution.token!=='symbol'
        || typeof execution.callId!=='string' || execution.callId!==hookInput.toolUseId
        || execution.name!==hookInput.toolName || !isDeepStrictEqual(execution.arguments,hookInput.toolInput)) {
        throw new Error('hook_native_context_invalid');
      }
      eventIdentity = execution.callId;
    } else if (turnEvents.has(event) && Number.isSafeInteger(hookInput.turn) && hookInput.turn>=0
      && Number.isSafeInteger(hookInput.step) && hookInput.step>=0) {
      eventIdentity = [hookInput.turn,hookInput.step];
    } else return unavailable('hook_native_event_unavailable');
    const operation = await bridge.request('hook-prepare',source.binding,{
      hook_id:entry.hookId,event,event_id:sha256([source.scope.run_id,event,eventIdentity]),
      request_hash:sha256(hookInput),
    },signal);
    if (!/^hook-op-[a-f0-9-]{36}$/.test(operation?.operation_id??'')) throw new Error('hook_operation_invalid');
    if (operation.state==='settled') {
      await current();
      return operation.result;
    }
    if (operation.state!=='prepared'||operation.reserved!==true) return unavailable('hook_operation_'+operation.state);
    const settle = (state,result) => bridge.request('hook-settle',source.binding,{
      operation_id:operation.operation_id,state,...(result===undefined?{}:{result}),
    });
    let granted = false;
    try {
      const approval = approvalForAgent(agent);
      if (typeof approval?.request==='function') {
        granted = await approval.request({agent,toolName:'jot_hook_callback',
          ...(context.execution?{callId:context.execution.callId}:{}),
          reason:`Run Hook callback ${entry.descriptor.name} for ${event}.`,signal}) === 'allowed-once';
      }
      if (!granted) {
        await settle('rejected');
        return unavailable('hook_callback_not_approved');
      }
      await current();
    } catch (error) {
      await settle('rejected').catch(()=>{});
      throw error;
    }
    let dispatched;
    try {
      dispatched = await bridge.request('hook-dispatch',source.binding,{operation_id:operation.operation_id},signal);
      if (dispatched.operation_id!==operation.operation_id || dispatched.state!=='dispatched'
        || dispatched.dispatch!==true) throw new Error('hook_dispatch_unconfirmed');
    } catch (error) {
      // A lost dispatch response never becomes a second grant through readback.
      await settle('unknown').catch(()=>{});
      throw error;
    }
    let result;
    try {
      await current();
      result = normalize(await entry.handler({hookInput:structuredClone(hookInput),signal}),event);
      if (Buffer.byteLength(JSON.stringify(result),'utf8')>2*1024*1024) throw new Error('hook_result_too_large');
    } catch (error) {
      await settle('unknown').catch(()=>{});
      throw error;
    }
    // Preserve a known result even if the original execution has since been cancelled.
    const settled = await settle('settled',result);
    if (settled.operation_id!==operation.operation_id || settled.state!=='settled'
      || !isDeepStrictEqual(settled.result,result)) throw new Error('hook_settlement_unconfirmed');
    await current();
    return result;
  }
  return Object.freeze({
    register,
    executeAuthorizedHook(input) {
      if (closed) return Promise.reject(new Error('hook_callback_authority_closed'));
      if (input.hook?.type!=='callback') return Promise.resolve(unavailable('hook_executor_unavailable'));
      const entry = entries.get(`${input.event}/${input.hook.name}`);
      if (!entry) return Promise.resolve(unavailable('hook_callback_unavailable'));
      const signal = AbortSignal.any([lifetime.signal,entry.controller.signal,...(input.signal?[input.signal]:[])]);
      const token = {}, ancestors = new Set(lineage.getStore()); ancestors.add(token);
      const job = lineage.run(ancestors,()=>execute(input,entry,signal));
      jobs.set(token,job);
      job.then(()=>jobs.delete(token),()=>jobs.delete(token));
      return job;
    },
    close() {
      if (!closing) {
        closed = true;lifetime.abort(new Error('hook_callback_authority_closed'));
        for (const entry of entries.values()) entry.removeMatcher();
        const current = lineage.getStore();
        closing = Promise.allSettled([...jobs].filter(([token])=>!current?.has(token)).map(([,job])=>job))
          .then(()=>{entries.clear();});
      }
      return closing;
    },
  });
}
