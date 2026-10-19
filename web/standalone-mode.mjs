import {TaskSaveReceipt} from './workbench/task-save.mjs';
export function standaloneModes(caps){const value=caps?.conversation_modes;if(value===undefined)return{aware:false,default:'work',chatReady:false};if(!value||!['chat','work'].includes(value.default)||value.work?.supported!==true||typeof value.chat?.ready!=='boolean'||value.default==='chat'&&!value.chat.ready)throw Error('Conversation mode readiness is unavailable');return{aware:true,default:value.default,chatReady:value.chat.ready};}
export function standaloneCreation(caps){const modes=standaloneModes(caps);return{title:'New chat',...(modes.aware?{mode:modes.default}:{})};}
export function mergeStandaloneSnapshot(previous,incoming){const same=previous.conversation?.id===incoming.conversation?.id,current=same&&(previous.conversation?.version??0)>(incoming.conversation?.version??0)?previous.conversation:incoming.conversation;if(same&&incoming.seq<previous.seq)return{...previous,conversation:current};return{...incoming,conversation:current};}
export class StandaloneCommand{
 constructor(request,changed=()=>{},key){this.request=request;this.changed=changed;this.receipt=new TaskSaveReceipt(key);}
 get pending(){return this.receipt.pending;}
 get command(){return this.receipt.command;}
 send(path,method,body){if(this.pending)throw Error('Retry the original setting request first');return this.dispatch(path,method,body);}
 retry(){const c=this.command;if(!c)throw Error('No unconfirmed request');return this.dispatch(c.path,c.method,c.body);}
 async dispatch(path,method,body){
  const pending=this.receipt.submit(async(p,m,b,key)=>{const value=await this.request(p,m,{...b,request_id:key}),expected=m==='POST'?1:b.expected_version+1,id=m==='PATCH'?decodeURIComponent(p.slice('/conversations/'.length)):undefined;
   if(!value||typeof value.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(value.id)||value.version!==expected||value.mode!==(b.mode??'work')||id!==undefined&&value.id!==id)throw Error('Conversation setting outcome is unconfirmed');return value;
  },path,method,body);this.changed();try{return await pending;}finally{this.changed();}
 }
}
