import {DatabaseSync} from 'node:sqlite';
import {buildNotificationRetentionPlan} from './notification-retention.ts';
// Read-only inventory. No migrations and no remote/provider connections.
const args=process.argv.slice(2);
if(!args[0]||args.length>4||args.some(value=>value.startsWith('--'))){
 console.error('usage: notification-retention-report DATABASE [NOW_ISO] [AFTER_DELIVERY_ID] [LIMIT]');process.exitCode=2;
}else{
 let db:DatabaseSync|undefined;
 try{db=new DatabaseSync(args[0],{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=75;');
  console.log(JSON.stringify(buildNotificationRetentionPlan(db,{...(args[1]?{now:args[1]}:{}),...(args[2]?{afterDeliveryId:args[2]}:{}),...(args[3]?{limit:Number(args[3])}:{})})));
 }catch{console.error('notification_retention_inventory_failed');process.exitCode=1;}finally{db?.close();}
}
