import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {createAdapterHandler} from '../index.js';
const implementation=await import('../chat-mode-readiness.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const policy={protocol:1,mode:'chat',model:{provider:'fixture',model:'fast'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-native-v1',context_revision:'bounded-v1'};
const prerequisites=()=>({enabled:true,policy,mounted:{presetId:'jot-chat',revision:'chat-native-v1'},context:true,web:true,modelSelection:true,admission:true});
test('native Chat readiness is opt-in, detached and requires all configured execution prerequisites',()=>{
 assert.equal(typeof implementation.createChatModeReadiness,'function');const create=implementation.createChatModeReadiness;assert.deepEqual(create({})(),{protocol:1,ready:false,policy:null});
 const config=prerequisites(),read=create(config);config.policy.model.model='changed';const a=read();assert.equal(a.ready,true);assert.equal(a.policy.model.model,'fast');a.policy.model.model='changed-again';assert.equal(read().policy.model.model,'fast');assert.equal(Object.hasOwn(read(),'execution_authorized'),false);
 for(const field of ['context','web','modelSelection','admission'])assert.throws(()=>create({...prerequisites(),[field]:false}),/chat_mode_readiness_config_invalid/);
 assert.throws(()=>create({...prerequisites(),mounted:{presetId:'jot-chat',revision:'other'}}),/chat_mode_readiness_config_invalid/);
 assert.throws(()=>create({...prerequisites(),policy:{...policy,thinking:'provider'}}),/chat_mode_readiness_config_invalid/);
 assert.throws(()=>create({...prerequisites(),enabled:'true'}),/chat_mode_readiness_config_invalid/);
});
test('native readiness route authenticates, rejects configuration inputs and performs only a read',async()=>{
 const token=randomBytes(32).toString('hex');let calls=0;const handler=createAdapterHandler({controller:{},token,chatModeReadiness:()=>{calls++;return{protocol:1,ready:true,policy};}});
 const request=(body={},method='POST',authorization='Bearer '+token)=>handler({method,url:new URL('http://127.0.0.1/v1/conversation-modes/readiness'),headers:{authorization},body});
 assert.equal((await request({},'POST','Bearer wrong-fixture')).status,401);assert.equal((await request({mode:'chat'})).status,422);assert.equal((await request({},'GET')).status,405);assert.equal(calls,0);const result=await request();assert.equal(result.status,200);assert.equal(calls,1);
 const disabled=createAdapterHandler({controller:{},token});const response=await disabled({method:'POST',url:new URL('http://127.0.0.1/v1/conversation-modes/readiness'),headers:{authorization:'Bearer '+token},body:{}});assert.equal(response.status,200);assert.deepEqual(response.value,{protocol:1,ready:false,policy:null});
});
