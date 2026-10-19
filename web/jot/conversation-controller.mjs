import {fromSnapshot,reduceEvent} from './projection.ts';
import {goalPrompt} from './goal-controller.mjs';
const ID=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
export class RoleChatController {
 constructor(id,api,onChange=()=>{}){this.id=id;this.api=api;this.onChange=onChange;this.state=null;this.pending=null;this.connection='connecting';this.error='';this.abort=null;this.sending=false;}
 get pendingMessage(){return Boolean(this.pending);}
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
  if(!this.pending){
   if(!Array.isArray(attachments)||attachments.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(attachments).size!==attachments.length)throw new Error('invalid_attachments');
   if(!text.trim()&&!attachments.length)throw new Error('empty_message');
   if(options.goalMode&&!text.trim())throw new Error('goal_objective_required');
   const content=[...(text.trim()?[{type:'text',text:goalPrompt(text,options.goalMode===true)}]:[]),...attachments.map(artifact_id=>({type:'file',artifact_id}))];
   const active=options.originalTask?Object.values(this.state?.runs??{}).filter(run=>['queued','starting','running','waiting_user','waiting_approval','cancelling'].includes(run.status)):[];
   if(active.length){
    const run=active[0];
    if(active.length!==1||run.conversation_id!==this.id||!ID.test(run.run_id??'')||!Number.isSafeInteger(run.version)||run.version<1||run.status!=='running'||options.steeringConfigured!==true)throw Error('当前任务暂不能接收补充，请稍后重试');
    if(attachments.length)throw Error('当前任务暂不支持补充附件，附件已保留');
    this.pending={kind:'steer',runId:run.run_id,path:`/runs/${encodeURIComponent(run.run_id)}/steer`,key:crypto.randomUUID(),body:{delivery:'original',text:text.trim(),client_message_id:crypto.randomUUID(),expected_run_version:run.version}};
   }else this.pending={kind:'message',path:`/conversations/${encodeURIComponent(this.id)}/messages`,key:crypto.randomUUID(),body:{client_message_id:crypto.randomUUID(),content,client_time_zone:Intl.DateTimeFormat().resolvedOptions().timeZone}};
  }
  this.sending=true;this.changed();const pending=this.pending;
  try{const result=await this.api.request(pending.path,'POST',pending.body,pending.key);
   const valid=pending.kind==='steer'
    ?result&&Object.keys(result).sort().join(',')==='accepted,command_id,run_id'&&result.accepted===true&&result.run_id===pending.runId&&typeof result.command_id==='string'&&ID.test(result.command_id)
    :result&&Object.keys(result).sort().join(',')==='accepted,conversation_id,message_id,run_id'&&result.accepted===true&&result.conversation_id===this.id&&typeof result.message_id==='string'&&typeof result.run_id==='string'&&ID.test(result.message_id)&&ID.test(result.run_id);
   if(!valid)throw Error('发送结果尚未确认，请重试原消息');this.pending=null;return result;}
  catch(error){if(error?.status>=400&&error.status<500&&error.status!==408&&error.message!=='IDEMPOTENCY_IN_PROGRESS')this.pending=null;throw error;}
  finally{this.sending=false;this.changed();}
 }
}
