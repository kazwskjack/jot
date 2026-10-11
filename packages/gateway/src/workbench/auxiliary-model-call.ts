import {randomUUID} from 'node:crypto';
import type {ModelBudgetLedger} from './model-budget.ts';

/** Trusted adapters supply bounded server routes and normalized provider usage.
 * Never pass browser/model supplied accounting claims to this entry point. */
export async function runBudgetedAuxiliaryCall<T>(options:{
  ledger:ModelBudgetLedger;owner:string;runId:string;
  route:{provider:string;model:string};purpose:'emotion'|'web-decision'|'reply-verification';attemptId?:string;
  guard:()=>void;invoke:()=>Promise<{value:T;usage:unknown}>;
}) {
  const {ledger,owner,runId}=options;
  const attemptId=options.attemptId??randomUUID();
  options.guard();
  const reservation=ledger.reserve(owner,runId,{attempt_id:attemptId,provider:options.route.provider,model:options.route.model,purpose:options.purpose});
  const perCall=reservation.metering==='dispatched_call';
  let dispatched=false,settled=false;
  try {
    ledger.dispatch(owner,runId,attemptId,options.guard);dispatched=true;
    let receipt=perCall?ledger.settleDispatchedCall(owner,runId,attemptId):undefined;
    settled=receipt?.state==='settled';
    let result:{value:T;usage:unknown};
    try{result=await ledger.observeAuxiliaryCall(owner,runId,attemptId,options.invoke);}catch{throw new Error(perCall?'auxiliary_provider_failed':'auxiliary_usage_unknown');}
    if(!receipt)try{receipt=ledger.settle(owner,runId,attemptId,result.usage);}catch{throw new Error('auxiliary_usage_unknown');}
    settled=receipt.state==='settled';
    if(!settled)throw new Error('auxiliary_usage_unknown');
    if(receipt.bound_exceeded)throw new Error('model_budget_exhausted');
    options.guard();
    return {value:result.value,receipt};
  } finally {
    // Sent calls retain their hold on timeout, invalid use, or settlement error.
    // Cancellation/revocation cannot erase already incurred costs.
    if(dispatched&&!settled)ledger.markUnknown(owner,runId,attemptId,'usage_incomplete');
    else if(!dispatched)ledger.releaseUndispatched(owner,runId,attemptId);
  }
}
