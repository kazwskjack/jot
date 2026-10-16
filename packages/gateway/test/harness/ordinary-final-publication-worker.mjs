// Isolated local publication race fixture, not an Agent or model provider.
import {createHash} from 'node:crypto';
import {openProductDatabase} from '../../src/db/database.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {OrdinaryFinalPublisher} from '../../src/harness/ordinary-final-publication.ts';
import {ordinaryHistorySourceSha256} from '../../src/harness/ordinary-steering-observation.ts';
import {ChannelDeliveryService} from '../../src/channels/delivery.ts';
import {HistoricalFinalDeliveryIntents} from '../../src/channels/historical-final-intents.ts';
import {OrdinaryFinalRecoveryPump} from '../../src/harness/ordinary-final-recovery.ts';
const [path,runId,channels]=process.argv.slice(2);if(!path||!runId||typeof process.send!=='function')throw Error('publication_race_fixture_invalid');
const db=openProductDatabase(path);let calls=0;
const client={observeRunCompletion:async(session,scope,source)=>{
 calls++;if(calls===1){process.send({type:'ready'});await new Promise(resolve=>process.once('message',message=>{if(message?.type!=='go')throw Error('publication_race_fixture_invalid');resolve();}));}
 const commands=source.commands.filter(c=>['pending','applied'].includes(c.command_status)).map(c=>c.command_id);
 return{protocol:1,kind:'ordinary_run_completion',run_id:runId,session_id:session,run_version:scope.expected_run_version,source_sha256:ordinaryHistorySourceSha256(source),raw_sha256:'a'.repeat(64),raw_event_count:12,profile_fingerprint:'b'.repeat(64),command_ids:commands,native_message_ids:['native-root',...commands.map((_,i)=>'native-'+i)],answer_sha256:createHash('sha256').update('Final synthetic answer').digest('hex'),answer_seq:9,turn_end_seq:11,answer_event:{seq:9,type:'assistant/message',data:{turn:2,step:1,message:{content:[{type:'text',text:'Final synthetic answer'}]}}},output_events:[],execution_authorized:false};
}};
try{
 if(channels==='startup-failure')throw Error('synthetic_publication_startup_failure');
 const queue=channels==='channels'||channels==='pump'?new ChannelDeliveryService(db):undefined;
 const publisher=new OrdinaryFinalPublisher(db,new EventStore(db),client,queue?{historicalChannels:queue}:{});
 const result=channels==='pump'?await new OrdinaryFinalRecoveryPump(db,publisher,new HistoricalFinalDeliveryIntents(db,queue),{enabled:true,workerId:'fixture-observer-'+process.pid}).processNext():await publisher.reconcile(runId,'s');
 db.close();await new Promise((resolve,reject)=>process.send({type:'done',result,calls},error=>error?reject(error):resolve()));process.disconnect();
}catch(error){db.close();throw error;}
