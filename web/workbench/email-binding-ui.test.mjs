import test from 'node:test';
import assert from 'node:assert/strict';
import * as ui from './email-binding-ui.mjs';
test('lost email application response freezes the address and request key until explicit retry',async()=>{
 assert.equal(typeof ui.EmailBindingCommands,'function');const calls=[];let fail=true;
 const commands=new ui.EmailBindingCommands(async(...args)=>{calls.push(args);if(fail)throw new Error('network');return {channel_binding_id:'email-1'};},()=> 'fixed-request-key');
 await assert.rejects(commands.begin('alice@example.test'));assert.equal(commands.beginPending,true);
 fail=false;await commands.begin('different@example.test');assert.deepEqual(calls[1],calls[0]);assert.equal(commands.beginPending,false);
});
test('confirmation retry preserves the proof in memory and known rejection allows correction',async()=>{
 assert.equal(typeof ui.EmailBindingCommands,'function');const calls=[];let error=new Error('network');
 const commands=new ui.EmailBindingCommands(async(...args)=>{calls.push(args);if(error)throw error;return {status:'verified'};},()=> 'confirm-key');
 const original='a'.repeat(43);await assert.rejects(commands.confirm('binding-1',original));
 error=null;await commands.confirm('binding-2','b'.repeat(43));assert.deepEqual(calls[1],calls[0]);assert.equal(commands.confirmPending,false);
 error=Object.assign(new Error('invalid'),{status:422});await assert.rejects(commands.confirm('binding-1',original));assert.equal(commands.confirmPending,false);
 error=null;await commands.confirm('binding-2','b'.repeat(43));assert.match(calls.at(-1)[0],/binding-2/);
});
test('email UI rejects blank addresses and malformed proofs before any network request',async()=>{
 assert.equal(typeof ui.EmailBindingCommands,'function');let calls=0;const commands=new ui.EmailBindingCommands(async()=>{calls++;});
 for(const value of ['', 'a@example.test,b@example.test','a@example.test\r\nBcc:b@example.test'])await assert.rejects(commands.begin(value));
 await assert.rejects(commands.confirm('', 'x'.repeat(43)));await assert.rejects(commands.confirm('binding','short'));assert.equal(calls,0);
});
