const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const relative=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\\:\x00-\x1f\x7f]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
const uncertain=new Set(['interrupted','unknown','prepared','failed_before_preparation','cancelled_before_preparation']);

/** Entry visibility only. The owned server source remains the authority. */
export function publicationOccurrence(taskId,row){
 if(!id(taskId)||!row||row.status!=='succeeded'||row.completion_state!=='completed'||!id(row.conversation_id)||!id(row.run_id))return null;
 return{taskId,conversationId:row.conversation_id,runId:row.run_id};
}

/** Preserve the selected older option when refreshing the newest page. This
 * metadata is never a substitute for reading its current owned review. */
export function publicationHistorySelection(page,previous,selectedId){
 const selected=previous.find(row=>row.intent_id===selectedId);
 return selected&&!page.some(row=>row.intent_id===selectedId)?[...page,selected]:page;
}

/** Display choices only; original source selection and authority remain on the
 * server. Unsupported changes stay in the complete original inventory view. */
export function publicationSelection(source,scope){
 const fail=()=>{throw Error('PUBLICATION_SOURCE_UNCONFIRMED')};
 if(!source||source.source!=='isolated'||!scope||!['project_id','run_id','task_id'].every(key=>id(scope[key])&&source[key]===scope[key])||!sha(source.source_sha256)
  ||!Array.isArray(source.files)||!source.work_review||source.work_review.execution_authorized!==false||!Array.isArray(source.work_review.diff?.changes))fail();
 const files=new Map();for(const file of source.files){if(!file||!relative(file.path)||!sha(file.sha256)||!Number.isSafeInteger(file.version)||file.version<1||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<0||files.has(file.path))fail();files.set(file.path,file)}
 const paths=[];for(const change of source.work_review.diff.changes){
  if(!['add','modify'].includes(change.kind)||change.after?.kind!=='file'||change.mode_changed||change.kind==='add'&&change.after.executable)continue;
  const file=files.get(change.path);if(!relative(change.path)||change.after.path!==change.path||!file||file.sha256!==change.after.sha256||file.size_bytes!==change.after.bytes)fail();
  paths.push(change.path);
 }
 if(new Set(paths).size!==paths.length)fail();return paths;
}

export function publicationStatusPresentation(state){
 const labels={not_started:'已受理，尚未应用',running:'正在应用',interrupted:'应用已中断，需要核对',unknown:'应用结果待核对',prepared:'文件准备未完成，需要核对',failed_before_preparation:'准备失败，需要核对',cancelled_before_preparation:'准备已中止，需要核对',applied_pending_settlement:'修改已记录，等待完成确认',abandon_pending_settlement:'确认已记录，等待收尾',applied:'这次修改已应用',abandoned_unknown:'本次应用已结束，原不确定结果已保留'};
 return{label:labels[state]??'当前状态未能核验',complete:state==='applied',terminal:['applied','abandoned_unknown'].includes(state),blocked:!Object.hasOwn(labels,state),canRecover:uncertain.has(state)||['applied_pending_settlement','abandon_pending_settlement'].includes(state)};
}

/** Proposed explicit owner command, never a local permission grant. A recorded
 * pending command retains its original CAS, even when the journal has advanced. */
export function publicationRecoveryCommand(status,input,receipt){
 const fail=()=>{throw Error('PUBLICATION_RECOVERY_UNCONFIRMED')};
 if(!status||!id(status.project_id)||!id(status.execution_id)||!sha(status.journal_sha256)||!input||!id(input.request_id)||input.acknowledge_unknown!==true)fail();
 if(receipt){
  if(!['applied_pending_settlement','abandon_pending_settlement'].includes(status.state)||receipt.project_id!==status.project_id||receipt.execution_id!==status.execution_id||!id(receipt.request_id)
   ||receipt.action!==input.action||receipt.action!==(status.state==='applied_pending_settlement'?'confirm_recorded':'abandon_unknown')||receipt.acknowledge_unknown!==true||receipt.execution_authorized!==false
   ||!sha(receipt.expected_journal_sha256)||receipt.disposition_sha256!==status.journal_sha256)fail();
  return{request_id:receipt.request_id,action:receipt.action,expected_journal_sha256:receipt.expected_journal_sha256,acknowledge_unknown:true};
 }
 const action=status.state==='applied_pending_settlement'?'confirm_recorded':uncertain.has(status.state)?'abandon_unknown':undefined;
 if(!action||input.action!==action)fail();
 return{request_id:input.request_id,action,expected_journal_sha256:status.journal_sha256,acknowledge_unknown:true};
}

export const publicationMutationCanRetry=kind=>['prepare','approve','cancel','admit'].includes(kind);
