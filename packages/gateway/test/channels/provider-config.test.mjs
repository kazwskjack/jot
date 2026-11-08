import test from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../src/channels/provider-config.ts';

test('delivery channel selection is explicit and rejects unsupported or duplicate channels',()=>{
 assert.equal(typeof config.deliveryChannels,'function');
 assert.deepEqual(config.deliveryChannels({}),['wecom']);
 assert.deepEqual(config.deliveryChannels({GENERAL_AGENT_DELIVERY_CHANNELS:'email'}),['email']);
 assert.deepEqual(config.deliveryChannels({GENERAL_AGENT_DELIVERY_CHANNELS:'wecom,email'}),['wecom','email']);
 assert.deepEqual(config.deliveryChannels({GENERAL_AGENT_DELIVERY_CHANNELS:'webpush'}),['webpush']);
 assert.deepEqual(config.deliveryChannels({GENERAL_AGENT_DELIVERY_CHANNELS:'mattermost'}),['mattermost']);
  assert.deepEqual(config.deliveryChannels({GENERAL_AGENT_DELIVERY_CHANNELS:'sms'}),['sms']);
  assert.deepEqual(config.deliveryChannels({GENERAL_AGENT_DELIVERY_CHANNELS:'slack,sms'}),['slack','sms']);
  for(const value of ['', 'email,email','wecom,'])assert.throws(()=>config.deliveryChannels({GENERAL_AGENT_DELIVERY_CHANNELS:value}),/delivery_channels_invalid/);
});

test('Mattermost delivery requires a configured runtime receipt client',()=>{
 assert.throws(()=>config.requireDeliveryRuntimeConfiguration(['mattermost'],'',''),error=>error.message==='delivery_runtime_config_required');
 assert.doesNotThrow(()=>config.requireDeliveryRuntimeConfiguration(['mattermost'],'https://runtime.example.test','runtime-secret-file'));
 assert.doesNotThrow(()=>config.requireDeliveryRuntimeConfiguration(['email'],'',''));
});

test('Slack attachment intake is opt-in and uses the configured bot token file',()=>{
 const env={GENERAL_AGENT_SLACK_TEAM_ID:'T111',GENERAL_AGENT_SLACK_SIGNING_SECRET_FILE:'signing-file',
  GENERAL_AGENT_SLACK_APP_ID:'A111',GENERAL_AGENT_SLACK_BOT_USER_ID:'B111'};
 const secret='s'.repeat(40),token='xoxb-12345678901234567890';
 assert.deepEqual(config.slackWebhookConfiguration(env,path=>{assert.equal(path,'signing-file');return secret;}),
  {teamId:'T111',signingSecret:secret,appId:'A111',botUserId:'B111'});
 assert.deepEqual(config.slackWebhookConfiguration({...env,GENERAL_AGENT_SLACK_ATTACHMENTS_ENABLED:'true',
  GENERAL_AGENT_SLACK_BOT_TOKEN_FILE:'bot-file'},path=>path==='signing-file'?secret:token),
  {teamId:'T111',signingSecret:secret,appId:'A111',botUserId:'B111',attachmentBotToken:token});
 assert.throws(()=>config.slackWebhookConfiguration({...env,GENERAL_AGENT_SLACK_ATTACHMENTS_ENABLED:'true'},()=>secret),
  error=>error.message==='slack_config_invalid');
 assert.throws(()=>config.slackWebhookConfiguration({...env,GENERAL_AGENT_SLACK_ATTACHMENTS_ENABLED:'yes'},()=>secret),
  error=>error.message==='slack_config_invalid');
});

test('SMTP password comes from a server file and invalid config is rejected before reading it',()=>{
 assert.equal(typeof config.emailConfiguration,'function');
 const env={GENERAL_AGENT_SMTP_HOST:'smtp.example.test',GENERAL_AGENT_SMTP_PORT:'465',GENERAL_AGENT_SMTP_USER:'test-user',GENERAL_AGENT_SMTP_PASSWORD_FILE:'server-secret',GENERAL_AGENT_SMTP_FROM:'bot@example.test'};
 const reads=[];const read=path=>{reads.push(path);return 'fake-password\r\n';};
 assert.deepEqual(config.emailConfiguration(env,read),{host:'smtp.example.test',port:465,secure:true,user:'test-user',password:'fake-password',from:'bot@example.test'});
 assert.deepEqual(reads,['server-secret']);
 for(const patch of [{GENERAL_AGENT_SMTP_PORT:'25'},{GENERAL_AGENT_SMTP_PASSWORD_FILE:''},{GENERAL_AGENT_SMTP_FROM:'bot@example.test\nBcc:other'}])assert.throws(()=>config.emailConfiguration({...env,...patch},read),/email_config_invalid/);
 assert.equal(reads.length,1);
 assert.throws(()=>config.emailConfiguration(env,()=>{throw new Error('secret path details');}),error=>error.message==='email_secret_unavailable');
});
