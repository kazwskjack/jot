import {withNativeBudget,nativeExecutionHash} from './web-budget-context.js';

export async function runNativeBudgetedTool({binding,exec,next,request,check}){
  if(typeof request!=='function'||typeof check!=='function'||typeof next!=='function'
    ||exec?.agent?.id!==binding?.sessionRef)throw new Error('native_budget_binding_invalid');
  // Validate the complete registry identity before any management request.
  const requestHash=nativeExecutionHash(exec);
  let mintAttempted=false,primaryError;
  try{
    await check();
    mintAttempted=true;
    const ticket=await request('web-budget-grant',binding,{call_id:exec.callId,
      tool_name:exec.name,request_hash:requestHash},exec.signal);
    if(ticket?.protocol!==1||typeof ticket.expires_at!=='string'
      ||!Number.isFinite(Date.parse(ticket.expires_at))||Date.parse(ticket.expires_at)<=Date.now())
      throw new Error('native_budget_ticket_invalid');
    return await withNativeBudget(exec,ticket.grant,async()=>{
      await check();
      return await next();
    });
  }catch(error){primaryError=error;throw error;}
  finally{
    if(mintAttempted){
      try{
        // Cleanup must outlive caller cancellation. request() retains its own
        // bounded management timeout; closing never refunds dispatched work.
        const closed=await request('web-budget-grant/close',binding,{call_id:exec.callId});
        if(closed?.closed!==true)throw new Error('native_budget_close_pending');
      }catch{if(primaryError===undefined)throw new Error('native_budget_close_pending');}
    }
  }
}
