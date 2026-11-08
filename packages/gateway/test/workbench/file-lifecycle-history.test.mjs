import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openProductDatabase} from '../../src/db/database.ts';
import {canonicalJson} from '../../src/db/canonical-json.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {buildServer} from '../../src/server.ts';
import {ContractValidator} from '../../src/contracts/validator.ts';
import {ProjectRepository} from '../../src/projects/repository.ts';

const base=resolve(fileURLToPath(new URL('../../../../.test-tmp/lifecycle-history/',import.meta.url)));
mkdirSync(base,{recursive:true});
const hash=value=>createHash('sha256').update(value).digest('hex'),when='2026-10-23T00:00:00.000Z';
function fixture(t){
 const root=mkdtempSync(join(base,'service-')),databasePath=join(root,'db.sqlite'),options={workspaceIds:['main','other'],root:join(root,'shared')};
 let db=openProductDatabase(databasePath),service=new WorkbenchService(db,options);
 const a=service.createAgent('alice',{name:'History owner'}),b=service.createAgent('bob',{name:'Other owner'}),secondProject=new ProjectRepository(db).create('alice',{title:'History second project'}),a2=service.createAgent('alice',{name:'Second project',project_id:secondProject.project_id}),beforeClose=[];
 t.after(()=>{for(const close of beforeClose)close();db.close();const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true});});
 return{root,databasePath,a,b,a2,beforeClose,get db(){return db;},get service(){return service;},reopen(){db.close();db=openProductDatabase(databasePath);service=new WorkbenchService(db,options);}};
}
// Synthetic committed rows in the ORIGINAL immutable journal, not a repair or
// replacement store. HTTP coverage below also creates a real apply receipt.
function seed(db,project,key,options={}){
 const owner=options.owner??'alice',workspace=options.workspace??'main',at=options.at??when;
 const receipt={protocol:1,action:'delete',command_key:key,project_id:project,workspace_id:workspace,
  source:{path:'notes/source.txt',version:1,sha256:hash('source'),size:6,updated_at:when},source_refs:[],preview_sha256:'a'.repeat(64),applied_at:at};
 const request={action:receipt.action,workspace_id:workspace,project_id:project,path:receipt.source.path,expected_version:1,preview_sha256:receipt.preview_sha256};
 const value=options.mutate?options.mutate(structuredClone(receipt)):receipt;
 const json=options.json??canonicalJson(value);
 db.prepare('INSERT INTO wb_file_lifecycle_commands VALUES(?,?,?,?,?,?,?,?)').run(owner,workspace,project,key,options.requestHash??hash(canonicalJson(request)),json,options.receiptHash??hash(json),options.rowTime??at);
 return value;
}
const query=(f,input={},owner='alice',workspace='main')=>f.service.listFileLifecycleHistory(owner,workspace,{project_id:f.a.project_id,...input});

test('history query is scoped, empty and does not create database writes',t=>{
 const f=fixture(t);assert.equal(typeof f.service.listFileLifecycleHistory,'function');
 const before=f.db.prepare('SELECT total_changes() n').get().n;
 assert.deepEqual(query(f),{items:[],next_cursor:null});assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 seed(f.db,f.a.project_id,'history-alice-001');seed(f.db,f.b.project_id,'history-bob-001',{owner:'bob'});seed(f.db,f.a2.project_id,'history-other-project');seed(f.db,f.a.project_id,'history-other-workspace',{workspace:'other'});
 assert.deepEqual(query(f).items.map(x=>x.command_key),['history-alice-001']);
 assert.throws(()=>query(f,{},'bob'),/project_not_found/);assert.throws(()=>query(f,{},'alice','unconfigured'),/workspace_not_found/);
 assert.deepEqual(query(f,{project_id:f.a2.project_id}).items.map(x=>x.command_key),['history-other-project']);
 assert.deepEqual(Object.keys(query(f)).sort(),['items','next_cursor']);assert.doesNotMatch(JSON.stringify(query(f).items),/receipt_json|rowid|blob_name|server_path|credential|secret/);
});

