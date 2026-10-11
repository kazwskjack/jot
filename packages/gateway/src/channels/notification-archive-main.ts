import {DatabaseSync} from 'node:sqlite';
import {lstatSync} from 'node:fs';
import {NotificationArchiveService} from './notification-archive.ts';
const [operation,database,root,effect,now,...extra]=process.argv.slice(2);
if(!['archive','restore','archive-digest','restore-digest'].includes(operation??'')||!database||!root||!effect||extra.length||(operation?.startsWith('restore')&&now!==undefined)||process.argv.slice(2).some(value=>value.startsWith('--'))){
 console.error('usage: notification-archive-main archive|archive-digest DATABASE PRIVATE_ARCHIVE_ROOT ID [NOW_ISO] | restore|restore-digest DATABASE PRIVATE_ARCHIVE_ROOT ID');process.exitCode=2;
}else{
 let db:DatabaseSync|undefined;
 try{const source=lstatSync(database);if(!source.isFile()||source.isSymbolicLink())throw new Error('notification_archive_database_denied');db=new DatabaseSync(database);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');const archive=new NotificationArchiveService(db,root),options=now?{now}:{};const result=operation==='archive'?archive.archive(effect,options):operation==='archive-digest'?archive.archiveDigest(effect,options):operation==='restore-digest'?archive.restoreDigest(effect):archive.restore(effect);console.log(JSON.stringify(result));
 }catch{console.error('notification_archive_operation_failed');process.exitCode=1;}finally{db?.close();}
}
