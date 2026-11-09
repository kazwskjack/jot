import {randomUUID,createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {constants,openSync,readSync,fstatSync,closeSync,lstatSync,realpathSync,opendirSync,unlinkSync,rmdirSync} from 'node:fs';
import {join,dirname,resolve,isAbsolute} from 'node:path';
import {freezeWorkAdmission} from '../always-on/work-admission-records.ts';

export type GitReinitializationAllocation={protocol:1;scope:'private'|'common'|'git'|'internal';name:string;parent_identity:string;identity:string;mode:number;uid:string;gid:string;execution_authorized:false};
type Authority={authorize:(record?:GitReinitializationAllocation)=>void;prepared:(record:GitReinitializationAllocation)=>void;cleanup:(remove:()=>void)=>void};
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const identity=(value:{dev:bigint;ino:bigint})=>value.dev+':'+value.ino;
const samePath=(left:string,right:string)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
function directory(path:string){
 if(!isAbsolute(path)||!samePath(path,resolve(path)))throw Error('git_reinitialization_allocation_invalid');
 let parent=path;
 while(true){
  const stat=lstatSync(parent,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('git_repository_changed');
  const next=dirname(parent);if(next===parent)break;parent=next;
 }
 if(!samePath(realpathSync(path),path))throw Error('git_repository_changed');
 return lstatSync(path,{bigint:true});
}
function synchronous<T>(operation:()=>T):T{
 if(operation.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
 const result=operation();
 if(result&&typeof(result as {then?:unknown}).then==='function'){Promise.resolve(result).catch(()=>{});throw Error('git_execution_authority_missing');}
 return result;
}
export function reinitializationAllocation(value:unknown):GitReinitializationAllocation{
 try{
  const record=value as GitReinitializationAllocation;
  if(!record||typeof record!=='object'||Array.isArray(record)
   ||Object.keys(record).sort().join(',')!=='execution_authorized,gid,identity,mode,name,parent_identity,protocol,scope,uid'
   ||record.protocol!==1||record.execution_authorized!==false||!['private','common','git','internal'].includes(record.scope)
   ||typeof record.name!=='string'||!/^\.git\.jot-init-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/.test(record.name)
   ||typeof record.parent_identity!=='string'||!/^[0-9]+:[0-9]+$/.test(record.parent_identity)
   ||typeof record.identity!=='string'||!/^[0-9]+:[0-9]+$/.test(record.identity)||record.identity===record.parent_identity||record.identity.split(':')[0]!==record.parent_identity.split(':')[0]
   ||!Number.isSafeInteger(record.mode)||record.mode<0||record.mode>0o7777
   ||typeof record.uid!=='string'||!/^[0-9]+$/.test(record.uid)||typeof record.gid!=='string'||!/^[0-9]+$/.test(record.gid))throw Error();
  return structuredClone(record);
 }catch{throw Error('git_reinitialization_allocation_invalid');}
}
/** The owning original service supplies the parent and atomic cleanup authority.
 * Recovery must validate the recorded allocation in its original journal first. */
export function cleanupReinitializationAllocation(parent:string,input:unknown,atomic:(remove:()=>void)=>void){
 if(typeof atomic!=='function'||atomic.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
 const record=reinitializationAllocation(input),root=join(parent,record.name);
 const check=()=>{
  if(identity(directory(parent))!==record.parent_identity)throw Error('git_repository_changed');
  const stat=directory(root);
  if(identity(stat)!==record.identity||String(stat.uid)!==record.uid||String(stat.gid)!==record.gid||Number(stat.mode&0o7777n)!==record.mode)throw Error('git_repository_changed');
 };
 let active=true,called=false;
 const remove=()=>{
  if(!active||called)throw Error('git_execution_authority_missing');called=true;
  if(identity(directory(parent))!==record.parent_identity)throw Error('git_repository_changed');
  try{lstatSync(root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  check();
  const directories:Array<{path:string;identity:string;mode:bigint;uid:bigint;gid:bigint;entries:string[]}>=[],files:Array<{path:string;fact:string}>=[];
  let count=0,total=0;
  const file=(path:string)=>{
   const before=lstatSync(path,{bigint:true});
   if(!before.isFile()||before.isSymbolicLink()||String(before.dev)!==record.identity.split(':')[0]||String(before.uid)!==record.uid||before.nlink!==1n||before.size<0n||before.size>1024n*1024n)throw Error('git_reinitialization_cleanup_unknown');
   const stamp=(value:typeof before)=>[identity(value),value.mode,value.uid,value.gid,value.size,value.nlink,value.mtimeNs,value.ctimeNs].join(':');
   const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
   try{
    if(stamp(fstatSync(fd,{bigint:true}))!==stamp(before))throw Error('git_reinitialization_cleanup_unknown');
    const buffer=Buffer.alloc(Number(before.size)+1);let offset=0;
    while(offset<buffer.length){
     const count=readSync(fd,buffer,offset,buffer.length-offset,null);
     if(count===0)break;offset+=count;
    }
    if(BigInt(offset)!==before.size||stamp(fstatSync(fd,{bigint:true}))!==stamp(before)||stamp(lstatSync(path,{bigint:true}))!==stamp(before))throw Error('git_reinitialization_cleanup_unknown');
    return{fact:stamp(before)+':'+hash(buffer.subarray(0,offset)),size:offset};
   }finally{closeSync(fd);}
  };
  const entries=(path:string,limit=512)=>{
   const handle=opendirSync(path),names:string[]=[];
   try{
    for(;;){
     const item=handle.readSync();if(item===null)break;
     if(names.length>=limit)throw Error('git_reinitialization_cleanup_unknown');
     names.push(item.name);
    }
   }
   finally{handle.closeSync();}
   return names.sort();
  };
  const scan=(path:string)=>{
   check();const stat=directory(path);
   if(String(stat.dev)!==record.identity.split(':')[0]||String(stat.uid)!==record.uid)throw Error('git_reinitialization_cleanup_unknown');
   const names=entries(path,512-count);count+=names.length;directories.push({path,identity:identity(stat),mode:stat.mode,uid:stat.uid,gid:stat.gid,entries:names});
   for(const name of names){
    const full=join(path,name),stat=lstatSync(full,{bigint:true});
    if(stat.isSymbolicLink())throw Error('git_reinitialization_cleanup_unknown');
    if(stat.isDirectory())scan(full);
    else{
     const value=file(full);total+=value.size;
     if(total>8*1024*1024)throw Error('git_reinitialization_cleanup_unknown');
     files.push({path:full,fact:value.fact});
    }
   }
  };
  scan(root);
  const remaining=new Set(directories.map(item=>item.path));
  const parents=()=>{
   check();for(const item of directories)if(remaining.has(item.path)){
    const stat=directory(item.path);
    if(identity(stat)!==item.identity||stat.mode!==item.mode||stat.uid!==item.uid||stat.gid!==item.gid)throw Error('git_repository_changed');
   }
  };
  for(const item of directories){parents();if(JSON.stringify(entries(item.path))!==JSON.stringify(item.entries))throw Error('git_reinitialization_cleanup_unknown');}
  for(const item of files){parents();if(file(item.path).fact!==item.fact)throw Error('git_reinitialization_cleanup_unknown');}
  for(const item of files){parents();if(file(item.path).fact!==item.fact)throw Error('git_reinitialization_cleanup_unknown');unlinkSync(item.path);}
  for(const item of [...directories].reverse()){
   parents();rmdirSync(item.path);remaining.delete(item.path);
  }
 };
 try{synchronous(()=>atomic(remove));if(!called)throw Error('git_execution_authority_missing');}finally{active=false;}
}
/** Allocation is physically on its validated parent's volume. Native callers
 * record it before child/process work and retain their original lease/drain. */
export async function withReinitializationAllocation<T>(options:{parent:string;parent_identity:string;scope:GitReinitializationAllocation['scope'];authority:Authority;signal?:AbortSignal},operation:(path:string,assertCurrent:()=>void)=>Promise<T>):Promise<T>{
 const {parent,parent_identity,scope,authority,signal}=options;
 if(!['private','common','git','internal'].includes(scope)||typeof operation!=='function')throw Error('git_reinitialization_allocation_invalid');
 for(const name of ['authorize','prepared','cleanup'] as const)if(typeof authority?.[name]!=='function'||authority[name].constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
 const name='.git.jot-init-'+randomUUID()+'.pending',path=join(parent,name);
 let record:GitReinitializationAllocation|undefined,failure:unknown;
 const check=()=>{
  signal?.throwIfAborted();synchronous(()=>authority.authorize(record));
  if(identity(directory(parent))!==parent_identity)throw Error('git_repository_changed');
  if(record){
   const stat=directory(path);
   if(identity(stat)!==record.identity||String(stat.uid)!==record.uid||String(stat.gid)!==record.gid||Number(stat.mode&0o7777n)!==record.mode)throw Error('git_repository_changed');
  }
 };
 check();
 try{
  await mkdir(path,{mode:0o700});
  const stat=directory(path);
  record=freezeWorkAdmission(reinitializationAllocation({protocol:1,scope,name,parent_identity,identity:identity(stat),mode:Number(stat.mode&0o7777n),uid:String(stat.uid),gid:String(stat.gid),execution_authorized:false}));
  check();synchronous(()=>authority.prepared(record!));check();
  const result=await operation(path,check);check();return result;
 }catch(error){failure=error;throw error;}finally{
  if(record)try{cleanupReinitializationAllocation(parent,record,remove=>synchronous(()=>authority.cleanup(remove)));}
  catch(error){throw Error('git_reinitialization_cleanup_unknown',{cause:failure??error});}
 }
}