test('history accepts only project limit cursor and enforces default50 range1..100',t=>{
 const f=fixture(t);for(let n=0;n<55;n++)seed(f.db,f.a.project_id,'history-limit-'+String(n).padStart(3,'0'));
 assert.equal(query(f).items.length,50);assert.equal(query(f,{limit:100}).items.length,55);
 for(const input of [{limit:0},{limit:101},{limit:1.5},{limit:'2'},{limit:null},{cursor:''},{cursor:'x'.repeat(2049)},{owner_id:'alice'},{path:'notes/source.txt'},{sort:'asc'},{project_id:''}])assert.throws(()=>query(f,input),/invalid_/);
});

test('history keyset pages same-millisecond keys exactly once and cursor survives reopen',t=>{
 const f=fixture(t);for(let n=1;n<=5;n++)seed(f.db,f.a.project_id,'history-tie-'+String(n).padStart(3,'0'));
 const first=query(f,{limit:2});assert.deepEqual(first.items.map(x=>x.command_key),['history-tie-005','history-tie-004']);assert.equal(typeof first.next_cursor,'string');
 f.reopen();const second=query(f,{limit:2,cursor:first.next_cursor}),third=query(f,{limit:2,cursor:second.next_cursor});
 assert.deepEqual(second.items.map(x=>x.command_key),['history-tie-003','history-tie-002']);assert.deepEqual(third.items.map(x=>x.command_key),['history-tie-001']);assert.equal(third.next_cursor,null);
 const repeat=query(f,{limit:2,cursor:first.next_cursor});assert.deepEqual(repeat.items,second.items,'same cursor observes the same original snapshot');assert.deepEqual(query(f,{limit:2,cursor:repeat.next_cursor}).items,third.items,'randomized continuation preserves the same boundary');
 assert.throws(()=>query(f,{cursor:first.next_cursor,project_id:f.a2.project_id}),/invalid_file_lifecycle_history_cursor/);
 assert.throws(()=>query(f,{cursor:first.next_cursor},'alice','other'),/invalid_file_lifecycle_history_cursor/);
 assert.throws(()=>query(f,{cursor:first.next_cursor,project_id:f.b.project_id},'bob'),/invalid_file_lifecycle_history_cursor/);
 const tampered=first.next_cursor.slice(0,-8)+(first.next_cursor.at(-8)==='A'?'B':'A')+first.next_cursor.slice(-7);
 for(const cursor of [tampered,'not-a-cursor',first.next_cursor+'.extra'])assert.throws(()=>query(f,{cursor}),/invalid_file_lifecycle_history_cursor/);
});

test('history snapshot watermark excludes later same-millisecond and backdated appends',t=>{
 const f=fixture(t);for(let n=1;n<=4;n++)seed(f.db,f.a.project_id,'history-snapshot-'+String(n).padStart(3,'0'));
 const first=query(f,{limit:2});seed(f.db,f.a.project_id,'history-snapshot-000');seed(f.db,f.a.project_id,'history-backdated',{at:'2020-01-01T00:00:00.000Z'});
 const rest=query(f,{limit:100,cursor:first.next_cursor});assert.deepEqual(rest.items.map(x=>x.command_key),['history-snapshot-002','history-snapshot-001']);
 assert.equal(query(f,{limit:100}).items.length,6);assert.equal(rest.next_cursor,null);
});

test('history watermark and first page share one read snapshot and do not block an existing writer',t=>{
 const f=fixture(t);seed(f.db,f.a.project_id,'history-read-initial');const peer=openProductDatabase(f.databasePath);f.beforeClose.push(()=>peer.close());
 peer.exec('BEGIN IMMEDIATE');seed(peer,f.a.project_id,'history-uncommitted');assert.equal(query(f).items.length,1);peer.exec('COMMIT');assert.equal(query(f).items.length,2);
 const originalPrepare=f.db.prepare.bind(f.db),originalExec=f.db.exec.bind(f.db),observed=[];let inserted=false;
 f.db.exec=sql=>{observed.push(sql);return originalExec(sql);};
 f.db.prepare=sql=>{const statement=originalPrepare(sql);if(/MAX\(rowid\)/i.test(sql)){return{get(...args){assert.equal(f.db.isTransaction,true);const result=statement.get(...args);if(!inserted){inserted=true;seed(peer,f.a.project_id,'history-concurrent-page');}return result;}};}if(/ORDER BY.*created_at/is.test(sql))assert.equal(f.db.isTransaction,true);return statement;};
 try{assert.equal(query(f).items.length,2);assert.equal(inserted,true);assert.equal(f.db.isTransaction,false);assert.deepEqual(observed,['BEGIN','COMMIT']);}
 finally{f.db.prepare=originalPrepare;f.db.exec=originalExec;}
 assert.equal(query(f).items.length,3);
});

