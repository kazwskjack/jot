const summaryKinds=new Set(['array','null','object','string','number','boolean']);
const browserOperationStatuses=new Set(['accepted','running','succeeded','failed','unknown']);
const browserOperationActions=new Set(['read','click','fill','scroll','screenshot']);
const browserOperationErrorCodes=new Set([
 'browser_action_outcome_unknown','driver_failure','browser_driver_closed','browser_page_unavailable','browser_page_changed',
 'browser_page_revision_stale','browser_run_inactive','artifact_run_mismatch','cancelled','browser_inspect_required_after_unknown',
 'browser_target_not_found','browser_target_not_actionable','browser_fill_target_invalid','browser_target_not_unique',
 'user_denied','browser_approval_failed','browser_action_failed'
]);
const shortIdPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha256Pattern=/^[a-f0-9]{64}$/;
const candidateIdPattern=/^[a-f0-9]{24}$/;

function browserOperationReceiptSummary(receipt){
 if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))return undefined;
 const summary={kind:'browser_operation_receipt'};
 for(const key of ['operation_id','run_id','call_id'])if(typeof receipt[key]==='string'&&shortIdPattern.test(receipt[key]))summary[key]=receipt[key];
 if(typeof receipt.request_hash==='string'&&sha256Pattern.test(receipt.request_hash))summary.request_hash=receipt.request_hash;
 if(typeof receipt.action==='string'&&browserOperationActions.has(receipt.action))summary.action=receipt.action;
 if(typeof receipt.status==='string'&&browserOperationStatuses.has(receipt.status))summary.status=receipt.status;
 if(typeof receipt.candidate_id==='string'&&candidateIdPattern.test(receipt.candidate_id))summary.candidate_id=receipt.candidate_id;
 for(const key of ['page_revision','result_page_revision','result_sha256'])if(typeof receipt[key]==='string'&&sha256Pattern.test(receipt[key]))summary[key]=receipt[key];
 if(typeof receipt.error_code==='string'&&browserOperationErrorCodes.has(receipt.error_code))summary.error_code=receipt.error_code;
 if(receipt.recovery==='inspect_only')summary.recovery='inspect_only';
 return summary;
}

function isArgumentSummary(args){
 return args!==null&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).length===2&&Object.hasOwn(args,'kind')&&Object.hasOwn(args,'field_count')&&summaryKinds.has(args.kind)&&Number.isSafeInteger(args.field_count)&&args.field_count>=0;
}

function argumentShape(args){
 if(Array.isArray(args))return{kind:'array',field_count:args.length};
 if(args===null)return{kind:'null',field_count:0};
 if(typeof args==='object')return{kind:'object',field_count:Object.keys(args).length};
 return{kind:typeof args,field_count:0};
}

export function toolActivitySummary(event){
 const summary={};
 for(const key of ['run_id','phase','label','status'])if(event[key]!==undefined)summary[key]=event[key];
 if(Object.hasOwn(event,'args')){
  const existing=event.args_summary_version===1&&isArgumentSummary(event.args);
  summary.args=existing?{kind:event.args.kind,field_count:event.args.field_count}:argumentShape(event.args);
  summary.args_summary_version=1;
 }
 return summary;
}

export function toolEventSummary(type,event){
 const summary={};
 if(typeof event?.run_id==='string')summary.run_id=event.run_id;
 if(typeof event?.call_id==='string')summary.call_id=event.call_id;
 summary.tool='tool';
 const result=event?.result;
 const savedStatus=type==='tool.result'&&event?.tool_event_summary_version===1&&['succeeded','failed'].includes(event.status)?event.status:undefined;
 summary.status=type==='tool.error'?'failed':savedStatus??(result!==null&&typeof result==='object'&&Object.hasOwn(result,'error')?'failed':'succeeded');
 summary.tool_event_summary_version=1;
 return summary;
}

export function browserOperationEventSummary(type,event){
 const suffix=typeof type==='string'&&type.startsWith('browser.operation.')?type.slice('browser.operation.'.length):'';
 const status=browserOperationStatuses.has(suffix)?suffix:undefined;
 const summary={kind:'browser_operation'};
 for(const key of ['operation_id','run_id','call_id'])if(typeof event?.[key]==='string'&&shortIdPattern.test(event[key]))summary[key]=event[key];
 if(typeof event?.request_hash==='string'&&sha256Pattern.test(event.request_hash))summary.request_hash=event.request_hash;
 if(typeof event?.action==='string'&&browserOperationActions.has(event.action))summary.action=event.action;
 if(status)summary.status=status;
 if(typeof event?.candidate_id==='string'&&candidateIdPattern.test(event.candidate_id))summary.candidate_id=event.candidate_id;
 for(const key of ['page_revision','result_page_revision'])if(typeof event?.[key]==='string'&&sha256Pattern.test(event[key]))summary[key]=event[key];
 if(typeof event?.result_sha256==='string'&&sha256Pattern.test(event.result_sha256))summary.result_sha256=event.result_sha256;
 const receipt=browserOperationReceiptSummary(event?.browser_receipt);
 if(receipt)summary.browser_receipt=receipt;
 const errorCode=event?.error_code??event?.browser_receipt?.error_code;
 if(typeof errorCode==='string'&&browserOperationErrorCodes.has(errorCode))summary.error_code=errorCode;
 if(event?.recovery==='inspect_only')summary.recovery='inspect_only';
 return summary;
}
