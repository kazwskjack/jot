import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import {resolve} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';import {ChannelDeliveryService} from '../../src/channels/delivery.ts';
import {mkdirSync,writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
const old='2026-01-01T00:00:00Z',now='2026-10-08T00:00:00Z';
function fixture(t){const db=openProductDatabase(':memory:');t.after(()=>db.close());const store=new ChannelDeliveryService(db),root=resolve('.test-tmp/notification-maintenance',randomUUID());db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES('c','test-owner','shared','Notes','m',?,?)").run(old,old);
 const add=(id,status='delivered')=>{db.prepare("INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES(?,'c','succeeded',?,?)").run('run-'+id,old,old);db.prepare("INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,payload_json,status,provider_receipt_json,created_at,updated_at) VALUES(?,?,?,'wecom','test-recipient',?,?,?,?,?)").run(id,'run-'+id,'message-'+id,'{"kind":"text","text":"Synthetic cold notice"}',status,status==='delivered'?'{"provider_message_id":"test-receipt"}':null,old,old);};return {db,store,root,add};}
test('maintenance is explicit opt-in and configuration cannot silently enable deletion',async()=>{
 const {notificationArchiveMaintenanceConfig}=await import('../../src/channels/notification-maintenance.ts');
 assert.equal(notificationArchiveMaintenanceConfig({}),undefined);assert.equal(notificationArchiveMaintenanceConfig({GENERAL_AGENT_NOTIFICATION_ARCHIVE_ENABLED:'0'}),undefined);
 assert.throws(()=>notificationArchiveMaintenanceConfig({GENERAL_AGENT_NOTIFICATION_ARCHIVE_ENABLED:'true'}),/configuration_invalid/);
 assert.throws(()=>notificationArchiveMaintenanceConfig({GENERAL_AGENT_NOTIFICATION_ARCHIVE_ENABLED:'1'}),/configuration_invalid/);
 const config=notificationArchiveMaintenanceConfig({GENERAL_AGENT_NOTIFICATION_ARCHIVE_ENABLED:'1',GENERAL_AGENT_NOTIFICATION_ARCHIVE_ROOT:resolve('.test-tmp/cold')});assert.equal(config.retentionDays,90);assert.equal(config.batchSize,10);
});
test('bounded pages advance over protected rows and new host instances resume the same daily cursor',async t=>{
 const f=fixture(t);f.add('a','outcome_unknown');f.add('b');f.add('c');const {NotificationArchiveMaintenance}=await import('../../src/channels/notification-maintenance.ts');let clock=new Date(now);
 const config={root:f.root,retentionDays:90,batchSize:1},host=new NotificationArchiveMaintenance(f.db,config,{now:()=>clock});
 assert.equal(host.processNext().archived,0);assert.equal(f.db.prepare('SELECT cursor FROM wb_task_notification_archive_maintenance').get().cursor,'a');
 const next=new NotificationArchiveMaintenance(f.db,config,{now:()=>clock});assert.equal(next.processNext().archived,1);assert.equal(next.processNext().archived,1);assert.equal(next.processNext().processed,false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,3);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_archives').get().n,2);assert.equal(f.store.get('a').status,'outcome_unknown');
 clock=new Date(Date.parse(now)+86400000);assert.equal(next.processNext().processed,true);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_archives').get().n,2);assert.equal(f.store.claim('test-worker',90),null);
});
test('page checkpoint failure rolls back compaction and restarting retries the same rows',async t=>{
 const f=fixture(t);f.add('a');const {NotificationArchiveMaintenance}=await import('../../src/channels/notification-maintenance.ts'),host=new NotificationArchiveMaintenance(f.db,{root:f.root,retentionDays:90,batchSize:1},{now:()=>new Date(now)}),original=f.store.get('a').payload_json;
 f.db.exec("CREATE TRIGGER test_maintenance_checkpoint BEFORE UPDATE ON wb_task_notification_archive_maintenance BEGIN SELECT RAISE(ABORT,'test_maintenance_checkpoint'); END;");assert.throws(()=>host.processNext(),/test_maintenance_checkpoint/);assert.equal(f.store.get('a').payload_json,original);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_archives').get().n,0);
 f.db.exec('DROP TRIGGER test_maintenance_checkpoint');assert.equal(host.processNext().archived,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_archives').get().n,1);
});

test('archive failure keeps the cursor and hot data, backs off an hour and resumes without losing a notice',async t=>{
 const f=fixture(t);f.add('a');const {NotificationArchiveMaintenance}=await import('../../src/channels/notification-maintenance.ts');let clock=new Date(now);const host=new NotificationArchiveMaintenance(f.db,{root:f.root,retentionDays:90,batchSize:1},{now:()=>clock});
 f.db.exec("CREATE TRIGGER test_archive_failure BEFORE INSERT ON wb_task_notification_archives BEGIN SELECT RAISE(ABORT,'test_archive_failure'); END;");assert.throws(()=>host.processNext(),/test_archive_failure/);
 const state=f.db.prepare('SELECT * FROM wb_task_notification_archive_maintenance').get();assert.equal(state.cursor,'');assert.equal(state.last_error,'notification_archive_maintenance_failed');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_archives').get().n,0);
 f.db.exec('DROP TRIGGER test_archive_failure');clock=new Date(Date.parse(now)+3599000);assert.equal(host.processNext().processed,false);clock=new Date(Date.parse(now)+3600000);assert.equal(host.processNext().archived,1);assert.equal(f.db.prepare('SELECT last_error FROM wb_task_notification_archive_maintenance').get().last_error,null);
});

test('scheduled maintenance compacts an entire cold digest, not just the current page member',async t=>{
 const f=fixture(t);f.add('a');f.add('b');const text='Synthetic summary',hash=createHash('sha256').update(text).digest('hex');f.db.prepare('INSERT INTO wb_task_notification_digests VALUES(?,?,?,?,?)').run('test-digest','a',text,hash,old);for(const [i,id]of ['a','b'].entries())f.db.prepare('INSERT INTO wb_task_notification_digest_members VALUES(?,?,?,?)').run(id,'test-digest',1,i);
 const {NotificationArchiveMaintenance}=await import('../../src/channels/notification-maintenance.ts'),host=new NotificationArchiveMaintenance(f.db,{root:f.root,retentionDays:90,batchSize:1},{now:()=>new Date(now)});assert.equal(host.processNext().archived,2);assert.equal(host.processNext().archived,0);assert.notEqual(f.db.prepare('SELECT payload_text FROM wb_task_notification_digests').get().payload_text,text);assert.equal(f.store.claim('test-worker',90),null);
});

test('the real worker entry point runs explicitly enabled local maintenance without model calls or sends',async t=>{
 const f=fixture(t);f.add('a');mkdirSync(f.root,{recursive:true});const database=resolve(f.root,'worker.sqlite'),token=resolve(f.root,'adapter.token');f.db.prepare('VACUUM INTO ?').run(database);writeFileSync(token,'test-worker-adapter-token-fixture-only');
 const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:f.root,TMP:f.root,NODE_NO_WARNINGS:'1',GENERAL_AGENT_DB:database,GENERAL_AGENT_WORKSPACES:'shared',GENERAL_AGENT_WORKBENCH_ROOT:resolve(f.root,'workspaces'),GENERAL_AGENT_FILE_ROOT:resolve(f.root,'files'),GENERAL_AGENT_HARNESS_CWD:f.root,GENERAL_AGENT_WORKER_CONCURRENCY:'1',GENERAL_AGENT_WORKER_POLL_MS:'250',GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE:token,GENERAL_AGENT_SESSION_ADAPTER_URL:'http://127.0.0.1:1',GENERAL_AGENT_WORKBENCH_EXECUTION_READY:'false',GENERAL_AGENT_MODEL_BUDGET_POLICY_FILE:'',GENERAL_AGENT_TASK_REPLY_EXECUTION:'0',GENERAL_AGENT_NOTIFICATION_ARCHIVE_ENABLED:'1',GENERAL_AGENT_NOTIFICATION_ARCHIVE_ROOT:resolve(f.root,'cold'),GENERAL_AGENT_NOTIFICATION_ARCHIVE_BATCH_SIZE:'1'};
 const child=spawn(process.execPath,['src/harness/main.ts'],{env,stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes.toString();});const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));const check=openProductDatabase(database);t.after(()=>check.close());
 try{let saved=false;for(let i=0;i<80;i++){if(check.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_task_notification_archives'").get()&&check.prepare('SELECT 1 FROM wb_task_notification_archives WHERE effect_id=?').get('a')){saved=true;break;}if(child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(saved,true,stderr);assert.equal(check.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(check.prepare('SELECT status FROM ga_channel_deliveries').get().status,'delivered');assert.equal(check.prepare('SELECT count(*) n FROM wb_task_notification_archive_maintenance').get().n,1);assert.equal(check.prepare("SELECT count(*) n FROM ga_runs WHERE status='running'").get().n,0);
 }finally{child.kill('SIGTERM');await closed;}
 assert.equal(stderr.includes('notification_archive_maintenance_retry'),false,stderr);
});
