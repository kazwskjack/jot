import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';import {join,relative,isAbsolute,resolve} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
const script=new URL('../../src/channels/notification-retention-report.ts',import.meta.url),base=resolve('.test-tmp/notification-retention-cli');
function run(args){return spawnSync(process.execPath,[script.pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'),...args],{encoding:'utf8',timeout:10000,env:{...process.env,TEMP:'.test-tmp/runtime',TMP:'.test-tmp/runtime'}});}
test('notification inventory CLI opens the database read-only without schema migrations or private message output',t=>{
 mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),path=join(root,'state.sqlite');t.after(()=>{const rel=relative(base,root);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(root,{recursive:true,force:true});});
 const db=openProductDatabase(path);db.exec(`INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES('c','o','w','private title','m','2026-01-01','2026-01-01');INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES('r','c','succeeded','2026-01-01','2026-01-01');
 INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,payload_json,status,provider_receipt_json,created_at,updated_at) VALUES('effect','r','m','wecom','private recipient','{"kind":"text","text":"private payload"}','delivered','{"provider_message_id":"private receipt"}','2026-01-01','2026-01-01');`);db.close();
 const hash=()=>createHash('sha256').update(readFileSync(path)).digest('hex'),before=hash(),result=run([path,'2026-10-04T00:00:00Z']);assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.mode,'dry-run');assert.equal(report.candidates.length,1);assert.equal(report.candidates[0].deletable,false);assert.ok(!result.stdout.includes('private'));assert.equal(hash(),before);
});
test('notification inventory CLI failures never imply an empty successful report or echo a database path',()=>{
 const missing=join(base,'not-created-sensitive-name.sqlite'),result=run([missing]);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.ok(result.stderr.includes('notification_retention_inventory_failed'));assert.ok(!result.stderr.includes(missing));assert.equal(run([]).status,2);
});