test('history fails closed on canonical hash row identity request or public-field corruption',t=>{
 const cases=[{json:'{'},{receiptHash:'0'.repeat(64)},{mutate:r=>({...r,command_key:'history-wrong-key'})},{mutate:r=>({...r,project_id:'project-substituted'})},{rowTime:'2020-01-01T00:00:00.000Z'},{requestHash:'b'.repeat(64)},{mutate:r=>({...r,source:{...r.source,server_path:'private'}})},{mutate:r=>({...r,source_refs:[{kind:'file_write_run',secret:'private'}]})},{mutate:r=>({...r,source:{...r.source,path:'C:/private'}})}];
 for(const [n,bad]of cases.entries()){const f=fixture(t);seed(f.db,f.a.project_id,'history-corrupt-'+n,bad);assert.throws(()=>query(f),/file_lifecycle_receipt_unavailable/);assert.equal(f.db.isTransaction,false);}
 const f=fixture(t),valid=seed(f.db,f.a.project_id,'history-noncanonical');
 // Insert a fresh synthetically noncanonical receipt; no immutable trigger bypass.
 const json=JSON.stringify({...valid,command_key:'history-format-bad'});seed(f.db,f.a.project_id,'history-format-bad',{json});assert.throws(()=>query(f),/file_lifecycle_receipt_unavailable/);
});

test('history rejects a local transaction containing uncommitted receipts',t=>{
 const f=fixture(t);seed(f.db,f.a.project_id,'history-local-committed');
 f.db.exec('BEGIN IMMEDIATE');
 try{seed(f.db,f.a.project_id,'history-local-uncommitted');assert.throws(()=>query(f),/file_lifecycle_receipt_unavailable/);assert.equal(f.db.isTransaction,true);}
 finally{f.db.exec('ROLLBACK');}
 assert.deepEqual(query(f).items.map(x=>x.command_key),['history-local-committed']);
});

test('history validates the lookahead row instead of silently hiding corruption',t=>{
 const f=fixture(t);seed(f.db,f.a.project_id,'history-peek-z');seed(f.db,f.a.project_id,'history-peek-a',{receiptHash:'0'.repeat(64)});
 assert.throws(()=>query(f,{limit:1}),/file_lifecycle_receipt_unavailable/);
});

test('history normalizes unavailable journal and cursor-key storage reads',t=>{
 for(const source of ['journal','cursor-key']){
  const f=fixture(t);seed(f.db,f.a.project_id,'history-storage-001');seed(f.db,f.a.project_id,'history-storage-002');
  const prepare=f.db.prepare.bind(f.db);f.db.prepare=sql=>{
   if(source==='journal'?/FROM wb_file_lifecycle_commands/.test(sql):/SELECT key_hex FROM ga_conversation_cursor_key/.test(sql))throw new Error('SQLITE_CORRUPT private-storage-details');
   return prepare(sql);
  };
  try{assert.throws(()=>query(f,{limit:1}),/^Error: file_lifecycle_receipt_unavailable$/);assert.equal(f.db.isTransaction,false);}
  finally{f.db.prepare=prepare;}
 }
});

