import {GoalReceiptStore} from './goal-receipts.mjs';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// A strict IndexedDB commit precedes POST. localStorage read-back alone does
// not establish persistence when the whole browser process tree terminates.
export class DurableGoalReceiptStore extends GoalReceiptStore {
 static async open(factory,scope,conversation,legacyStorage){
  const store=new DurableGoalReceiptStore(undefined,scope,conversation);
  if(!factory)throw Error('goal_recovery_unavailable');
  store.db=await new Promise((resolve,reject)=>{let abandoned=false;const request=factory.open('jot-goal-receipts-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('commands');request.onsuccess=()=>{if(abandoned)request.result.close();else resolve(request.result);};request.onerror=request.onblocked=()=>{abandoned=true;reject(Error('goal_recovery_unavailable'));};});
  store.db.onversionchange=()=>store.close();
  try{
   if(legacyStorage){store.legacy=new GoalReceiptStore(legacyStorage,scope,conversation);for(const command of store.legacy.pending())await store.save(command,true);}
   await store.pending();return store;
  }catch(error){store.close();throw error;}
 }
 close(){this.db.close();}
 record(value,key){
  if(!value||Object.keys(value).sort().join(',')!=='command,legacy,status'||typeof value.legacy!=='boolean'||!['pending','acknowledged'].includes(value.status))throw Error('goal_recovery_invalid');
  this.validate(value.command);if(key!==this.prefix+value.command.key)throw Error('goal_recovery_invalid');return value;
 }
 transaction(mode,operation){
  return new Promise((resolve,reject)=>{
   let tx,result,failure;
   try{tx=this.db.transaction('commands',mode,mode==='readwrite'?{durability:'strict'}:{});if(mode==='readwrite'&&tx.durability!=='strict'){tx.abort();reject(Error('goal_recovery_unavailable'));return;}}
   catch{reject(Error('goal_recovery_unavailable'));return;}
   const fail=error=>{failure=error;try{tx.abort();}catch{};};
   tx.oncomplete=()=>resolve(result);tx.onerror=()=>{};tx.onabort=()=>reject(failure??Error('goal_recovery_unavailable'));
   try{operation(tx.objectStore('commands'),value=>result=value,fail);}catch(error){fail(error);}
  });
 }
 async pending(){
  return this.transaction('readonly',(records,done,fail)=>{
   const result=[],cursor=records.openCursor(IDBKeyRange.bound(this.prefix,this.prefix+'\uffff'));
   cursor.onsuccess=()=>{try{const row=cursor.result;if(!row){done(result);return;}const value=this.record(row.value,row.key);if(value.status==='pending')result.push(structuredClone(value.command));row.continue();}catch(error){fail(error);}};
  });
 }
 async save(command,migrating=false){
  this.validate(command);const key=this.prefix+command.key;
  return this.transaction('readwrite',(records,_done,fail)=>{const read=records.get(key);read.onsuccess=()=>{try{
   const prior=read.result&&this.record(read.result,key);
   if(prior&&!equal(prior.command,command))throw Error('goal_recovery_invalid');
   if(prior?.status==='acknowledged'){if(!migrating)throw Error('goal_recovery_invalid');return;}
   records.put({command,status:'pending',legacy:migrating||prior?.legacy===true},key);
  }catch(error){fail(error);}};});
 }
 async acknowledge(command){
  this.validate(command);const key=this.prefix+command.key;
  await this.transaction('readwrite',(records,_done,fail)=>{const read=records.get(key);read.onsuccess=()=>{try{const prior=this.record(read.result,key);if(!equal(prior.command,command))throw Error('goal_recovery_invalid');records.put({...prior,status:'acknowledged'},key);}catch(error){fail(error);}};});
  // Legacy markers may survive an old tab. Keep their durable tombstones until
  // local acknowledgement succeeds, so migration cannot resurrect a request.
  if(this.legacy){try{this.legacy.acknowledge(command);await this.transaction('readwrite',(records,_done,fail)=>{const read=records.get(key);read.onsuccess=()=>{try{const prior=this.record(read.result,key);records.put({...prior,legacy:false},key);}catch(error){fail(error);}};});}catch{}}
  await this.transaction('readwrite',(records,_done,fail)=>{const completed=[],cursor=records.openCursor(IDBKeyRange.bound(this.prefix,this.prefix+'\uffff'));cursor.onsuccess=()=>{try{const row=cursor.result;if(row){const value=this.record(row.value,row.key);if(value.status==='acknowledged'&&!value.legacy)completed.push(row.key);row.continue();}else for(const key of completed.slice(0,-20))records.delete(key);}catch(error){fail(error);}};}).catch(()=>{});
 }
}
