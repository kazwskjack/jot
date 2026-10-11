import test from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../src/channels/provider-config.ts';

test('delivery channel selection is explicit and rejects unsupported or duplicate channels',()=>{
 assert.equal(typeof config.deliveryChannels,'function');
 assert.deepEqual(config.deliveryChannels({}),['wecom']);
 assert.deepEqual(config.deliveryChannels({GENERAL_AGENT_DELIVERY_CHANNELS:'email'}),['email']);
 assert.deepEqual(config.deliveryChannels({GENERAL_AGENT_DELIVERY_CHANNELS:'wecom,email'}),['wecom','email']);
 for(const value of ['', 'email,email','sms','wecom,'])assert.throws(()=>config.deliveryChannels({GENERAL_AGENT_DELIVERY_CHANNELS:value}),/delivery_channels_invalid/);
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
