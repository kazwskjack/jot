import { randomUUID } from 'node:crypto';

/** Serialize one Session's main and auxiliary streams, without bypassing ledger guards. */
export class BudgetedModelStreamQueue {
  constructor(){this.tail=Promise.resolve();}
  async *run(signal,stream,{ready}={}){
    signal?.throwIfAborted();
    // Auxiliary readiness must happen before acquiring a slot: waiting for
    // Agent idle inside the queue would block the main turn's next step.
    if(ready){
      let abortReady;
      try{
        const prepared=Promise.resolve(ready());
        if(signal){
          const cancelled=new Promise((_,reject)=>{abortReady=()=>reject(signal.reason??new Error('model_stream_cancelled'));signal.addEventListener('abort',abortReady,{once:true});if(signal.aborted)abortReady();});
          await Promise.race([prepared,cancelled]);
        }else await prepared;
      }finally{if(abortReady)signal.removeEventListener('abort',abortReady);}
      signal?.throwIfAborted();
    }
    const prior=this.tail;let release;
    const slot=new Promise(resolve=>release=resolve);
    this.tail=prior.catch(()=>{}).then(()=>slot);
    let abort;
    try{
      if(signal){
        const cancelled=new Promise((_,reject)=>{abort=()=>reject(signal.reason??new Error('model_stream_cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
        await Promise.race([prior,cancelled]);
      }else await prior;
      signal?.throwIfAborted();
      for await(const chunk of stream())yield chunk;
    }finally{
      if(abort)signal.removeEventListener('abort',abort);
      release();
    }
  }
}

/** Scoped llm/stream middleware. GenerateOptions remain the SDK's frozen request. */
export async function* budgetedModelStream({ binding, options, next, request, check }) {
  if (!binding || options?.sessionId !== binding.sessionRef) throw new Error('workbench_budget_session_mismatch');
  options.signal?.throwIfAborted();
  await check(options.signal);
  options.signal?.throwIfAborted();
  const attemptId = `model-${randomUUID()}`;
  const body = { attempt_id: attemptId, provider: options.provider, model: options.model,
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }) };
  let reserveAttempted = false, dispatchAttempted = false, settled = false, reason = 'stream_incomplete';
  const call = async (action, payload = {}) => {
    // Closing a stream or cancelling a task must not cancel its accounting.
    // Gateway authentication and its own transport deadline still apply.
    const response = await request('model-budget', binding, { action, ...payload });
    if (!response?.receipt || response.receipt.attempt_id !== attemptId) throw new Error('workbench_budget_receipt_invalid');
    return response.receipt;
  };
  try {
    reserveAttempted = true;
    const reservation = await call('reserve', { request: body });
    if (reservation.state !== 'reserved') throw new Error('workbench_budget_receipt_invalid');
    await check(options.signal);
    options.signal?.throwIfAborted();
    dispatchAttempted = true;
    const dispatched = await call('dispatch', { attempt_id: attemptId });
    if (dispatched.state !== 'in_flight') throw new Error('workbench_budget_receipt_invalid');
    // A lost dispatch acknowledgement never causes a speculative provider call.
    options.signal?.throwIfAborted();
    let usage, finish;
    for await (const chunk of next()) {
      if (finish) throw new Error('workbench_budget_stream_incomplete');
      if (chunk?.type === 'finish') { finish = chunk; continue; }
      if (chunk?.type === 'usage') usage = structuredClone(chunk.usage);
      yield chunk;
    }
    if (!finish) throw new Error('workbench_budget_stream_incomplete');
    if (usage === undefined) throw new Error('workbench_budget_usage_unknown');
    reason = 'settlement_unavailable';
    const receipt = await call('settle', { attempt_id: attemptId, usage });
    if (receipt.state !== 'settled') {
      reason = 'usage_incomplete';
      throw new Error('workbench_budget_usage_unknown');
    }
    settled = true;
    if (receipt.bound_exceeded) throw new Error('workbench_budget_provider_bound_exceeded');
    // The loop cannot persist a successful terminal message before settlement.
    yield finish;
  } finally {
    if (!settled && dispatchAttempted) {
      try { await call('unknown', { attempt_id: attemptId, reason }); }
      catch { /* Persistent in-flight holds remain; do not pretend they were refunded. */ }
    } else if (!dispatchAttempted && reserveAttempted) {
      try { await call('release', { attempt_id: attemptId }); }
      catch { /* Release is CAS-only for never-dispatched attempts; an unresolved hold stays held. */ }
    }
  }
}
