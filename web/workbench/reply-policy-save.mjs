import {blankReplyForm,validateFrozenReplyPolicy} from './reply-policy-ui.mjs';
export function replyFormFromPolicy(policy){
 validateFrozenReplyPolicy(policy);const form=blankReplyForm();if(policy.mode==='report')return form;
 return {...form,mode:policy.mode,target_kind:policy.target.kind,target_id:policy.target.conversation_id??policy.target.channel_binding_id,topic:policy.direction.topic,tone:policy.direction.tone,forbidden:policy.direction.forbidden.join('\n'),max_per_24_hours:String(policy.limits.max_per_24_hours),min_interval_seconds:String(policy.limits.min_interval_seconds),expires_at:policy.limits.expires_at,quiet_enabled:policy.quiet_hours!==null,...(policy.quiet_hours?{quiet_start:policy.quiet_hours.start,quiet_end:policy.quiet_hours.end,quiet_timezone:policy.quiet_hours.timezone}:{})};
}
// Only the frozen PATCH is persisted. Recovery is explicit and never sends on mount.
export class ReplyPolicyReceiptStore{
 constructor(storage,scope,taskId){if(!/^[a-f0-9]{64}$/.test(scope)||typeof taskId!=='string'||!taskId||taskId.length>200)throw new Error('回复回执用户范围不可用');this.storage=storage;this.key=`jot-reply-receipt/v1/${scope}/${encodeURIComponent(taskId)}`;this.path=`/persistent-tasks/${encodeURIComponent(taskId)}/reply-policy`;}
 validate(command){
  const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
  if(!exact(command,['path','method','body','key'])||command.path!==this.path||command.method!=='PATCH'||typeof command.key!=='string'||!command.key||command.key.length>200||!exact(command.body,['expected_version','policy'])||!Number.isSafeInteger(command.body.expected_version)||command.body.expected_version<0)throw new Error('回复保存回执无效');
  validateFrozenReplyPolicy(command.body.policy);
 }
 read(){const text=this.storage.getItem(this.key);if(!text)return null;if(text.length>30000)throw new Error('回复保存回执过大');const value=JSON.parse(text);if(!value||Object.keys(value).length!==1||!Object.hasOwn(value,'command'))throw new Error('回复保存回执无效');this.validate(value.command);return value;}
 saveCommand(command){if(command===null){this.complete();return;}this.validate(command);const text=JSON.stringify({command});if(text.length>30000)throw new Error('回复保存回执过大');this.storage.setItem(this.key,text);}
 complete(){this.storage.removeItem(this.key);}
}
