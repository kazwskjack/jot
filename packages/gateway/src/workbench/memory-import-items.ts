import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';

type Item=Record<string,unknown>;
export type ImportItemsManifest={kind:'original-memory-import-items-v1';count:number;sha256:string};
export type ImportItemsBatch={owner:string;workspace:string;importId:string;version:number};
type Phase='preview'|'receipt';
type Range={offset:number;limit:number};
const conflict=():never=>{throw Error('memory_import_digest_conflict');};

function validateManifest(manifest:ImportItemsManifest){
 if(!manifest||manifest.kind!=='original-memory-import-items-v1'||!Number.isSafeInteger(manifest.count)||manifest.count<0
  ||typeof manifest.sha256!=='string'||!/^[a-f0-9]{64}$/.test(manifest.sha256))conflict();
}

export function importItemsManifest(items:Iterable<Item>):ImportItemsManifest{
 const hash=createHash('sha256').update('[');let count=0;
 for(const item of items){hash.update((count?',':'')+JSON.stringify(item),'utf8');count++;}
 return {kind:'original-memory-import-items-v1',count,sha256:hash.update(']').digest('hex')};
}

export function importReplacementDigest(target:unknown,items:Iterable<Item>){
 const hash=createHash('sha256').update('{"target":'+JSON.stringify(target)+',"items":[');let count=0;
 for(const item of items){hash.update((count?',':'')+JSON.stringify(item),'utf8');count++;}
 return hash.update(']}').digest('hex');
}

/** Immutable item storage subordinate to the original owner-scoped import batch and preview version. */
export class MemoryImportItems{
 private readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;withImmediateTransaction(db,()=>{
  for(const table of ['wb_memory_import_items','wb_memory_import_replacement_items']){
   const trigger=table==='wb_memory_import_items'?'wb_memory_import_item':'wb_memory_import_replacement_item';
   db.exec(`
  CREATE TABLE IF NOT EXISTS ${table} (
   owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,import_id TEXT NOT NULL,preview_version INTEGER NOT NULL CHECK(preview_version>=1),
   phase TEXT NOT NULL CHECK(phase IN ('preview','receipt')),position INTEGER NOT NULL CHECK(position>=0),item_json TEXT NOT NULL CHECK(json_valid(item_json)),
   PRIMARY KEY(owner_id,workspace_id,import_id,preview_version,phase,position),
   FOREIGN KEY(owner_id,workspace_id,import_id) REFERENCES wb_memory_import_batches(owner_id,workspace_id,import_id) ON DELETE RESTRICT);
  CREATE TRIGGER IF NOT EXISTS ${trigger}_insert BEFORE INSERT ON ${table}
   WHEN NOT EXISTS(SELECT 1 FROM wb_memory_import_batches b WHERE b.owner_id=NEW.owner_id AND b.workspace_id=NEW.workspace_id
    AND b.import_id=NEW.import_id AND b.version=NEW.preview_version AND b.status='previewed')
   BEGIN SELECT RAISE(ABORT,'memory_import_item_batch_closed'); END;
  CREATE TRIGGER IF NOT EXISTS ${trigger}_update BEFORE UPDATE ON ${table}
   BEGIN SELECT RAISE(ABORT,'memory_import_item_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS ${trigger}_delete BEFORE DELETE ON ${table}
   BEGIN SELECT RAISE(ABORT,'memory_import_item_immutable'); END;`);
  }
 });}

 write(batch:ImportItemsBatch,phase:Phase,items:Iterable<Item>,manifest?:ImportItemsManifest,replacement=false){
  if(!this.db.isTransaction)throw Error('memory_import_item_transaction_required');
  const table=replacement?'wb_memory_import_replacement_items':'wb_memory_import_items';
  const insert=this.db.prepare(`INSERT INTO ${table}(owner_id,workspace_id,import_id,preview_version,phase,position,item_json) VALUES(?,?,?,?,?,?,?)`);
  const hash=createHash('sha256').update('[');let count=0;
  for(const item of items){
   const encoded=JSON.stringify(item);hash.update((count?',':'')+encoded,'utf8');
   insert.run(batch.owner,batch.workspace,batch.importId,batch.version,phase,count,encoded);count++;
  }
  const result:ImportItemsManifest={kind:'original-memory-import-items-v1',count,sha256:hash.update(']').digest('hex')};
  if(manifest&&(manifest.count!==count||manifest.sha256!==result.sha256))conflict();
  return result;
 }

 private rows(batch:ImportItemsBatch,phase:Phase,replacement:boolean){
  const table=replacement?'wb_memory_import_replacement_items':'wb_memory_import_items';
  return this.db.prepare(`SELECT position,item_json FROM ${table}
   WHERE owner_id=? AND workspace_id=? AND import_id=? AND preview_version=? AND phase=? ORDER BY position`)
   .iterate(batch.owner,batch.workspace,batch.importId,batch.version,phase) as Iterable<{position:number;item_json:string}>;
 }

 *iterate<T extends Item=Item>(batch:ImportItemsBatch,phase:Phase,manifest:ImportItemsManifest,replacement=false):Generator<T>{
  validateManifest(manifest);
  const hash=createHash('sha256').update('[');let count=0;
  for(const row of this.rows(batch,phase,replacement)){
   if(row.position!==count)conflict();hash.update((count?',':'')+row.item_json,'utf8');count++;
   const item=JSON.parse(row.item_json) as unknown;
   if(!item||typeof item!=='object'||Array.isArray(item))conflict();yield item as T;
  }
  if(count!==manifest.count||hash.update(']').digest('hex')!==manifest.sha256)conflict();
 }

 read(batch:ImportItemsBatch,phase:Phase,manifest:ImportItemsManifest,range?:Range,replacement=false,scope?:{target:unknown;sha256:string}){
  validateManifest(manifest);
  if(range&&(!Number.isSafeInteger(range.offset)||range.offset<0||!Number.isSafeInteger(range.limit)||range.limit<0))conflict();
  const hash=createHash('sha256').update('['),scopeHash=scope?createHash('sha256').update('{"target":'+JSON.stringify(scope.target)+',"items":['):undefined;
  const items:Item[]=[];let count=0;
  for(const row of this.rows(batch,phase,replacement)){
   if(row.position!==count)conflict();const part=(count?',':'')+row.item_json;hash.update(part,'utf8');scopeHash?.update(part,'utf8');
   if(range&&count>=range.offset&&count-range.offset<range.limit){
    const item=JSON.parse(row.item_json) as unknown;
    if(!item||typeof item!=='object'||Array.isArray(item))conflict();items.push(item as Item);
   }
   count++;
  }
  if(count!==manifest.count||hash.update(']').digest('hex')!==manifest.sha256)conflict();
  if(scopeHash&&scopeHash.update(']}').digest('hex')!==scope?.sha256)conflict();
  return items;
 }
}
