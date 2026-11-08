import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {setup} from './mattermost-text-test-support.mjs';
const [root,mode]=process.argv.slice(2),file=join(root,'synthetic-provider.json');assert.ok(['observed','accepted','recover-observed','recover-accepted'].includes(mode));let f;
const summary=()=>({pid:process.pid,requests:f.gateway,observations:f.product.db.prepare('SELECT * FROM ga_mattermost_text_observations').all(),events:f.product.db.prepare("SELECT * FROM ga_channel_message_events WHERE channel='mattermost'").all(),runs:f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,owner:f.product.db.prepare("SELECT owner_id FROM ga_owner_channel_bindings WHERE channel='mattermost'").get().owner_id});
f=await setup({after(){}},{root,...(existsSync(file)?{challenge:JSON.parse(readFileSync(file,'utf8'))}:{}),beforeIntake(){if(mode==='observed'&&f.post.id==='ordinary-post'){writeSync(1,JSON.stringify(summary())+'\n');process.exit(78);}},afterIntake(response){if(mode==='accepted'&&f.post.id==='ordinary-post'){assert.equal(response.statusCode,202,response.body);writeSync(1,JSON.stringify(summary())+'\n');process.exit(79);}}});
if(!existsSync(file))writeFileSync(file,JSON.stringify(f.challenge));
try{
 await f.start();
 if(!mode.startsWith('recover-')){await f.emit();f.gateway.length=0;f.post={...f.post,id:'ordinary-post',message:'Frozen ordinary text'};await f.emit();assert.fail('missing crash checkpoint');}
 assert.ok(f.gateway.includes('/internal/v1/channel/mattermost/event-receipt'));assert.ok(!f.gateway.includes('/internal/v1/channel/messages'));assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,mode==='recover-accepted'?1:0);writeSync(1,JSON.stringify(summary())+'\n');
}finally{await f.close();await f.product.app.close();f.product.db.close();}
