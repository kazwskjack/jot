// Test-harness cleanup helper. Every action runs; the body error stays primary.
export async function finalizeTestWithCleanup(primaryError,actions,reportCleanupFailures=()=>{}){
 const cleanupFailures=[];
 for(const {operation,action} of actions){
  try{await action();}catch(error){cleanupFailures.push({operation,error});}
 }
 if(cleanupFailures.length)try{reportCleanupFailures(cleanupFailures);}catch(error){cleanupFailures.push({operation:'cleanup_failure_reporting',error});}
 if(primaryError)throw primaryError;
 if(cleanupFailures.length)throw new AggregateError(cleanupFailures.map(failure=>failure.error),'test_cleanup_failed');
}
