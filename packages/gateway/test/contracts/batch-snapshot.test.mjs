import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {openProductDatabase} from '../../src/db/database.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {buildSnapshot} from '../../src/events/snapshot.ts';
import {ContractValidator} from '../../src/contracts/validator.ts';

for (const [kind,status] of [['read_page','partial'],['browse','succeeded'],['execute','waiting_confirmation']]) {
  test(`real ${kind} batch projection survives snapshot and event contracts`, () => {
    const db=openProductDatabase(':memory:');
    try {
      const at=new Date().toISOString();
      db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run('conv','owner','ws','test','{"provider":"test","model":"test"}',1,at,at);
      const events=new EventStore(db); const runs=new RunRepository(db,events);
      runs.enqueue('conv','owner',{client_message_id:'m',content:[{type:'text',text:'read pages'}]});
      const coordinator=new HarnessCoordinator(db,runs,events);
      const lease=coordinator.claimNext('worker',30000); coordinator.start(lease); coordinator.bindSession(lease,'session');
      coordinator.recordWebOperationSnapshot(lease,'session','call',{
        operation_id:`web-${'a'.repeat(32)}`,kind,status,revision:1,event_cursor:1,
        events:[{revision:1,event_type:'item.updated',payload:{}}],accepted_count:1,
        counts:{succeeded:0,failed:1},items:[{item_id:'url-0',position:0,inputs:{url:'https://example.org/'},status:'failed',attempt:0,reason_code:'PAGE_TIMEOUT'}],
      });
      const snapshot=buildSnapshot(db,'conv','owner'); const validator=new ContractValidator();
      const op=validator.operationFor('GET','/v1/conversations/:conversationId/snapshot');
      const result=validator.validateResponse(op,200,snapshot);
      assert.equal(result.valid,true,JSON.stringify(result.errors.filter(e=>!e.schemaPath.includes('Activity_')||e.schemaPath.includes('Activity_browse'))));
      const doc=JSON.parse(readFileSync(new URL('../../contracts/agent-event.schema.json',import.meta.url)));
      const ajv=new Ajv2020({strict:false});addFormats(ajv);
      const validate=ajv.compile({$defs:doc.$defs,$ref:'#/$defs/Activity'});
      assert.equal(validate(snapshot.activities[0]),true,JSON.stringify(validate.errors));
      for (const mutate of [a=>a.detail.unexpected='private',a=>a.detail.counts.failed=-1,a=>a.detail.items[0].inputs={secret:'x'},a=>a.status='invented']) {
        const bad=structuredClone(snapshot);mutate(bad.activities[0]);
        assert.equal(validator.validateResponse(op,200,bad).valid,false);
        assert.equal(validate(bad.activities[0]),false);
      }
    } finally { db.close(); }
  });
}
