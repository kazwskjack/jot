import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';

test('WorkbenchService exposes an import facade that reuses project authorization and saveMemory',t=>{
 const base=resolve('.test-tmp/memory-import-service');mkdirSync(base,{recursive:true});
 const root=mkdtempSync(join(base,'case-')),db=openProductDatabase(join(root,'db.sqlite'));
 const service=new WorkbenchService(db,{workspaceIds:['source-ws','target-ws'],root:join(root,'files')}),agent=service.createAgent('alice',{name:'Import owner'});
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const source=service.saveMemory('alice','source-ws',{scope:'project',project_id:agent.project_id,content:'Project decision',verified:true});
 const document=service.exportMemory('alice','source-ws'),input={import_id:'service-import-1',document,target:{scope:'project',project_id:agent.project_id}};
 assert.equal(typeof service.memoryImports?.preview,'function');
 const preview=service.memoryImports.preview('alice','target-ws',input);
 assert.equal(preview.items[0].source_version,source.version);assert.equal(preview.items[0].status,'ready');
 assert.throws(()=>service.memoryImports.preview('bob','target-ws',input),/project_not_found|memory_scope_forbidden/);
 const receipt=service.memoryImports.apply('alice','target-ws',{import_id:input.import_id,expected_version:preview.version});
 assert.equal(receipt.items[0].status,'created');
 const imported=db.prepare('SELECT verified,content FROM wb_memories WHERE owner_id=? AND workspace_id=? AND memory_id=?').get('alice','target-ws',receipt.items[0].memory_id);
 assert.equal(imported.verified,0);assert.equal(imported.content,'Project decision');
});
