import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import Ajv from 'ajv/dist/2020.js';
test('runless replies validate as completed assistant events but never as user inputs',async()=>{
 const schema=JSON.parse(await readFile(new URL('../../contracts/agent-event.schema.json',import.meta.url),'utf8')),validate=new Ajv({strict:false,validateFormats:false}).compile(schema);
 const event={schema_version:'1.0',event_id:'test-event',conversation_id:'test-chat',run_id:null,seq:'1',at:'2026-10-05T00:00:00Z',type:'message.created',payload:{message_id:'test-reply',run_id:null,role:'assistant',status:'complete',blocks:[{block_id:'test-block',kind:'text',text:'A reviewed reply',exposure:'public'}],created_at:'2026-10-05T00:00:00Z'}};
 assert.equal(validate(event),true,JSON.stringify(validate.errors));for(const payload of [{...event.payload,role:'user'},{...event.payload,status:'streaming'}])assert.equal(validate({...event,payload}),false);
 assert.equal(validate({...event,payload:{...event.payload,run_id:'test-run'}}),false);assert.equal(validate({...event,run_id:'test-run'}),false);
});