test('history HTTP uses original applied receipts, strict query bounds and explicit unavailable error',async t=>{
 const root=mkdtempSync(join(base,'api-')),templates=join(root,'templates');mkdirSync(templates);const bytes=Buffer.from('Synthetic template; no render');writeFileSync(join(templates,'fixture.docx'),bytes);writeFileSync(join(templates,'catalog.json'),JSON.stringify({templates:[{template_id:'history-fixture',version:'1',format:'docx',file:'fixture.docx',sha256:hash(bytes),fields:{}}]}));
 const origin='https://history.fixture.example',csrf='synthetic-history-csrf',service=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['main'],workbenchRoot:join(root,'shared'),uploadRoot:join(root,'uploads'),templateRoot:templates,csrfToken:csrf,allowedOrigins:[origin]});
 t.after(async()=>{await service.app.close();service.db.close();rmSync(root,{recursive:true,force:true});});
 const http=(method,url,payload,owner='alice',key='history-http-request-001')=>service.app.inject({method,url,payload,headers:{'x-user-id':owner,origin,'x-csrf-token':csrf,'idempotency-key':key}});
 const agent=(await http('POST','/v1/agents',{name:'History HTTP',instructions:'Synthetic',workspace_id:'main'})).json();
 const url='/v1/workspaces/main/files/lifecycle-history?project_id='+encodeURIComponent(agent.project_id);
 const empty=await http('GET',url);assert.equal(empty.statusCode,200,empty.body);assert.deepEqual(empty.json(),{items:[],next_cursor:null});assert.match(empty.headers['cache-control'],/private.*no-store/);
 assert.equal((await http('PUT','/v1/workspaces/main/files',{project_id:agent.project_id,path:'source.txt',content:'Original',expected_version:0})).statusCode,200);
 const preview=(await http('GET',`/v1/workspaces/main/files/delete-preview?project_id=${encodeURIComponent(agent.project_id)}&path=source.txt&expected_version=1`)).json();
 const receiptResponse=await http('POST','/v1/workspaces/main/files/delete',{project_id:agent.project_id,path:'source.txt',expected_version:1,preview_sha256:preview.preview_sha256},'alice','history-http-delete-001');assert.equal(receiptResponse.statusCode,200,receiptResponse.body);
 const page=await http('GET',url+'&limit=1');assert.equal(page.statusCode,200,page.body);assert.deepEqual(page.json().items,[receiptResponse.json()]);
 const validator=new ContractValidator(),operation=validator.operationFor('GET','/v1/workspaces/:workspaceId/files/lifecycle-history');assert.ok(operation);assert.equal(validator.validateResponse(operation,200,page.json()).valid,true);
 assert.equal((await http('GET',url,undefined,'bob')).statusCode,404);
 for(const suffix of ['&owner_id=bob','&path=source.txt','&sort=asc','&limit=0','&limit=101','&limit=1.5','&limit=1&limit=2','&cursor=bad'])assert.equal((await http('GET',url+suffix)).statusCode,422,suffix);
 const prepare=service.db.prepare.bind(service.db);service.db.prepare=sql=>{if(/FROM wb_file_lifecycle_commands/.test(sql))throw new Error('SQLITE_CORRUPT private-storage-details');return prepare(sql);};
 try{const unavailable=await http('GET',url);assert.equal(unavailable.statusCode,503,unavailable.body);assert.deepEqual(unavailable.json(),{error:{code:'FILE_LIFECYCLE_RECEIPT_UNAVAILABLE'}});assert.equal(validator.validateResponse(operation,503,unavailable.json()).valid,true);}
 finally{service.db.prepare=prepare;}
 const versions=await http('GET',`/v1/workspaces/main/files/versions?project_id=${encodeURIComponent(agent.project_id)}&path=source.txt`);assert.equal(versions.statusCode,200,versions.body);assert.equal(versions.json().items[0].version,1);
 seed(service.db,agent.project_id,'history-http-broken',{at:'2099-01-01T00:00:00.000Z',receiptHash:'0'.repeat(64)});
 const bad=await http('GET',url);assert.equal(bad.statusCode,503,bad.body);assert.deepEqual(bad.json(),{error:{code:'FILE_LIFECYCLE_RECEIPT_UNAVAILABLE'}});assert.doesNotMatch(bad.body,/receipt_json|server_path|rowid/);
});
