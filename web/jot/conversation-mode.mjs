import {TaskSaveReceipt} from '../workbench/task-save.mjs';
const ID=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
export function conversationModeSupport(caps){
 const value=caps?.conversation_modes;if(value===undefined)return{aware:false,default:'work',chatReady:false};
 if(!value||!['chat','work'].includes(value.default)||value.work?.supported!==true||typeof value.chat?.ready!=='boolean'||value.default==='chat'&&!value.chat.ready)throw Error('对话模式能力尚未确认');
 return{aware:true,default:value.default,chatReady:value.chat.ready};
}
export function conversationCreation(caps,workspaceId){
 const modes=conversationModeSupport(caps),workspace=caps?.workspaces?.find(w=>w.workspace_id===workspaceId&&w.can_write===true),model=caps?.models?.find(m=>typeof m.provider==='string'&&m.provider&&typeof m.model==='string'&&m.model);
 if(!workspace||!model)throw Error('请先确认可写工作区和可用模型');
 return{title:'新对话',workspace_id:workspace.workspace_id,model:{provider:model.provider,model:model.model,...(modes.default==='work'&&model.supported_reasoning_efforts?.includes('high')?{reasoning_effort:'high'}:{})},...(modes.aware?{mode:modes.default}:{})};
}
class ConversationWriteReceipt{
 constructor(request,changed=()=>{},key){if(typeof request!=='function')throw Error('conversation_transport_missing');this.request=request;this.changed=changed;this.receipt=new TaskSaveReceipt(key);}
 get pending(){return this.receipt.pending;}
 async send(path,method,body){
  const operation=this.receipt.submit(async(p,m,b,key)=>{const value=await this.request(p,m,b,key),expectedVersion=m==='POST'?1:b.expected_version+1,expectedId=m==='PATCH'?decodeURIComponent(p.slice('/conversations/'.length)):undefined;
   if(!value||typeof value.conversation_id!=='string'||!ID.test(value.conversation_id)||value.version!==expectedVersion||expectedId!==undefined&&value.conversation_id!==expectedId||b.mode!==undefined&&value.mode!==b.mode)throw Error('对话设置结果尚未确认，请重试原请求');return value;},path,method,body);
  this.changed();try{return await operation;}finally{this.changed();}
 }
 retry(){const command=this.receipt.command;if(!command)throw Error('没有待确认的对话设置');return this.send(command.path,command.method,command.body);}
}
export class ConversationModeWriter extends ConversationWriteReceipt{
 change(conversation,mode){if(this.pending)throw Error('请先重试原模式设置');if(!conversation||!ID.test(conversation.conversation_id??'')||!Number.isSafeInteger(conversation.version)||conversation.version<1||!['chat','work'].includes(mode))throw Error('对话模式或版本尚未确认');return this.send('/conversations/'+encodeURIComponent(conversation.conversation_id),'PATCH',{expected_version:conversation.version,mode});}
}
export class ConversationCreateWriter extends ConversationWriteReceipt{
 create(body){if(this.pending)throw Error('请先重试原新建请求');if(!body||typeof body.workspace_id!=='string'||!body.workspace_id||!body.model?.provider||!body.model?.model)throw Error('新对话配置尚未确认');return this.send('/conversations','POST',body);}
}
