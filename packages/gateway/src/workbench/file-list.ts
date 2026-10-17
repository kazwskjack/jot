import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

export interface FileListOptions {limit?:number;cursor?:string}
type FileRow={path:string;version:number;sha256:string;size:number;updated_at:string};
type Boundary={scope:string;digest:string;after:string;expires:number};
const invalid=():never=>{throw Error('invalid_file_list_cursor');};
const domain='workbench-file-list-v1\0';
/** Restart-stable integrity only. A cursor is never file or execution authority. */
function signature(db:DatabaseSync,body:string){
 // WorkbenchService's original ConversationRepository initializes this durable
 // private key. Listing never initializes a schema or obtains a writer lock.
 const row=db.prepare('SELECT key_hex FROM ga_conversation_cursor_key WHERE id=1').get() as {key_hex:string}|undefined;
 if(!row||!/^[a-f0-9]{64}$/.test(row.key_hex))throw Error('conversation_cursor_key_invalid');
 return createHmac('sha256',Buffer.from(row.key_hex,'hex')).update(domain).update(body).digest();
}
function decode(db:DatabaseSync,cursor:string,scope:string):Boundary{
 try{
  if(typeof cursor!=='string'||cursor.length>2048||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor))return invalid();
  const [body,mac]=cursor.split('.') as [string,string],actual=Buffer.from(mac,'base64url'),expected=signature(db,body);
  if(actual.toString('base64url')!==mac||actual.length!==expected.length||!timingSafeEqual(actual,expected))return invalid();
  const bytes=Buffer.from(body,'base64url');if(bytes.toString('base64url')!==body)return invalid();
  const value=JSON.parse(bytes.toString('utf8')) as Boundary;
  if(!value||Object.keys(value).sort().join(',')!=='after,digest,expires,scope'||value.scope!==scope||!Number.isSafeInteger(value.expires)||value.expires<=Date.now()||typeof value.after!=='string'||!value.after||value.after.length>400||!/^[a-f0-9]{64}$/.test(value.digest))return invalid();
  return value;
 }catch{return invalid();}
}
/** Each page observes one read transaction, not a retained filesystem snapshot.
 * Any metadata change invalidates continuation. O(N) streamed metadata per page
 * deliberately avoids a new revision authority or unbounded response bodies. */
export function listProjectFiles(db:DatabaseSync,owner:string,workspace:string,project:string,options:FileListOptions={}){
 if(!options||typeof options!=='object'||Object.keys(options).some(key=>!['limit','cursor'].includes(key)))throw Error('invalid_file_list_query');
 const limit=options.limit??200;if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('invalid_file_list_query');
 const ownTransaction=!db.isTransaction;if(ownTransaction)db.exec('BEGIN');
 try{
  const scope=createHash('sha256').update(JSON.stringify([owner,workspace,project])).digest('hex');
  const boundary=options.cursor===undefined?null:decode(db,options.cursor,scope);
  const digest=createHash('sha256'),items:FileRow[]=[];let more=false;
  const rows=db.prepare(`SELECT path,version,sha256,size,updated_at,path COLLATE BINARY > ? AS after_boundary
   FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? ORDER BY path COLLATE BINARY`).iterate(boundary?.after??'',owner,workspace,project);
  for(const raw of rows){
   const row=raw as unknown as FileRow&{after_boundary:number};
   digest.update(JSON.stringify([row.path,row.version,row.sha256,row.size,row.updated_at])+'\n');
   if(row.after_boundary){if(items.length<limit)items.push({path:row.path,version:Number(row.version),sha256:row.sha256,size:Number(row.size),updated_at:row.updated_at});else more=true;}
  }
  const current=digest.digest('hex');if(boundary&&boundary.digest!==current)throw Error('file_list_state_conflict');
  let next_cursor:string|null=null;
  if(more){const body=Buffer.from(JSON.stringify({scope,digest:current,after:items.at(-1)!.path,expires:boundary?.expires??Date.now()+86400000})).toString('base64url');next_cursor=body+'.'+signature(db,body).toString('base64url');}
  if(ownTransaction)db.exec('COMMIT');return {items,next_cursor};
 }catch(error){if(ownTransaction)db.exec('ROLLBACK');throw error;}
}
