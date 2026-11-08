import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {setup} from './mattermost-file-test-support.mjs';
const [root,mode]=process.argv.slice(2),file=join(root,'synthetic-provider.json');let f;
assert.ok(['observed','staged','accepted','recover-observed','recover-staged','recover-accepted'].includes(mode));
const summary=()=>({pid:process.pid,observations:f.product.db.prepare('SELECT * FROM ga_mattermost_attachment_observations').all(),events:f.product.db.prepare("SELECT * FROM ga_channel_message_events WHERE channel='mattermost'").all(),runs:f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n});
const crash=code=>{writeSync(1,JSON.stringify(summary())+'\n');process.exit(code);};
f=await setup({after(){}},{root,...(existsSync(file)?{challenge:JSON.parse(readFileSync(file,'utf8'))}:{}),beforeRequest(url){if(mode==='observed'&&url==='/internal/v2/channel/attachment-batches/lookup')crash(78);},afterRequest(url,response){if(mode==='staged'&&url==='/internal/v2/channel/attachment-batches'){assert.equal(response.statusCode,201,response.body);crash(79);}if(mode==='accepted'&&url.endsWith('/admit')){assert.equal(response.statusCode,202,response.body);crash(80);}}});
if(!existsSync(file))writeFileSync(file,JSON.stringify(f.challenge));
try{
 await f.start();
 if(!mode.startsWith('recover-')){await f.emit();f.post={...f.post,id:'file-post',message:'Frozen original file',file_ids:['provider-file']};await f.emit();assert.fail('missing crash checkpoint');}
 assert.ok(f.gateway.includes('/internal/v2/channel/attachment-batches/lookup'));
 assert.ok(f.gateway.every(path=>path.endsWith('/lookup')||path.endsWith('/proof-receipt')));
 assert.ok(f.http.every(path=>path.endsWith('/users/me')),'startup must not reconstruct provider files or posts');
 assert.equal(summary().runs,mode==='recover-accepted'?1:0);writeSync(1,JSON.stringify(summary())+'\n');
}finally{await f.close();await f.product.app.close();f.product.db.close();}
