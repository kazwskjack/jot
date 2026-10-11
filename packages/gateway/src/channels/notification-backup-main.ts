import {createNotificationBackup,verifyNotificationBackup,restoreNotificationBackup} from './notification-backup.ts';
const args=process.argv.slice(2),[action,input,value,destination]=args;
if(!['create','verify','restore'].includes(action??'')||!input||!value||args.length!==(action==='restore'?4:3)||args.some(arg=>arg.startsWith('--'))){
 console.error('usage: notification-backup-main create DATABASE NEW_PRIVATE_BUNDLE | verify PRIVATE_BUNDLE TRUSTED_SHA | restore PRIVATE_BUNDLE TRUSTED_SHA NEW_PRIVATE_DIRECTORY');process.exitCode=2;
}else{
 try{const receipt=action==='create'?await createNotificationBackup(input,value):action==='restore'?restoreNotificationBackup(input,value,destination!):verifyNotificationBackup(input,value);console.log(JSON.stringify(receipt));}catch{console.error('notification_backup_operation_failed');process.exitCode=1;}
}
