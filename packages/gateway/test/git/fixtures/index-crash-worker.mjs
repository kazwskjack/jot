import {DatabaseSync} from 'node:sqlite';
import {GitIndexEffects} from '../../../src/git/index-effects.ts';
import {withImmediateTransaction} from '../../../src/db/database.ts';
const [root,database,phase]=process.argv.slice(2),db=new DatabaseSync(database),kernel=new GitIndexEffects({root});
const witness=JSON.parse(db.prepare('SELECT witness_json FROM original_source').get().witness_json),plan=await kernel.prepareIndex(witness,'stage');
await kernel.applyIndex(plan,{
 authorize(){},
 dispatch(evidence){db.prepare('INSERT INTO physical_evidence VALUES(?)').run(JSON.stringify(evidence));if(phase==='before_publication')process.exit(73);},
 commit:publish=>withImmediateTransaction(db,()=>{const receipt=publish();db.prepare('INSERT INTO physical_outcome VALUES(?)').run(JSON.stringify(receipt));if(phase==='after_publication')process.exit(73);return receipt;})
});db.close();
