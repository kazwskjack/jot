import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { openProductDatabase } from '../../src/db/database.ts';
import { WorkbenchService } from '../../src/workbench/service.ts';
import { PersistentTaskService } from '../../src/persistent-tasks/service.ts';
import { buildServer } from '../../src/server.ts';
const moduleUrl=new URL('../../src/persistent-tasks/scheduler.ts',import.meta.url);
function directory(){const base=resolve('.test-tmp');mkdirSync(base,{recursive:true});return mkdtempSync(join(base,'workbench-scheduler-'));}
test('workbench maintenance scheduler is exported',async()=>{const m=await import(moduleUrl).catch(()=>({}));assert.equal(typeof m.maintainWorkbench,'function');});
test('not-ready maintenance performs revocation cleanup without enqueueing mailbox or scheduled tasks',async()=>{
  const {maintainWorkbench}=await import(moduleUrl);const root=directory();const db=openProductDatabase(join(root,'fixture.sqlite'));
  try{
    const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'workspace')});const tasks=new PersistentTaskService(db,workbench);
    const a=workbench.createAgent('alice',{name:'Reader'});const b=workbench.createAgent('alice',{name:'Writer'});const deleting=workbench.createAgent('alice',{name:'Delete'});
    workbench.sendMessage('alice','ws',{sender_agent_id:a.agent_id,recipient_agent_id:b.agent_id,text:'Read source',client_message_id:'message',auto_reply:true});
    tasks.create('alice',{title:'Check',agent_id:a.agent_id,objective:'Check source',trigger:{kind:'once'}});workbench.beginDeletion('alice',deleting.agent_id,1);
    const result=await maintainWorkbench(workbench,tasks,false);assert.equal(result.execution_ready,false);
    assert.equal(db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);assert.equal(workbench.getAgent('alice',deleting.agent_id).status,'deleted');
    assert.equal(workbench.listMessages('alice','ws').items[0].status,'pending');
    await maintainWorkbench(workbench,tasks,true);assert.equal(db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);
  }finally{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
test('custom database fallback puts config and API workbench roots beside the same database',async()=>{
  const root=directory();const dbPath=join(root,'custom-data','fixture.sqlite');mkdirSync(dirname(dbPath),{recursive:true});
  const configUrl=new URL('../../src/config.ts',import.meta.url).href;
  const script=`import {loadBffConfig} from ${JSON.stringify(configUrl)};const c=loadBffConfig();console.log(JSON.stringify({databasePath:c.databasePath,workbenchRoot:c.workbenchRoot}));`;
  // A wholly synthetic child environment prevents reading real service keys/configuration.
  const fixtureEnv={GENERAL_AGENT_DB:dbPath,GENERAL_AGENT_CSRF_TOKEN:'test-54be3f74f6a84290',GENERAL_AGENT_ALLOWED_ORIGINS:'https://fixture.invalid',GENERAL_AGENT_WORKSPACES:'ws',GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:'test-228ba63be332e3cb'};
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:root,env:fixtureEnv,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);const config=JSON.parse(child.stdout);const expectedRoot=join(dirname(dbPath),'jot-workspaces');assert.equal(config.workbenchRoot,expectedRoot);
  const service=await buildServer({databasePath:dbPath,workspaces:['ws']});
  try{
    assert.equal(existsSync(expectedRoot),true);const agent=service.workbench.createAgent('alice',{name:'Reader'});
    const task=service.persistentTasks.create('alice',{title:'Check',agent_id:agent.agent_id,objective:'Check',trigger:{kind:'once'}});
    const projection=service.persistentTasks.project('alice',task.task_id);assert.equal(projection.directory.startsWith(join(expectedRoot,'tasks')),true);
  }finally{await service.app.close();service.db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
