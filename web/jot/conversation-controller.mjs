import {fromSnapshot,reduceEvent} from './projection.ts';
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
 async send(text,attachments=[]){
  if(this.sending)throw new Error('message_in_flight');
  if(!this.pending){
   if(!Array.isArray(attachments)||attachments.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(attachments).size!==attachments.length)throw new Error('invalid_attachments');
   if(!text.trim()&&!attachments.length)throw new Error('empty_message');
   const content=[...(text.trim()?[{type:'text',text}]:[]),...attachments.map(artifact_id=>({type:'file',artifact_id}))];
   this.pending={key:crypto.randomUUID(),body:{client_message_id:crypto.randomUUID(),content,client_time_zone:Intl.DateTimeFormat().resolvedOptions().timeZone}};
  }
  this.sending=true;this.changed();const pending=this.pending;
  try{const result=await this.api.request(`/conversations/${encodeURIComponent(this.id)}/messages`,'POST',pending.body,pending.key);this.pending=null;return result;}
  catch(error){if(error?.status>=400&&error.status<500&&error.status!==408)this.pending=null;throw error;}
  finally{this.sending=false;this.changed();}
 }
}
