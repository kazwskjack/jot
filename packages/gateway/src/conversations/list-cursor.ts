import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
type Boundary={rank:number;pin:string;updated:string;id:string};
/** Integrity-bound live list boundary, not a conversation/session credential.
 * The key stays in the private product DB so cursors survive process restarts. */
export class ConversationListCursor{
 private readonly key:Buffer;
 constructor(db:DatabaseSync){
  // Reopening a repository is a read. Even INSERT OR IGNORE needs a write
  // lock, so only a genuinely missing key enters the initialization transaction.
  const read=()=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_conversation_cursor_key'").get()
   ?db.prepare('SELECT key_hex FROM ga_conversation_cursor_key WHERE id=1').get() as {key_hex:string}|undefined:undefined;
  let row=read();
  if(!row)row=withImmediateTransaction(db,()=>{
   db.exec(`CREATE TABLE IF NOT EXISTS ga_conversation_cursor_key(id INTEGER PRIMARY KEY CHECK(id=1),key_hex TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS ga_conversation_cursor_key_no_update BEFORE UPDATE ON ga_conversation_cursor_key BEGIN SELECT RAISE(ABORT,'conversation_cursor_key_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS ga_conversation_cursor_key_no_delete BEFORE DELETE ON ga_conversation_cursor_key BEGIN SELECT RAISE(ABORT,'conversation_cursor_key_immutable'); END;`);
   // Recheck under the original writer lock: competing first constructors must
   // share the committed key rather than returning their own random candidate.
   if(!read())db.prepare('INSERT OR IGNORE INTO ga_conversation_cursor_key VALUES(1,?)').run(randomBytes(32).toString('hex'));
   return read();
  });
  if(!row||!/^[a-f0-9]{64}$/.test(row.key_hex))throw new Error('conversation_cursor_key_invalid');this.key=Buffer.from(row.key_hex,'hex');
 }
 private scope(owner:string,project:string|undefined,state:string){return createHash('sha256').update(JSON.stringify([owner,project??null,state])).digest('hex');}
 encode(owner:string,project:string|undefined,state:string,boundary:Boundary){const body=Buffer.from(JSON.stringify({v:1,scope:this.scope(owner,project,state),exp:Date.now()+86400000,...boundary})).toString('base64url');return body+'.'+createHmac('sha256',this.key).update(body).digest('base64url');}
 decode(owner:string,project:string|undefined,state:string,cursor:string):Boundary{
  try{
   if(typeof cursor!=='string'||cursor.length>2048||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor))throw new Error();const [body,signature]=cursor.split('.') as [string,string],actual=Buffer.from(signature,'base64url'),expected=createHmac('sha256',this.key).update(body).digest();if(actual.toString('base64url')!==signature||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error();
   const decoded=Buffer.from(body,'base64url');if(decoded.toString('base64url')!==body)throw new Error();const value=JSON.parse(decoded.toString('utf8'));if(!value||Object.keys(value).sort().join(',')!=='exp,id,pin,rank,scope,updated,v'||value.v!==1||value.scope!==this.scope(owner,project,state)||!Number.isSafeInteger(value.exp)||value.exp<=Date.now()||value.exp>Date.now()+86400000||![0,1].includes(value.rank)||typeof value.pin!=='string'||value.pin.length>128||(value.rank===1)!==(value.pin==='')||typeof value.updated!=='string'||!value.updated||value.updated.length>128||typeof value.id!=='string'||!value.id||value.id.length>200)throw new Error();return {rank:value.rank,pin:value.pin,updated:value.updated,id:value.id};
  }catch{throw new Error('invalid_conversation_cursor');}
 }
}
