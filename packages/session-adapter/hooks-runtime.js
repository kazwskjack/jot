// Adapted from PilotDeck revision 783499ffdb2d501bf590b2e035acd027a882df10.
// See runtime-patches/PILOTDECK-AGPL-3.0.txt for the upstream GNU AGPL v3 license.
import {Script} from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHookInput,toLegacyHookInput,parseHookOutput,hookEffects} from './hooks-protocol.js';

const regexMatch = new Script('new RegExp(pattern).test(query)');
function match(matcher, query) {
  if (!matcher || matcher === '*') return true;
  if (!query) return false;
  const alternatives = matcher.split('|').map(part=>part.trim()).filter(Boolean);
  if (alternatives.length > 1) return alternatives.some(value=>match(value,query));
  if (matcher.startsWith('/') && matcher.endsWith('/') && matcher.length > 2) {
    // Operator patterns are evaluated against event data with a bounded computation window.
    try {return regexMatch.runInNewContext({pattern:matcher.slice(1,-1),query},{timeout:25}) === true;} catch {return false;}
  }
  return matcher === query;
}
function condition(value, input) {
  if (!value) return true;
  const parsed = /^([A-Za-z0-9_.:-]+)(?:\((.*)\))?$/.exec(value.trim());
  if (!parsed || typeof input.toolName !== 'string') return false;
  const normalize = name => name.replace(/[^A-Za-z0-9]/g,'').toLowerCase();
  if (normalize(parsed[1]) !== normalize(input.toolName)) return false;
  return !parsed[2] || parsed[2] === '*' || JSON.stringify(input.toolInput??{}).includes(parsed[2].replace(/\*/g,''));
}

/** Native executor ports own authorization, budgets, effects and durable operation recovery. */
export function createHooksRuntime({configuration,resolveExecutor}) {
  if (configuration?.protocol !== 1 || typeof resolveExecutor !== 'function') throw new Error('hooks_runtime_invalid');
  const lifetime = new AbortController(), jobs = new Map(), lineage = new AsyncLocalStorage();
  let closed = false, closing;
  async function run(input) {
    input.signal.throwIfAborted();
    const hookInput = createHookInput(input.event,input.base,input.payload);
    if (input.matchQuery !== undefined && (typeof input.matchQuery !== 'string' || input.matchQuery.length > 4096)) throw new Error('hook_match_query_invalid');
    const effects=[],events=[],blockingErrors=[],nonBlockingErrors=[],pendingAsync=[];
    for (const matcher of configuration.settings[input.event] ?? []) {
      input.signal?.throwIfAborted();
      if (!match(matcher.matcher,input.matchQuery)) continue;
      for (const hook of matcher.hooks) {
        if (!condition(hook.if,hookInput)) continue;
        input.signal?.throwIfAborted();
        const hookName = matcher.pluginName ? `${matcher.pluginName}:${hook.type}` : hook.type;
        const executor = resolveExecutor();
        if (typeof executor?.executeAuthorizedHook !== 'function') {
          nonBlockingErrors.push({code:'hook_executor_unavailable',hookName}); continue;
        }
        events.push({type:'started',hookName,hookEvent:input.event});
        let result, output;
        try {
          result = await executor.executeAuthorizedHook({event:input.event,hook:structuredClone(hook),
            hookInput:structuredClone(hookInput),legacyHookInput:toLegacyHookInput(hookInput),
            pluginRoot:matcher.pluginRoot,context:input.context,signal:input.signal,
            timeoutMs:input.event==='SessionEnd'?1500:600000});
          input.signal.throwIfAborted();
          if (!result || !['success','blocking','non_blocking_error','cancelled','timeout'].includes(result.outcome)
            || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
            || result.exitCode !== undefined && !Number.isInteger(result.exitCode)
            || Buffer.byteLength(result.stdout,'utf8')>1024*1024 || Buffer.byteLength(result.stderr,'utf8')>1024*1024
            || result.output !== undefined && (!result.output || !['sync','async'].includes(result.output.type))) throw new Error('hook_result_invalid');
          output = result.output === undefined ? parseHookOutput(result.stdout,input.event)
            : parseHookOutput(JSON.stringify({...result.output,async:result.output.type==='async',hookSpecificOutput:result.output.specific}),input.event);
        } catch {
          nonBlockingErrors.push({code:input.signal?.aborted?'hook_cancelled':'hook_execution_unknown',hookName});
          if (input.signal?.aborted) input.signal.throwIfAborted();
          continue;
        }
        events.push({type:'response',hookName,hookEvent:input.event,stdout:result.stdout,stderr:result.stderr,exitCode:result.exitCode,outcome:result.outcome});
        if (output.type === 'async') pendingAsync.push({hookName,hookEvent:input.event,asyncRewake:hook.type==='command'&&hook.asyncRewake===true});
        if (result.outcome === 'blocking') {
          const message = result.stderr || result.stdout || 'Hook blocked execution.';
          blockingErrors.push({code:'hook_blocking_error',message,hookName,exitCode:result.exitCode});
          effects.push({type:'block',reason:message});
        } else if (['non_blocking_error','timeout','cancelled'].includes(result.outcome)) {
          nonBlockingErrors.push({code:result.outcome==='cancelled'?'hook_cancelled':'hook_non_blocking_error',
            message:result.stderr||result.stdout||`Hook ended with outcome ${result.outcome}.`,hookName,exitCode:result.exitCode});
        }
        effects.push(...hookEffects(output,hookName));
      }
    }
    return {effects,events,blockingErrors,nonBlockingErrors,pendingAsync,execution_authorized:false};
  }
  return Object.freeze({
    run(input) {
      if (closed) return Promise.reject(new Error('hooks_runtime_closed'));
      if (!input || typeof input !== 'object') return Promise.reject(new Error('hook_input_invalid'));
      const signal = AbortSignal.any([lifetime.signal, ...(input.signal ? [input.signal] : [])]);
      const token = {}, ancestors = new Set(lineage.getStore());
      ancestors.add(token);
      const job = lineage.run(ancestors, () => run({...input,signal}));
      jobs.set(token,job);
      job.then(() => jobs.delete(token), () => jobs.delete(token));
      return job;
    },
    close() {
      if (!closing) {
        closed = true;
        lifetime.abort(new Error('hooks_runtime_closed'));
        // An unload triggered by a Hook cannot wait for its own suspended caller chain.
        const current = lineage.getStore();
        closing = Promise.allSettled([...jobs].filter(([token]) => !current?.has(token)).map(([,job]) => job)).then(() => undefined);
      }
      return closing;
    },
  });
}
