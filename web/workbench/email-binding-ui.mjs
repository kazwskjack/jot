import {TaskSaveReceipt} from './task-save.mjs';
// Intentionally memory-only: mailbox codes never enter local/session storage.
export class EmailBindingCommands{
 constructor(request,key=()=>crypto.randomUUID()){this.request=request;this.application=new TaskSaveReceipt(key);this.proof=new TaskSaveReceipt(key);}
 get beginPending(){return this.application.pending;}
 get confirmPending(){return this.proof.pending;}
 async begin(address){
  if(!this.beginPending&&(typeof address!=='string'||address.length>254||address!==address.trim()||/[\s,;<>]/.test(address)||! /^[^@]+@[^@]+\.[^@]+$/.test(address)))throw new Error('请填写一个有效邮箱');
  return this.application.submit(this.request,'/channel-bindings/email','POST',{address});
 }
 async confirm(id,code){
  if(!this.confirmPending&&(typeof id!=='string'||!id||id.length>200||typeof code!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(code)))throw new Error('请选择待验证邮箱并粘贴完整验证码');
  return this.proof.submit(this.request,`/channel-bindings/email/${encodeURIComponent(id)}/confirm`,'POST',{code});
 }
}
