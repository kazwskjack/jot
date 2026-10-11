export function notificationRequest(version,ids,bindings,policy,events){
 if(!Number.isSafeInteger(version)||version<0||ids.length>5||new Set(ids).size!==ids.length||ids.some(id=>!bindings.some(binding=>binding.channel_binding_id===id&&binding.status==='verified')))throw new Error('请选择已验证的有效渠道');
 let frozen;
 if(policy!==undefined){
  if(!Number.isInteger(policy.min_interval_seconds)||policy.min_interval_seconds<1||policy.min_interval_seconds>86400||!Number.isInteger(policy.max_per_24_hours)||policy.max_per_24_hours<1||policy.max_per_24_hours>100)throw new Error('请填写有效的通知间隔和24小时上限');
  let quiet=null;if(policy.quiet_hours!==null){const q=policy.quiet_hours;
   if(!q||!/^([01]\d|2[0-3]):[0-5]\d$/.test(q.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(q.end)||q.start===q.end||typeof q.timezone!=='string'||!q.timezone||q.timezone.length>100||q.timezone.trim()!==q.timezone||/^[+-]/.test(q.timezone))throw new Error('请填写有效的安静时段');
   try{new Intl.DateTimeFormat('en-US',{timeZone:q.timezone});}catch{throw new Error('请选择有效的IANA时区');}
   quiet=Object.freeze({start:q.start,end:q.end,timezone:q.timezone});
  }
  frozen=Object.freeze({min_interval_seconds:policy.min_interval_seconds,max_per_24_hours:policy.max_per_24_hours,quiet_hours:quiet});
 }
 if(events!==undefined&&(!Array.isArray(events)||events.length>4||new Set(events).size!==events.length||events.some(event=>!['changed','completed','failed','needs_confirmation'].includes(event))))throw new Error('请选择有效的通知条件');
 return Object.freeze({expected_version:version,channel_binding_ids:Object.freeze([...ids]),...(frozen?{delivery_policy:frozen}:{}),...(events!==undefined?{events:Object.freeze([...events])}:{})});
}
export function deliveryLabel(status){return {pending:'排队等待',sending:'正在提交',receipt_pending:'正在核对回执',delivered:'渠道已接收',outcome_unknown:'发送结果待核对',cancelled:'已取消',failed:'交付失败'}[status]??'状态待核对';}
