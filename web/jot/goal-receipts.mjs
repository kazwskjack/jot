// Local recovery metadata only. Native Goal state and execution remain server-owned.
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
export class GoalReceiptStore {
 constructor(storage,scope,conversation){
  if(!/^[a-f0-9]{64}$/.test(scope)||typeof conversation!=='string'||!conversation||conversation.length>200)throw Error('goal_recovery_unavailable');
  this.storage=storage;this.scope=scope;this.conversation=conversation;this.prefix=`jot-goal-receipt/v1/${scope}/${encodeURIComponent(conversation)}/`;
 }
 validate(command){
  if(!exact(command,['body','key'])||typeof command.key!=='string'||!/^[-A-Za-z0-9]{1,128}$/.test(command.key)||!exact(command.body,['action','id','revision'])||!['pause','resume','stop'].includes(command.body.action)||typeof command.body.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(command.body.id)||!Number.isSafeInteger(command.body.revision)||command.body.revision<1)throw Error('goal_recovery_invalid');
 }
 read(key){
  const raw=this.storage.getItem(key);if(raw===null)return null;
  if(raw.length>2000)throw Error('goal_recovery_invalid');
  let record;try{record=JSON.parse(raw);}catch{throw Error('goal_recovery_invalid');}
  if(!exact(record,['command','status'])||!['pending','acknowledged'].includes(record.status))throw Error('goal_recovery_invalid');
  this.validate(record.command);if(key!==this.prefix+record.command.key)throw Error('goal_recovery_invalid');return record;
 }
 pending(){
  const keys=[];for(let i=0;i<this.storage.length;i++){const key=this.storage.key(i);if(key?.startsWith(this.prefix))keys.push(key);}
  return keys.sort().map(key=>this.read(key)).filter(record=>record?.status==='pending').map(record=>structuredClone(record.command));
 }
 save(command){
  this.validate(command);const key=this.prefix+command.key,prior=this.read(key);
  if(prior&&(JSON.stringify(prior.command)!==JSON.stringify(command)||prior.status!=='pending'))throw Error('goal_recovery_invalid');
  this.write(key,{command,status:'pending'});
 }
 acknowledge(command){
  this.validate(command);const key=this.prefix+command.key,prior=this.read(key);
  if(!prior||JSON.stringify(prior.command)!==JSON.stringify(command))throw Error('goal_recovery_invalid');
  // Tombstone first: failure to prune must never resurrect an uncertain operation.
  this.write(key,{command,status:'acknowledged'});
  const completed=[];for(let i=0;i<this.storage.length;i++){const k=this.storage.key(i);if(k?.startsWith(this.prefix)&&this.read(k)?.status==='acknowledged')completed.push(k);}
  for(const k of completed.sort().slice(0,-20)){try{this.storage.removeItem(k);}catch{/* Safe tombstones may remain. */}}
 }
 write(key,record){const raw=JSON.stringify(record);this.storage.setItem(key,raw);if(this.storage.getItem(key)!==raw)throw Error('goal_recovery_unavailable');}
}
