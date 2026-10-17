import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import Fastify from 'fastify';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {registerWorkbenchRoutes} from '../../src/workbench/routes.ts';
import {ProjectRepository} from '../../src/projects/repository.ts';
import {ContractValidator} from '../../src/contracts/validator.ts';
import {readFileSync} from 'node:fs';
const base=resolve('../../.test-tmp/file-list-pagination');mkdirSync(base,{recursive:true});
function fixture(t){
 const dir=mkdtempSync(join(base,'case-')),db=openProductDatabase(join(dir,'db.sqlite'));
 const service=new WorkbenchService(db,{workspaceIds:['ws','other'],root:join(dir,'shared')});
 const agent=service.createAgent('owner',{name:'Reader'});
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 // Metadata-only fixture: listing must not read blobs, create project trees or model runs.
 const insert=db.prepare('INSERT INTO wb_files VALUES(?,?,?,?,?,?,?,?,?)');
 db.exec('BEGIN');for(let index=0;index<405;index++)insert.run('owner','ws',agent.project_id,`notes/${String(index).padStart(4,'0')}.txt`,1,'a'.repeat(64),1,`blob-${index}`,new Date(0).toISOString());db.exec('COMMIT');
 return {db,service,project:agent.project_id,dir};
}
test('default files page retains items and all 405 paths are reachable without duplicate or truncation',t=>{
 const {service,project}=fixture(t),paths=[];let cursor;
 do{const page=service.listFiles('owner','ws',project,undefined,{cursor});assert.ok(page.items.length<=200);paths.push(...page.items.map(item=>item.path));cursor=page.next_cursor;}while(cursor);
 assert.equal(paths.length,405);assert.equal(new Set(paths).size,405);assert.deepEqual(paths,[...paths].sort());
});
test('cursors survive service reopen but refuse tampering, foreign scope and invalid bounds',t=>{
 const {service,db,project,dir}=fixture(t),first=service.listFiles('owner','ws',project,undefined,{limit:2});
 const reopened=new WorkbenchService(db,{workspaceIds:['ws','other'],root:join(dir,'shared')});
 assert.deepEqual(reopened.listFiles('owner','ws',project,undefined,{limit:3,cursor:first.next_cursor}).items.map(row=>row.path),['notes/0002.txt','notes/0003.txt','notes/0004.txt']);
 assert.throws(()=>service.listFiles('foreign','ws',project,undefined,{cursor:first.next_cursor}),/project_not_found/);
 assert.throws(()=>service.listFiles('owner','unconfigured',project),/workspace_not_found/);
 assert.throws(()=>service.listFiles('owner','other',project,undefined,{cursor:first.next_cursor}),/invalid_file_list_cursor/);
 const another=new ProjectRepository(db).create('owner',{title:'Other'}).project_id;
 assert.throws(()=>service.listFiles('owner','ws',another,undefined,{cursor:first.next_cursor}),/invalid_file_list_cursor/);
 for(const cursor of ['bad',first.next_cursor.slice(0,-1)+'!',first.next_cursor.split('.')[0]+'.'+'A'.repeat(43)])assert.throws(()=>service.listFiles('owner','ws',project,undefined,{cursor}),/invalid_file_list_cursor/);
 for(const limit of [0,201,-1,1.1,'2'])assert.throws(()=>service.listFiles('owner','ws',project,undefined,{limit}),/invalid_file_list_query/);
 assert.deepEqual(readdirSync(join(dir,'shared')),[],'listing creates no project/blob directory');
});
test('any current scoped inventory change refuses mixed-page continuation; other scope writes do not',t=>{
 const {service,db,project}=fixture(t),first=service.listFiles('owner','ws',project,undefined,{limit:3});
 db.prepare('INSERT INTO wb_files VALUES(?,?,?,?,?,?,?,?,?)').run('owner','other',project,'unrelated.txt',1,'b'.repeat(64),1,'other-blob',new Date(0).toISOString());
 assert.equal(service.listFiles('owner','ws',project,undefined,{cursor:first.next_cursor}).items.length,200);
 db.prepare('UPDATE wb_files SET version=version+1 WHERE path=? AND workspace_id=?').run('notes/0404.txt','ws');
 assert.throws(()=>service.listFiles('owner','ws',project,undefined,{cursor:first.next_cursor}),/file_list_state_conflict/);
 const refreshed=service.listFiles('owner','ws',project,undefined,{limit:200});
 db.prepare('DELETE FROM wb_files WHERE path=?').run('notes/0001.txt');
 assert.throws(()=>service.listFiles('owner','ws',project,undefined,{cursor:refreshed.next_cursor}),/file_list_state_conflict/);
});
test('listing under another connection writer reservation remains read-only and detects later insertion',t=>{
 const {service,project,dir}=fixture(t),other=openProductDatabase(join(dir,'db.sqlite'));
 try{
  other.exec('BEGIN IMMEDIATE');
  let first;try{first=service.listFiles('owner','ws',project,undefined,{limit:2});assert.equal(first.items.length,2);}finally{other.exec('ROLLBACK');}
  other.prepare('INSERT INTO wb_files VALUES(?,?,?,?,?,?,?,?,?)').run('owner','ws',project,'notes/new.txt',1,'a'.repeat(64),1,'new-blob',new Date(0).toISOString());
  assert.throws(()=>service.listFiles('owner','ws',project,undefined,{cursor:first.next_cursor}),/file_list_state_conflict/);
 }finally{other.close();}
});
test('cursor expiry and actual process-independent key survive reopen; run-scoped old calls keep items',t=>{
 const {service,db,project,dir}=fixture(t),first=service.listFiles('owner','ws',project,undefined,{limit:1}),now=Date.now;
 Date.now=()=>now()+86400001;try{assert.throws(()=>service.listFiles('owner','ws',project,undefined,{cursor:first.next_cursor}),/invalid_file_list_cursor/);}finally{Date.now=now;}
 const other=openProductDatabase(join(dir,'db.sqlite'));try{
  const reopened=new WorkbenchService(other,{workspaceIds:['ws','other'],root:join(dir,'shared')});
  assert.equal(reopened.listFiles('owner','ws',project,undefined,{limit:1,cursor:first.next_cursor}).items[0].path,'notes/0001.txt');
 }finally{other.close();}
 const agent=service.listAgents('owner').items[0],queued=service.enqueueAgentMessage('owner',agent.agent_id,{text:'read files',client_message_id:'old-files-list'});
 assert.equal(service.listFiles('owner','ws',project,queued.run_id).items.length,200);
 const another=new ProjectRepository(db).create('owner',{title:'Other'}).project_id;
 assert.throws(()=>service.listFiles('owner','ws',another,queued.run_id),/file_scope_forbidden/);
});
test('GET files validates query and exposes all original scoped pages through the route',async t=>{
 const {service,project}=fixture(t),app=Fastify();
 app.setErrorHandler((error,_request,reply)=>reply.code(error.message==='file_list_state_conflict'?409:error.message.includes('not_found')?404:400).send({error:error.message}));
 registerWorkbenchRoutes(app,service,request=>String(request.headers['x-user-id']??''));t.after(()=>app.close());
 const url=`/v1/workspaces/ws/files?project_id=${project}`,headers={'x-user-id':'owner'};
 const first=await app.inject({url,headers});assert.equal(first.statusCode,200);assert.equal(first.json().items.length,200);
 const second=await app.inject({url:url+'&cursor='+encodeURIComponent(first.json().next_cursor),headers});assert.equal(second.json().items[0].path,'notes/0200.txt');
 for(const query of ['limit=0','limit=201','limit=01','limit=2.5','limit=2&limit=3','cursor=','extra=x'])assert.equal((await app.inject({url:url+'&'+query,headers})).statusCode,400,query);
 assert.equal((await app.inject({url,headers:{'x-user-id':'other-owner'}})).statusCode,404);
});
test('public file paging contract documents bounds and accepts the actual page',t=>{
 const {service,project}=fixture(t),spec=JSON.parse(readFileSync(new URL('../../contracts/openapi.json',import.meta.url),'utf8'));
 const params=spec.paths['/v1/workspaces/{workspace_id}/files'].get.parameters;
 assert.deepEqual(params.find(p=>p.name==='limit')?.schema,{type:'integer',minimum:1,maximum:200,default:200});
 assert.equal(params.find(p=>p.name==='cursor')?.schema.maxLength,2048);
 const validator=new ContractValidator();assert.equal(validator.validateResponse('listWorkbenchFiles',200,service.listFiles('owner','ws',project)).valid,true);
});
