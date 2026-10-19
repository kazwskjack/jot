import {TaskSaveReceipt} from '../workbench/task-save.mjs';
const ID=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
export class RunCancelWriter{
 constructor(request,changed=()=>{},key){this.request=request;this.changed=changed;this.receipt=new TaskSaveReceipt(key);}
 get pending(){return this.receipt.pending;}
 cancel(run){if(this.pending)throw Error('请先重试原停止请求');if(!run||typeof run.run_id!=='string'||!ID.test(run.run_id??'')||!Number.isSafeInteger(run.version)||run.version<1)throw Error('任务版本尚未确认');return this.send('/runs/'+encodeURIComponent(run.run_id)+'/cancel',{expected_run_version:run.version});}
 retry(){const c=this.receipt.command;if(!c)throw Error('没有待确认的停止请求');return this.send(c.path,c.body);}
 async send(path,body){
  const pending=this.receipt.submit(async(p,m,b,key)=>{const value=await this.request(p,m,b,key),id=decodeURIComponent(p.slice('/runs/'.length,-'/cancel'.length));
   if(!value||Object.keys(value).sort().join(',')!=='accepted,command_id,run_id'||value.accepted!==true||value.run_id!==id||typeof value.command_id!=='string'||!ID.test(value.command_id))throw Error('停止结果尚未确认，请重试原停止请求');return value;
  },path,'POST',body);this.changed();try{return await pending;}finally{this.changed();}
 }
}
