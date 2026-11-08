import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction,withReadTransaction} from '../db/database.ts';
import {memoryExpired,serializeMemory,type MemoryRow} from './memory-lifecycle.ts';
import {renderBrainPublication,type BrainSourceFile} from './brain-cli.ts';

type Input=Record<string,unknown>;
type Row=Record<string,string|number|null>;
type Source={memory_id:string;version:number;content:string;verified:boolean};
type FileReference={path:string;version:number;sha256:string;size:number};
type FileChange={path:string;expected_version:number;before_content:string|null;content:string};
type Target={root:string;files:FileReference[]};
type Prepared={project_id:string;page_id:string;title:string;summary:string;sources:Source[];target:Target;files:FileChange[]};
interface Ports{
 authorize(owner:string,workspace:string,project:string):void;
 root(owner:string,workspace:string,project:string):string;
 read(owner:string,workspace:string,project:string,path:string):{content:string};
 write(owner:string,workspace:string,input:Input):Input;
 validatePath(path:string):void;
}
const now=()=>new Date().toISOString();
function text(value:unknown,max:number){if(typeof value!=='string'||!value.trim()||value.length>max)throw Error('invalid_brain_publication');return value.trim();}
function version(value:unknown){if(!Number.isSafeInteger(value)||Number(value)<1)throw Error('invalid_brain_publication');return Number(value);}
function exact(input:Input,keys:string[]){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))throw Error('invalid_brain_publication');}

/** Brain is reviewed project-file publication. The original memory ledger and
 * original file versions retain authority over their respective data. */
