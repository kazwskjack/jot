import {DatabaseSync} from 'node:sqlite';
import {readHostResourceObservations} from './host-resource-observations.ts';
const args=process.argv.slice(2),[database,owner,run]=args;
if(args.length!==3||!database||!owner||!run||args.some(arg=>arg.startsWith('--'))){console.error('usage: resource-report-main PRIVATE_DATABASE OWNER RUN_ID');process.exitCode=2;}
else{let db:DatabaseSync|undefined;try{db=new DatabaseSync(database,{readOnly:true});console.log(JSON.stringify(readHostResourceObservations(db,owner,run)));}catch{console.error('host_resource_report_unavailable');process.exitCode=1;}finally{db?.close();}}
