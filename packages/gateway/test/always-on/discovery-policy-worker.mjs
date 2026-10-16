// Isolated synthetic race fixture; never a production model worker.
import {DatabaseSync} from 'node:sqlite';import {DiscoveryPolicies} from '../../src/always-on/discovery-policy.ts';
const [path,scope,key]=process.argv.slice(2),db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=75');const policies=new DiscoveryPolicies(db);
process.send({ready:true});process.once('message',()=>{try{const result=policies.save('owner',JSON.parse(scope),{expected_version:1,expected_role_version:1,expected_role_epoch:1,mode:'discover_only',cooldown_ms:1,recent_input_ms:1,max_cycles:null},key);process.send({ok:true,version:result.version});}catch(error){process.send({ok:false,reason:error.message});}finally{db.close();process.disconnect();}});
