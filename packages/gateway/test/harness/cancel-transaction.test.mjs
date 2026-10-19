import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {RunCommandService} from '../../src/runs/commands.ts';

// Commit a competing worker update at the transaction-acquisition boundary.
// Both connections use the real schema and SQLite locking, not a fake row store.
for (const change of ['status', 'version', 'owner']) {
  test(`cancellation refuses a competing ${change} change committed before its write lock`, () => {
    const root=mkdtempSync(join(tmpdir(),'jot-cancel-lock-'));
    const path=join(root,'product.sqlite'),db=openProductDatabase(path),peer=openProductDatabase(path);
    try {
      const events=new EventStore(db),runs=new RunRepository(db,events);
      db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run('conv','owner','workspace','Synthetic','{}',1,'now','now');
      const receipt=runs.enqueue('conv','owner',{client_message_id:'original',content:[{type:'text',text:'Synthetic request'}]});
      db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(receipt.run_id);
      const version=runs.get(receipt.run_id,'owner').version;
      let injected=false;
      const connection=new Proxy(db,{get(target,key){
        if(key==='exec')return sql=>{
          if(sql==='BEGIN IMMEDIATE'&&!injected){
            injected=true;
            if(change==='status')peer.prepare("UPDATE ga_runs SET status='cancelled',version=version+1 WHERE id=?").run(receipt.run_id);
            else if(change==='version')peer.prepare('UPDATE ga_runs SET version=version+1 WHERE id=?').run(receipt.run_id);
            else peer.prepare("UPDATE ga_conversations SET owner_id='other-owner' WHERE id='conv'").run();
          }
          return target.exec(sql);
        };
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
      const commands=new RunCommandService(connection,events);
      assert.throws(()=>commands.cancel(receipt.run_id,'owner',{expected_run_version:version},'cancel-lock'),
        new RegExp(change==='status'?'run_(state|version)_conflict':change==='version'?'run_version_conflict':'run_not_found'));
      assert.equal(injected,true);
      assert.equal(db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,0);
      assert.equal(db.isTransaction,false);
    } finally {peer.close();db.close();rmSync(root,{recursive:true,force:true});}
  });
}
