import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';

type Item=Record<string,unknown>;
export type ImportItemsManifest={kind:'original-memory-import-items-v1';count:number;sha256:string};
export type ImportItemsBatch={owner:string;workspace:string;importId:string;version:number};
type Phase='preview'|'receipt';
type Range={offset:number;limit:number};
const conflict=():never=>{throw Error('memory_import_digest_conflict');};

export function importItemsManifest(items:Item[]):ImportItemsManifest{
 const hash=createHash('sha256').update('[');
 for(let index=0;index<items.length;index++)hash.update((index?',':'')+JSON.stringify(items[index]),'utf8');
 return {kind:'original-memory-import-items-v1',count:items.length,sha256:hash.update(']').digest('hex')};
}

/** Immutable item storage subordinate to the original owner-scoped import batch and preview version. */
export class MemoryImportItems{
 private readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;withImmediateTransaction(db,()=>db.exec(`
  CREATE TABLE IF NOT EXISTS wb_memory_import_items (
   owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,import_id TEXT NOT NULL,preview_version INTEGER NOT NULL CHECK(preview_version>=1),
   phase TEXT NOT NULL CHECK(phase IN ('preview','receipt')),position INTEGER NOT NULL CHECK(position>=0),item_json TEXT NOT NULL CHECK(json_valid(item_json)),
   PRIMARY KEY(owner_id,workspace_id,import_id,preview_version,phase,position),
   FOREIGN KEY(owner_id,workspace_id,import_id) REFERENCES wb_memory_import_batches(owner_id,workspace_id,import_id) ON DELETE RESTRICT);
  CREATE TRIGGER IF NOT EXISTS wb_memory_import_item_insert BEFORE INSERT ON wb_memory_import_items
   WHEN NOT EXISTS(SELECT 1 FROM wb_memory_import_batches b WHERE b.owner_id=NEW.owner_id AND b.workspace_id=NEW.workspace_id
    AND b.import_id=NEW.import_id AND b.version=NEW.preview_version AND b.status='previewed')
   BEGIN SELECT RAISE(ABORT,'memory_import_item_batch_closed'); END;
  CREATE TRIGGER IF NOT EXISTS wb_memory_import_item_update BEFORE UPDATE ON wb_memory_import_items
   BEGIN SELECT RAISE(ABORT,'memory_import_item_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_memory_import_item_delete BEFORE DELETE ON wb_memory_import_items
   BEGIN SELECT RAISE(ABORT,'memory_import_item_immutable'); END;`));}

 write(batch:ImportItemsBatch,phase:Phase,items:Item[],manifest:ImportItemsManifest){
  if(!this.db.isTransaction)throw Error('memory_import_item_transaction_required');
  const insert=this.db.prepare(`INSERT INTO wb_memory_import_items(owner_id,workspace_id,import_id,preview_version,phase,position,item_json) VALUES(?,?,?,?,?,?,?)`);
  const hash=createHash('sha256').update('[');
  for(let index=0;index<items.length;index++){
   const encoded=JSON.stringify(items[index]);hash.update((index?',':'')+encoded,'utf8');
   insert.run(batch.owner,batch.workspace,batch.importId,batch.version,phase,index,encoded);
  }
  if(manifest.count!==items.length||hash.update(']').digest('hex')!==manifest.sha256)conflict();
 }

 read(batch:ImportItemsBatch,phase:Phase,manifest:ImportItemsManifest,range?:Range){
  if(!manifest||manifest.kind!=='original-memory-import-items-v1'||!Number.isSafeInteger(manifest.count)||manifest.count<0
   ||typeof manifest.sha256!=='string'||!/^[a-f0-9]{64}$/.test(manifest.sha256))conflict();
  if(range&&(!Number.isSafeInteger(range.offset)||range.offset<0||!Number.isSafeInteger(range.limit)||range.limit<0))conflict();
  const rows=this.db.prepare(`SELECT position,item_json FROM wb_memory_import_items
   WHERE owner_id=? AND workspace_id=? AND import_id=? AND preview_version=? AND phase=? ORDER BY position`)
   .iterate(batch.owner,batch.workspace,batch.importId,batch.version,phase) as Iterable<{position:number;item_json:string}>;
  const hash=createHash('sha256').update('['),items:Item[]=[];let count=0;
  for(const row of rows){
   if(row.position!==count)conflict();hash.update((count?',':'')+row.item_json,'utf8');
   if(range&&count>=range.offset&&count-range.offset<range.limit){
    const item=JSON.parse(row.item_json) as unknown;
    if(!item||typeof item!=='object'||Array.isArray(item))conflict();items.push(item as Item);
   }
   count++;
  }
  if(count!==manifest.count||hash.update(']').digest('hex')!==manifest.sha256)conflict();
  return items;
 }
}
