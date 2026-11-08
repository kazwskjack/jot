import {existsSync,readFileSync,writeFileSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {setup} from './mattermost-owner-test-support.mjs';
const [root,mode]=process.argv.slice(2),metadata=join(root,'synthetic-provider-source.json');
assert.ok(['observed','accepted','recover-observed','recover-accepted'].includes(mode));
const summary=()=>({pid:process.pid,observations:f.product.db.prepare('SELECT * FROM ga_mattermost_ingress_observations').all(),proofs:f.product.db.prepare('SELECT * FROM ga_mattermost_owner_proofs').all(),bindings:f.product.db.prepare("SELECT channel_binding_id,owner_id,principal,status,version FROM ga_owner_channel_bindings WHERE channel='mattermost'").all(),runs:f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,requests:f.gateway});
let f;
f=await setup({after(){}},{root,...(existsSync(metadata)?{challenge:JSON.parse(readFileSync(metadata,'utf8'))}:{}),beforeIntake(){if(mode==='observed'){writeSync(1,JSON.stringify(summary())+'\n');process.exit(78);}},afterIntake(response){if(mode==='accepted'){assert.equal(response.statusCode,202,response.body);writeSync(1,JSON.stringify(summary())+'\n');process.exit(79);}}});
// This file represents the controlled synthetic provider's original post; no real credentials or source.
if(!existsSync(metadata))writeFileSync(metadata,JSON.stringify(f.challenge));
try{
 await f.start();if(!mode.startsWith('recover-'))await f.emit();
 assert.ok(mode.startsWith('recover-'),'fault checkpoint not reached');
 assert.deepEqual(f.gateway,['/internal/v1/channel/mattermost/proof-receipt']);
 assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_mattermost_owner_proofs').get().n,mode==='recover-accepted'?1:0);
 writeSync(1,JSON.stringify(summary())+'\n');
}finally{await f.close();await f.product.app.close();f.product.db.close();}
