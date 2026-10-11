import {readFileSync,lstatSync} from 'node:fs';
import {createHostBackup,verifyHostBackup,restoreHostBackup} from './host-backup.ts';
const args=process.argv.slice(2),[action,first,second,third]=args;
function config(path:string){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new Error();const value=JSON.parse(readFileSync(path,'utf8'));if(!value||Object.keys(value).sort().join(',')!=='database,offline,roots'||typeof value.database!=='string'||value.offline!==true)throw new Error();return value;}
if(!['create','verify','restore'].includes(action??'')||args.length!==(action==='restore'?4:3)||!first||!second||args.some(arg=>arg.startsWith('--'))){console.error('usage: host-backup-main create PRIVATE_CONFIG NEW_PRIVATE_BUNDLE | verify PRIVATE_BUNDLE TRUSTED_SHA | restore PRIVATE_CONFIG PRIVATE_BUNDLE TRUSTED_SHA');process.exitCode=2;}
else{try{const receipt=action==='create'?await createHostBackup(config(first),second):action==='verify'?verifyHostBackup(first,second):restoreHostBackup(second,third!,config(first));console.log(JSON.stringify(receipt));}catch{console.error('host_backup_operation_failed');process.exitCode=1;}}
