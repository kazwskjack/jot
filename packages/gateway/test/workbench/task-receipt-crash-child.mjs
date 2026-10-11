// Isolated fault injection only. This fixture never contacts a provider or host.
import {readFileSync} from 'node:fs';
import {buildServer} from '../../src/server.ts';
import {TaskWaitResponder} from '../../src/persistent-tasks/task-wait.ts';
const scenario=JSON.parse(readFileSync(process.argv[2],'utf8'));
const server=await buildServer(scenario.config);
const crash=stage=>{process.stdout.write(`FIXTURE_CRASH:${stage}\n`);process.exit(73);};
if(scenario.stage==='in_transaction'){
 const original=TaskWaitResponder.prototype.recordReceipt;
 TaskWaitResponder.prototype.recordReceipt=function(...args){
  original.apply(this,args);
  if(!server.db.isTransaction)throw new Error('fixture_boundary_wrong');
  crash('in_transaction');
 };
}
// Explicit compatibility fault fixture, not a claim to run an old binary:
// pre-upgrade committed answers do not have the new immutable result row.
if(scenario.stage==='legacy_after_domain')TaskWaitResponder.prototype.recordReceipt=function(){};
if(scenario.stage==='before_handler')server.app.addHook('preHandler',async request=>{if(request.method==='POST'&&request.url===scenario.request.url)crash('before_handler');});
if(['after_domain','legacy_after_domain'].includes(scenario.stage))server.app.addHook('preSerialization',async(request,reply,payload)=>{
 if(request.method==='POST'&&request.url===scenario.request.url&&reply.statusCode===202){
  const row=server.db.prepare('SELECT response_status FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?').get('alice',`POST ${request.url}`,scenario.request.headers['idempotency-key']);
  if(row?.response_status!==null)throw new Error('fixture_boundary_wrong');
  crash(scenario.stage);
 }
 return payload;
});
await server.app.inject(scenario.request);
throw new Error('fixture_did_not_crash');
