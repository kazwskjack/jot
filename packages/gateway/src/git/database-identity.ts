import {createHash} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';

/** A live local file witness, not an approval or serializable DB connection. */
export function retainOriginalGitDatabase(db:DatabaseSync){
 const fail=():never=>{throw Error('native_git_database_changed');};
 const observe=()=>{
  try{
   const rows=db.prepare('PRAGMA database_list').all() as {name:string;file:string}[];
   if(rows.some(row=>!['main','temp'].includes(row.name)))return fail();
   const path=rows.find(row=>row.name==='main')?.file;
   if(typeof path!=='string'||!isAbsolute(path))return fail();
   const canonical=realpathSync(path),plain=resolve(path),stat=lstatSync(path,{bigint:true});
   if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.ino===0n
    ||(process.platform==='win32'?plain.toLowerCase()!==canonical.toLowerCase():plain!==canonical))return fail();
   const mode=db.prepare('PRAGMA journal_mode').get() as {journal_mode?:string}|undefined;
   if(mode?.journal_mode!=='wal')return fail();
   return createHash('sha256').update(JSON.stringify([canonical,stat.dev.toString(),stat.ino.toString()])).digest('hex');
  }catch{return fail();}
 };
 const sha256=observe();
 return Object.freeze({sha256,assertCurrent(){if(observe()!==sha256)fail();}});
}
