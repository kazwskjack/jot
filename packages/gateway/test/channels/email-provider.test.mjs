import test from 'node:test';
import assert from 'node:assert/strict';
import * as email from '../../src/channels/email-provider.ts';
const config={host:'smtp.example.test',port:465,secure:true,user:'test-user',password:'test-password',from:'bot@example.test'};
test('SMTP adapter fixes envelope, sender and content and requires an accepted receipt',async()=>{
 assert.equal(typeof email.createEmailProvider,'function');let options;const messages=[];
 const provider=await email.createEmailProvider(config,async value=>{options=value;return {sendMail:async message=>{messages.push(message);return {messageId:'<accepted@example.test>',accepted:['alice@example.test'],rejected:[],response:'250 accepted'};}};});
 assert.deepEqual(await provider.send('Task update','alice@example.test'),{provider_message_id:'<accepted@example.test>'});
 assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.disableFileAccess,true);assert.equal(options.disableUrlAccess,true);
 assert.deepEqual(messages[0].envelope,{from:'bot@example.test',to:['alice@example.test']});assert.equal(messages[0].to,'alice@example.test');assert.equal(messages[0].text,'Task update');assert.equal(messages[0].subject,'Jot task update');
 assert.equal(messages[0].raw,undefined);assert.equal(messages[0].html,undefined);
 await assert.rejects(provider.send('x','a@example.test,b@example.test'));await assert.rejects(provider.send('x','a@example.test\r\nBcc:b@example.test'));assert.equal(messages.length,1);
});
test('invalid SMTP config never creates a transport and unknown provider errors are sanitized',async()=>{
 for(const change of [{port:25},{secure:false},{from:'bot@example.test\nBcc:other'},{host:'http://smtp.example.test'},{password:''}])await assert.rejects(email.createEmailProvider({...config,...change},async()=>{throw new Error('must not create transport');}));
 const provider=await email.createEmailProvider(config,async()=>({sendMail:async()=>{throw new Error('socket timeout test-password');}}));
 await assert.rejects(provider.send('x','alice@example.test'),error=>error.message==='network_email_delivery_ambiguous'&&!error.message.includes(config.password));
 const uncertain=await email.createEmailProvider(config,async()=>({sendMail:async()=>({messageId:'id',accepted:[],rejected:['alice@example.test']})}));
 await assert.rejects(uncertain.send('x','alice@example.test'),/email_provider_receipt_unconfirmed/);
});