export class MemoryBrainService{
 private preparing=false;
 constructor(private readonly db:DatabaseSync,private readonly ports:Ports){
  db.exec(`CREATE TABLE IF NOT EXISTS wb_brain_publications(
   sequence INTEGER PRIMARY KEY AUTOINCREMENT,publication_id TEXT UNIQUE NOT NULL,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,
   page_id TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,sources_json TEXT NOT NULL,target_json TEXT NOT NULL,files_json TEXT NOT NULL,
   status TEXT NOT NULL CHECK(status IN('proposed','applied','rejected')),version INTEGER NOT NULL,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS wb_brain_publications_owner ON wb_brain_publications(owner_id,workspace_id,project_id,sequence);
   CREATE TRIGGER IF NOT EXISTS wb_brain_publication_no_delete BEFORE DELETE ON wb_brain_publications BEGIN SELECT RAISE(ABORT,'brain_publication_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_brain_publication_no_replace BEFORE INSERT ON wb_brain_publications WHEN EXISTS(SELECT 1 FROM wb_brain_publications WHERE sequence=NEW.sequence OR publication_id=NEW.publication_id) BEGIN SELECT RAISE(ABORT,'brain_publication_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_brain_publication_guard BEFORE UPDATE ON wb_brain_publications
    WHEN NEW.sequence IS NOT OLD.sequence OR NEW.publication_id IS NOT OLD.publication_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.project_id IS NOT OLD.project_id
     OR NEW.page_id IS NOT OLD.page_id OR NEW.title IS NOT OLD.title OR NEW.summary IS NOT OLD.summary OR NEW.sources_json IS NOT OLD.sources_json OR NEW.target_json IS NOT OLD.target_json OR NEW.files_json IS NOT OLD.files_json OR NEW.created_at IS NOT OLD.created_at
     OR OLD.status!='proposed' OR NEW.status NOT IN('applied','rejected') OR NEW.version!=OLD.version+1 OR (NEW.status='applied' AND NEW.result_json IS NULL) OR (NEW.status='rejected' AND NEW.result_json IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'brain_publication_immutable'); END;`);
 }
 private source(owner:string,workspace:string,project:string,id:string):Source{
  const row=this.db.prepare("SELECT * FROM wb_memories WHERE owner_id=? AND workspace_id=? AND project_id=? AND memory_id=? AND scope='project' AND agent_id IS NULL AND status='active'").get(owner,workspace,project,id) as MemoryRow|undefined;
  if(!row||memoryExpired(row))throw Error('brain_publication_source_unavailable');
  const memory=serializeMemory(row);
  return {memory_id:id,version:Number(memory.version),content:String(memory.content),verified:memory.verified===true};
 }
 private sourcesCurrent(owner:string,workspace:string,project:string,sources:Source[]){
  return sources.every(source=>{try{return JSON.stringify(this.source(owner,workspace,project,source.memory_id))===JSON.stringify(source);}catch(error){if(error instanceof Error&&error.message==='brain_publication_source_unavailable')return false;throw error;}});
 }
 private target(owner:string,workspace:string,project:string):Target{
  const root='brain';
  const prefix=root+'/';
  const files=this.db.prepare(`SELECT path,version,sha256,size FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? AND (path='BRAIN.md' OR substr(path,1,length(?))=?) ORDER BY path COLLATE BINARY LIMIT 201`).all(owner,workspace,project,prefix,prefix) as FileReference[];
  if(files.length>200||files.reduce((size,file)=>size+Number(file.size),0)>8388608)throw Error('brain_publication_too_large');
  return {root,files};
 }
 async prepare(owner:string,workspace:string,input:Input):Promise<Prepared>{
  if(this.preparing)throw Error('brain_publication_busy');this.preparing=true;
  try{
   exact(input,['project_id','page_id','title','summary','memory_ids']);
   const project=text(input.project_id,128),page=text(input.page_id,80),title=text(input.title,200),summary=text(input.summary,1000);
   if(!/^[a-z0-9][a-z0-9-]*$/.test(page)||/[\r\n]/.test(title)||title.startsWith('--')||summary.startsWith('--')||!Array.isArray(input.memory_ids)||!input.memory_ids.length||input.memory_ids.length>10||new Set(input.memory_ids).size!==input.memory_ids.length)throw Error('invalid_brain_publication');
   const ids=input.memory_ids.map(id=>text(id,128));
   if(new Set(ids).size!==ids.length)throw Error('invalid_brain_publication');
   const snapshot=withReadTransaction(this.db,()=>{
    this.ports.authorize(owner,workspace,project);
    this.assertQueueAvailable(owner,workspace,project);
    const sources=ids.map(id=>this.source(owner,workspace,project,id));
    if(sources.reduce((size,source)=>size+source.content.length,0)>20000)throw Error('brain_publication_too_large');
    const target=this.target(owner,workspace,project),files:BrainSourceFile[]=[];
    for(const file of target.files){
     if(file.path==='BRAIN.md'||file.path.endsWith('.md')){
      if(file.size>1048576)throw Error('brain_publication_too_large');
      files.push({path:file.path,content:this.ports.read(owner,workspace,project,file.path).content});
     }
    }
    return {sources,target,files};
   });
   const body=snapshot.sources.map(source=>`${source.content.split(/\r\n|[\n\r\u2028\u2029]/).map(line=>'> '+line).join('\n')}\n\nSource Jot project memory ${source.memory_id} at version ${source.version}.`).join('\n\n---\n\n');
   const rendered=await renderBrainPublication(this.ports.root(owner,workspace,project),{root:snapshot.target.root,page_id:page,title,summary,source:snapshot.sources.map(source=>`jot-memory/${source.memory_id}@${source.version}`).join(', '),content:body,files:snapshot.files});
   const original=new Map(snapshot.files.map(file=>[file.path,file.content]));
   const files=rendered.filter(file=>file.content!==original.get(file.path)).map(file=>({path:file.path,expected_version:snapshot.target.files.find(prior=>prior.path===file.path)?.version??0,before_content:original.get(file.path)??null,content:file.content}));
   if(!files.length)throw Error('brain_publication_no_changes');
   for(const file of files)this.ports.validatePath(file.path);
   return {project_id:project,page_id:page,title,summary,sources:snapshot.sources,target:snapshot.target,files};
  }finally{this.preparing=false;}
 }
 private assertQueueAvailable(owner:string,workspace:string,project:string){
  const pending=this.db.prepare("SELECT count(*) AS n FROM wb_brain_publications WHERE owner_id=? AND workspace_id=? AND project_id=? AND status='proposed'").get(owner,workspace,project) as {n:number};
  if(pending.n>=10)throw Error('brain_publication_queue_full');
 }
 preview(owner:string,workspace:string,prepared:Prepared){return withImmediateTransaction(this.db,()=>{
  this.ports.authorize(owner,workspace,prepared.project_id);
  this.assertCurrent(owner,workspace,prepared);
  this.assertFileTargets(owner,workspace,prepared.project_id,prepared.files);
  this.assertQueueAvailable(owner,workspace,prepared.project_id);
  const id='brainpub-'+randomUUID(),at=now();
  this.db.prepare(`INSERT INTO wb_brain_publications(publication_id,owner_id,workspace_id,project_id,page_id,title,summary,sources_json,target_json,files_json,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'proposed',1,?,?)`)
   .run(id,owner,workspace,prepared.project_id,prepared.page_id,prepared.title,prepared.summary,JSON.stringify(prepared.sources),JSON.stringify(prepared.target),JSON.stringify(prepared.files),at,at);
  return this.get(owner,workspace,id);
 });}
 private assertCurrent(owner:string,workspace:string,prepared:Pick<Prepared,'project_id'|'sources'|'target'>){
  if(!this.sourcesCurrent(owner,workspace,prepared.project_id,prepared.sources))throw Error('brain_publication_source_conflict');
  if(JSON.stringify(this.target(owner,workspace,prepared.project_id))!==JSON.stringify(prepared.target))throw Error('brain_publication_target_conflict');
 }
 private assertFileTargets(owner:string,workspace:string,project:string,files:FileChange[]){
  for(const file of files){
   const conflict=this.db.prepare(`SELECT 1 FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? AND path!=?
    AND (substr(path,1,length(?)+1)=?||'/' OR substr(?,1,length(path)+1)=path||'/') LIMIT 1`).get(owner,workspace,project,file.path,file.path,file.path,file.path);
   if(conflict)throw Error('brain_publication_target_conflict');
  }
 }
 private row(owner:string,workspace:string,id:string){
  const row=this.db.prepare('SELECT * FROM wb_brain_publications WHERE owner_id=? AND workspace_id=? AND publication_id=?').get(owner,workspace,id) as Row|undefined;
  if(!row)throw Error('brain_publication_not_found');this.ports.authorize(owner,workspace,String(row.project_id));return row;
 }
 private header(row:Row){return {publication_id:String(row.publication_id),workspace_id:String(row.workspace_id),project_id:String(row.project_id),page_id:String(row.page_id),title:String(row.title),summary:String(row.summary),status:String(row.status),version:Number(row.version),created_at:String(row.created_at),updated_at:String(row.updated_at)};}
 get(owner:string,workspace:string,id:string){return withReadTransaction(this.db,()=>{
  const row=this.row(owner,workspace,id),sources=JSON.parse(String(row.sources_json)) as Source[],target=JSON.parse(String(row.target_json)) as Target;
  const files=JSON.parse(String(row.files_json)) as FileChange[];
  const sourceCurrent=this.sourcesCurrent(owner,workspace,String(row.project_id),sources);let targetCurrent=false;
  if(row.status==='proposed')try{
   this.assertFileTargets(owner,workspace,String(row.project_id),files);
   targetCurrent=JSON.stringify(this.target(owner,workspace,String(row.project_id)))===JSON.stringify(target);
  }catch{/* Unreadable target data keeps approval closed. */}
  return {
   ...this.header(row),brain_root:target.root,current:sourceCurrent&&targetCurrent,
   sources:sources.map(source=>({...source,content:sourceCurrent?source.content:null})),
   files:sourceCurrent?files:[],results:row.result_json?JSON.parse(String(row.result_json)):null,
  };
 });}
 list(owner:string,workspace:string,project:string,beforeId?:string){
  this.ports.authorize(owner,workspace,project);let before:number|null=null;
  if(beforeId!==undefined){const row=this.row(owner,workspace,beforeId);if(row.project_id!==project)throw Error('brain_publication_not_found');before=Number(row.sequence);}
  const rows=this.db.prepare('SELECT * FROM wb_brain_publications WHERE owner_id=? AND workspace_id=? AND project_id=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT 26').all(owner,workspace,project,before,before) as Row[];
  return {items:rows.slice(0,25).map(row=>this.header(row)),next_before_id:rows.length>25?String(rows[24]!.publication_id):null};
 }
 apply(owner:string,workspace:string,id:string,expectedVersion:number){return withImmediateTransaction(this.db,()=>{
  const row=this.row(owner,workspace,id);version(expectedVersion);
  if(row.status==='applied')return this.get(owner,workspace,id);
  if(Number(row.version)!==expectedVersion)throw Error('version_conflict');
  if(row.status!=='proposed')throw Error('brain_publication_state_conflict');
  const sources=JSON.parse(String(row.sources_json)) as Source[],target=JSON.parse(String(row.target_json)) as Target,files=JSON.parse(String(row.files_json)) as FileChange[];
  this.assertCurrent(owner,workspace,{project_id:String(row.project_id),sources,target});
  this.assertFileTargets(owner,workspace,String(row.project_id),files);
  const results=files.map(file=>this.ports.write(owner,workspace,{project_id:row.project_id,path:file.path,expected_version:file.expected_version,content:file.content}));
  this.db.prepare("UPDATE wb_brain_publications SET status='applied',version=version+1,result_json=?,updated_at=? WHERE publication_id=?").run(JSON.stringify(results),now(),id);
  return this.get(owner,workspace,id);
 });}
 reject(owner:string,workspace:string,id:string,expectedVersion:number){return withImmediateTransaction(this.db,()=>{
  const row=this.row(owner,workspace,id);if(Number(row.version)!==version(expectedVersion))throw Error('version_conflict');if(row.status!=='proposed')throw Error('brain_publication_state_conflict');
  this.db.prepare("UPDATE wb_brain_publications SET status='rejected',version=version+1,updated_at=? WHERE publication_id=?").run(now(),id);return this.get(owner,workspace,id);
 });}
}
