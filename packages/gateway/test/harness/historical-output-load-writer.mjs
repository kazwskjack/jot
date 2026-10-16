// Synthetic competing SQLite writer; never opens an application/user database.
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
const [path]=process.argv.slice(2);
if(!path||typeof process.send!=='function')throw Error('output_load_fixture_invalid');
const db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=75');
const insert=db.prepare('INSERT INTO synthetic_output_load_writes(at_ms) VALUES(?)');
const samples=[];let running=false,finished=false,timer;
const now=()=>performance.timeOrigin+performance.now();
function finish(){
 if(finished)return;finished=true;running=false;clearTimeout(timer);clearTimeout(deadline);db.close();
 process.send({type:'done',samples},error=>{if(error)process.exitCode=1;process.disconnect();});
}
function step(){
 if(!running||finished)return;
 const start=now();let busy=false;
 try{insert.run(start);}catch(error){if(error.errcode!==5&&!/database is locked/.test(error.message))throw error;busy=true;}
 samples.push({start,end:now(),busy});
 if(samples.length>=10000)return finish();
 timer=setTimeout(step,1);
}
process.on('message',message=>{
 if(message?.type==='start'&&!running&&!finished){running=true;process.send({type:'sampling'});step();}
 else if(message?.type==='stop')finish();
});
const deadline=setTimeout(()=>{process.exitCode=1;finish();},20000);
insert.run(now());process.send({type:'ready'});
