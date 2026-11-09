import {fromSnapshot,reduceEvent} from './projection.ts';
import {goalPrompt} from './goal-controller.mjs';
import {messageIntentAttachments,validateMessageReceipt,validateMessageIntent} from './message-intent-recovery.mjs';
import {emptyComposerDraft,validateComposerDraft} from './composer-draft-recovery.mjs';
const ID=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
export class RoleChatController {
 constructor(id,api,onChange=()=>{},options={}){
  this.recoveryRequired=options.recoveryRequired===true;this.recoveryReady=!this.recoveryRequired;this.currentScope=options.currentScope;
  this.recoveryEpoch=0;this.recovering=false;this.recoveryError='';this.persistence=Promise.resolve();
  this.draft=emptyComposerDraft();this.draftGeneration=0;this.draftSerial=0;this.savedDraftSerial=0;
  this.id=id;this.api=api;this.onChange=onChange;this.state=null;this.pending=null;this.connection='connecting';this.error='';this.abort=null;this.sending=false;
 }
 get draftDirty(){return this.draftSerial!==this.savedDraftSerial;}
 get recoveryBusy(){return this.sending||this.recovering||!!this.draftSavePromise;}
 get pendingMessage(){return Boolean(this.pending);}
 get pendingAttachments(){return messageIntentAttachments(this.pending);}
 get recoveryBlocked(){return this.recovering||!this.recoveryReady||!!this.recoveryError||!!this.recoveryStore&&this.currentScope?.()!==this.recoveryStore.scope;}
 assertRecovery(){if(this.recoveryBlocked)throw Error(this.recoveryError||'message_recovery_unavailable');}
 async configureRecovery(store){
  if(this.recoveryBusy)throw Error('message_recovery_busy');
  this.recovering=true;const epoch=this.recoveryEpoch;
  const current=()=>{if(epoch!==this.recoveryEpoch||this.currentScope?.()!==store.scope||store.conversation!==this.id)throw Error('message_recovery_scope_changed');};
  try{
   this.changed();await this.persistence;current();const snapshot=await store.load();current();
   this.recoveryStore?.close();this.recoveryStore=store;this.pending=snapshot?.pending??null;
   this.draft=structuredClone(snapshot?.draft??emptyComposerDraft());this.draftGeneration+=1;this.draftSerial=0;this.savedDraftSerial=0;
   this.recoveryReady=true;this.recoveryError='';
  }finally{if(epoch===this.recoveryEpoch)this.recovering=false;this.changed();}
 }
 disposeRecovery(){this.recoveryReady=!this.recoveryRequired;this.recoveryEpoch+=1;this.recovering=false;this.recoveryStore?.close();}
 persistIntent(pending=this.pending,draft=this.draft){
  this.assertRecovery();if(!this.recoveryStore)return Promise.resolve();
  const store=this.recoveryStore,epoch=this.recoveryEpoch,snapshot=structuredClone({pending,draft});
  const operation=this.persistence.then(async()=>{
   this.assertRecovery();if(epoch!==this.recoveryEpoch)throw Error('message_recovery_scope_changed');
   await store.save(snapshot);
   this.assertRecovery();if(epoch!==this.recoveryEpoch)throw Error('message_recovery_scope_changed');
  });
  this.persistence=operation.catch(()=>{});
  return operation.catch(error=>{if(epoch===this.recoveryEpoch){this.recoveryError=error instanceof Error?error.message:'message_recovery_unavailable';this.changed();}throw error;});
 }
 async saveDraft(value){
  this.assertRecovery();if(this.pending||this.sending)throw Error('message_in_flight');
  const draft=structuredClone(validateComposerDraft(value,this.id,this.recoveryStore?.scope)),epoch=this.recoveryEpoch;
  const changed=JSON.stringify(draft)!==JSON.stringify(this.draft);
  if(!changed&&!this.draftDirty)return this.draftSavePromise??Promise.resolve();
  if(changed){this.draft=draft;this.draftSerial+=1;}
  if(this.draftSavePromise){
   await this.draftSavePromise;this.assertRecovery();
   if(epoch!==this.recoveryEpoch)throw Error('message_recovery_scope_changed');
   if(this.draftDirty&&!this.pending&&!this.sending)return this.saveDraft(this.draft);
   return;
  }
  const operation=Promise.resolve().then(async()=>{
   let saved;
   do{
    saved=this.draftSerial;await this.persistIntent();
    if(epoch!==this.recoveryEpoch)throw Error('message_recovery_scope_changed');
    this.savedDraftSerial=saved;
   }while(saved!==this.draftSerial&&!this.pending&&!this.sending);
  }).finally(()=>{if(this.draftSavePromise===operation){this.draftSavePromise=undefined;this.changed();}});
  this.draftSavePromise=operation;this.changed();return operation;
 }
 async acknowledgeSent(){
  if(!this.recoveryStore)return;
  this.assertRecovery();if(this.sending||!this.pending?.receipt)throw Error('message_receipt_unconfirmed');
  this.sending=true;this.changed();
  try{
   const draft={...emptyComposerDraft(),goalMode:this.draft.goalMode};
   await this.persistIntent(null,draft);this.pending=null;this.draft=draft;
   this.draftGeneration+=1;this.draftSerial=0;this.savedDraftSerial=0;
  }
  finally{this.sending=false;this.changed();}
 }
 changed(){this.onChange(this);}
 restore(snapshot){if(snapshot.conversation.conversation_id!==this.id)throw new Error('WRONG_CONVERSATION');if(!this.state||BigInt(snapshot.as_of_seq)>=BigInt(this.state.seq))this.state=fromSnapshot(snapshot);this.changed();}
 apply(event){this.state=reduceEvent(this.state,event);this.changed();}
 async refresh(signal){this.restore(await this.api.snapshot(this.id,signal));}
 stop(){this.abort?.abort();}
 async start(){
  this.stop();const controller=new AbortController();this.abort=controller;let attempts=0;
  while(!controller.signal.aborted){try{
   this.connection='connecting';this.changed();await this.refresh(controller.signal);if(controller.signal.aborted)return;
   this.connection='connected';this.error='';this.changed();
   await this.api.follow(this.id,this.state.seq,event=>{if(!controller.signal.aborted){this.apply(event);attempts=0;}},controller.signal);
   if(!controller.signal.aborted)throw new Error('stream_ended');
  }catch(error){if(controller.signal.aborted)return;this.connection='reconnecting';this.error=error?.status===403?'当前角色对话不可访问':'';this.changed();if(error?.status===403)return;
   await new Promise(resolve=>{const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,Math.min(15000,300*2**Math.min(attempts++,6)));controller.signal.addEventListener('abort',done,{once:true});});
  }}
 }
 async send(text,attachments=[],options={}){
  if(this.sending)throw new Error('message_in_flight');
  this.assertRecovery();
  if(!this.pending){
   if(!Array.isArray(attachments)||attachments.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(attachments).size!==attachments.length)throw new Error('invalid_attachments');
   if(!text.trim()&&!attachments.length)throw new Error('empty_message');
   if(options.goalMode&&!text.trim())throw new Error('goal_objective_required');
   const content=[...(text.trim()?[{type:'text',text:goalPrompt(text,options.goalMode===true)}]:[]),...attachments.map(artifact_id=>({type:'file',artifact_id}))];
   const active=options.originalTask?Object.values(this.state?.runs??{}).filter(run=>['queued','starting','running','waiting_user','waiting_approval','cancelling'].includes(run.status)):[];
   let candidate;
   if(active.length){
    const run=active[0];
    if(active.length!==1||run.conversation_id!==this.id||!ID.test(run.run_id??'')||!Number.isSafeInteger(run.version)||run.version<1||run.status!=='running'||options.steeringConfigured!==true)throw Error('当前任务暂不能接收补充，请稍后重试');
    if(attachments.length&&(options.attachmentSteeringConfigured!==true||attachments.length>10))throw Error('当前任务暂不支持补充这些附件，附件已保留');
    candidate={kind:'steer',runId:run.run_id,path:`/runs/${encodeURIComponent(run.run_id)}/steer`,key:crypto.randomUUID(),body:{delivery:'original',text:text.trim(),client_message_id:crypto.randomUUID(),expected_run_version:run.version,...(attachments.length?{attachments:[...attachments]}:{})}};
   }else candidate={kind:'message',path:`/conversations/${encodeURIComponent(this.id)}/messages`,key:crypto.randomUUID(),body:{client_message_id:crypto.randomUUID(),content,client_time_zone:Intl.DateTimeFormat().resolvedOptions().timeZone}};
   if(this.recoveryStore)validateMessageIntent({pending:candidate},this.id);
   this.pending=candidate;
  }
  this.sending=true;this.changed();const pending=this.pending;
  try{
   await this.persistIntent();
   if(pending.receipt)return pending.receipt;
   const epoch=this.recoveryEpoch,result=await this.api.request(pending.path,'POST',pending.body,pending.key);
   this.assertRecovery();if(epoch!==this.recoveryEpoch)throw Error('message_recovery_scope_changed');
   validateMessageReceipt(result,pending,this.id);
   if(this.recoveryStore){pending.receipt=result;await this.persistIntent();}
   else this.pending=null;
   return result;
  }catch(error){
   if(error?.status>=400&&error.status<500&&error.status!==408&&error.message!=='IDEMPOTENCY_IN_PROGRESS'){
    await this.persistIntent(null);this.pending=null;
   }
   throw error;
  }
  finally{this.sending=false;this.changed();}
 }
}
