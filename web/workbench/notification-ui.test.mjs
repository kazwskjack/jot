import test from 'node:test';import assert from 'node:assert/strict';
test('notification settings reference only verified bindings and freeze the exact save request',async()=>{
 const {notificationRequest,deliveryLabel}=await import('./notification-ui.mjs');
 const bindings=[{channel_binding_id:'verified',status:'verified'},{channel_binding_id:'revoked',status:'revoked'}];
 const request=notificationRequest(2,['verified'],bindings);assert.deepEqual(request,{expected_version:2,channel_binding_ids:['verified']});assert.ok(Object.isFrozen(request));assert.ok(Object.isFrozen(request.channel_binding_ids));
 assert.throws(()=>notificationRequest(2,['revoked'],bindings));assert.throws(()=>notificationRequest(2,['foreign'],bindings));assert.throws(()=>notificationRequest(2,['verified','verified'],bindings));
 assert.equal(deliveryLabel('delivered'),'渠道已接收');assert.match(deliveryLabel('outcome_unknown'),/核对/);assert.equal(deliveryLabel('cancelled'),'已取消');
});
test('notification channel labels distinguish Web Push from WeCom and email',async()=>{
 const {channelBindingLabel}=await import('./notification-ui.mjs');
 assert.equal(channelBindingLabel('wecom'),'微信企业');assert.equal(channelBindingLabel('email'),'邮箱');
 assert.equal(channelBindingLabel('webpush'),'浏览器通知');assert.equal(channelBindingLabel('unknown'),'未知渠道');
});
test('selected notification events are frozen, bounded and cannot name a new notification target',async()=>{
 const {notificationRequest}=await import('./notification-ui.mjs'),events=['changed','failed'];const request=notificationRequest(1,[],[],undefined,events);
 assert.deepEqual(request.events,['changed','failed']);assert.ok(Object.isFrozen(request.events));events.push('completed');assert.deepEqual(request.events,['changed','failed']);
 for(const invalid of [['send_anywhere'],['failed','failed'],['completed','failed','changed','needs_confirmation','extra']])assert.throws(()=>notificationRequest(1,[],[],undefined,invalid));
 assert.deepEqual(notificationRequest(1,[],[],undefined,[]).events,[]);
});
test('notification delivery policy is validated and frozen for retries including nested quiet hours',async()=>{
 const {notificationRequest}=await import('./notification-ui.mjs'),bindings=[{channel_binding_id:'verified',status:'verified'}];
 const policy={min_interval_seconds:90,max_per_24_hours:10,quiet_hours:{start:'22:00',end:'08:00',timezone:'Asia/Hong_Kong'}};
 const request=notificationRequest(1,['verified'],bindings,policy);assert.deepEqual(request.delivery_policy,policy);assert.ok(Object.isFrozen(request.delivery_policy));assert.ok(Object.isFrozen(request.delivery_policy.quiet_hours));
 policy.quiet_hours.end='09:00';assert.equal(request.delivery_policy.quiet_hours.end,'08:00');
 assert.throws(()=>notificationRequest(1,[],bindings,{...policy,max_per_24_hours:0}));assert.throws(()=>notificationRequest(1,[],bindings,{...policy,quiet_hours:{start:'22:00',end:'22:00',timezone:'UTC'}}));
});
test('file consent freezes only selected verified WeCom IDs and requires completed notifications',async()=>{
 const {notificationRequest}=await import('./notification-ui.mjs'),bindings=[
  {channel_binding_id:'wecom-1',channel:'wecom',status:'verified'},
  {channel_binding_id:'email-1',channel:'email',status:'verified'},
 ];
 const selected=['wecom-1'],request=notificationRequest(3,['wecom-1','email-1'],bindings,undefined,['completed'],selected);
 assert.deepEqual(request.artifact_delivery_binding_ids,['wecom-1']);assert.ok(Object.isFrozen(request.artifact_delivery_binding_ids));selected.push('email-1');assert.deepEqual(request.artifact_delivery_binding_ids,['wecom-1']);
 assert.throws(()=>notificationRequest(3,['email-1'],bindings,undefined,['completed'],['email-1']));
 assert.throws(()=>notificationRequest(3,['wecom-1'],bindings,undefined,['failed'],['wecom-1']));
});
