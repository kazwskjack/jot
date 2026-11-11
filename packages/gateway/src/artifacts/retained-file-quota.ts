import {lstatSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

const maxBytes=512*1024*1024,maxEntries=128;
const nativeStage=/^\.native-stage-([1-9][0-9]{0,8})-[a-f0-9]{64}-[A-Za-z0-9_-]{6}$/;
export function nativeStageReservation(name:string):number|undefined{const match=nativeStage.exec(name);return match&&match[0].length===name.length&&Number(match[1])<=maxBytes?Number(match[1]):undefined;}
/** The original database publication transaction serializes persisted entries and native staging reservations. */
export function assertRetainedFileCapacity(root:string,additionalBytes:number,fullError:string,ignoredStage?:string){
 if(!Number.isSafeInteger(additionalBytes)||additionalBytes<0||ignoredStage!==undefined&&nativeStageReservation(ignoredStage)===undefined)throw Error('retained_file_storage_invalid');
 const directory=lstatSync(root);if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('retained_file_storage_invalid');
 let used=0,count=0;
 for(const [name,pattern,files] of [
  ['retained-office-pdfs',/^[a-f0-9]{64}-[a-f0-9]{64}$/,['source.json','preview.pdf']],
  ['retained-native-files',/^[a-f0-9]{64}$/,['source.json','source.bin']],
 ] as const){
  const folder=join(root,name);let entries:string[];
  try{const stat=lstatSync(folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('retained_file_storage_invalid');entries=readdirSync(folder);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  for(const entry of entries){
   const path=join(folder,entry),directory=lstatSync(path);
   if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('retained_file_storage_invalid');
   const reserved=name==='retained-native-files'?nativeStageReservation(entry):undefined;
   if(reserved!==undefined){
    // Abandoned reservations remain accounted after a process crash; never remove another writer's stage.
    if(entry===ignoredStage)continue;
    count++;used+=reserved;
   }else{
    if(!pattern.test(entry)||entry.length!==(name==='retained-office-pdfs'?129:64))throw Error('retained_file_storage_invalid');
    count++;
    if(readdirSync(path).sort().join(',')!==[...files].sort().join(','))throw Error('retained_file_storage_invalid');
    for(const file of files){const stat=lstatSync(join(path,file));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!Number.isSafeInteger(stat.size))throw Error('retained_file_storage_invalid');used+=stat.size;}
   }
   if(count>=maxEntries||used+additionalBytes>maxBytes)throw Error(fullError);
  }
 }
 if(used+additionalBytes>maxBytes)throw Error(fullError);
}
