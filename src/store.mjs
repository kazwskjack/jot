import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
const now=()=>new Date().toISOString();
export class Store {
  constructor(path) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,run_id TEXT);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),request_id TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,UNIQUE(conversation_id,request_id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id),type TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),run_id TEXT,name TEXT NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL);
    `);
    if(!this.db.prepare('PRAGMA table_info(messages)').all().some(c=>c.name==='run_id'))this.db.exec('ALTER TABLE messages ADD COLUMN run_id TEXT');
    // Legacy rows retain their original Work meaning. A later mode change never
    // changes the execution mode/version of a previously accepted input.
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const conversationColumns=new Set(this.db.prepare('PRAGMA table_info(conversations)').all().map(c=>c.name));
      const runColumns=new Set(this.db.prepare('PRAGMA table_info(runs)').all().map(c=>c.name));
      if(!conversationColumns.has('mode'))this.db.exec("ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'work' CHECK(mode IN ('chat','work'))");
      if(!conversationColumns.has('version'))this.db.exec('ALTER TABLE conversations ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)');
      if(!runColumns.has('mode'))this.db.exec("ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'work' CHECK(mode IN ('chat','work'))");
      if(!runColumns.has('conversation_version'))this.db.exec('ALTER TABLE runs ADD COLUMN conversation_version INTEGER NOT NULL DEFAULT 1 CHECK(conversation_version>=1)');
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');this.db.close();throw error;}
  }
  createConversation(title='New chat',mode='work') {if(!['chat','work'].includes(mode))throw new Error('invalid_mode');const c={id:randomUUID(),title,created_at:now(),mode,version:1};this.db.prepare('INSERT INTO conversations(id,title,created_at,mode,version) VALUES(?,?,?,?,?)').run(c.id,c.title,c.created_at,c.mode,c.version);return c;}
  changeMode(id,mode,expectedVersion){
    if(!['chat','work'].includes(mode))throw new Error('invalid_mode');
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new Error('invalid_version');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const c=this.conversation(id);if(!c)throw new Error('conversation_not_found');
      if(c.version!==expectedVersion)throw new Error('version_conflict');
      if(this.db.prepare("SELECT id FROM runs WHERE conversation_id=? AND status IN ('queued','running','waiting_approval')").get(id))throw new Error('conversation_busy');
      this.db.prepare('UPDATE conversations SET mode=?,version=version+1 WHERE id=? AND version=?').run(mode,id,expectedVersion);
      const saved=this.conversation(id);this.db.exec('COMMIT');return saved;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  conversations(){return this.db.prepare('SELECT * FROM conversations ORDER BY created_at DESC').all();}
  conversation(id){return this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);}
  messages(id){return this.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid').all(id);}
  message(id,role,content,runId=null){const m={id:randomUUID(),conversation_id:id,role,content,created_at:now(),run_id:runId};this.db.prepare('INSERT INTO messages(id,conversation_id,role,content,created_at,run_id) VALUES(?,?,?,?,?,?)').run(m.id,id,role,content,m.created_at,runId);return m;}
  event(id,type,data){const r=this.db.prepare('INSERT INTO events(conversation_id,type,data) VALUES(?,?,?)').run(id,type,JSON.stringify(data));return {seq:Number(r.lastInsertRowid),type,data};}
  events(id,after){return this.db.prepare('SELECT seq,type,data FROM events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT 500').all(id,after).map(e=>({...e,data:JSON.parse(e.data)}));}
  accept(id,text,requestId,{chatReady=false}={}){
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const conversation=this.conversation(id);if(!conversation)throw new Error('conversation_not_found');
      const existing=this.db.prepare('SELECT * FROM runs WHERE conversation_id=? AND request_id=?').get(id,requestId);
      if(existing){if(existing.input!==text)throw new Error('idempotency_conflict');this.db.exec('COMMIT');return {run:existing,duplicate:true};}
      if(conversation.mode==='chat'&&!chatReady)throw new Error('chat_unavailable');
      if(this.db.prepare("SELECT id FROM runs WHERE conversation_id=? AND status IN ('queued','running','waiting_approval')").get(id))throw new Error('conversation_busy');
      const run={id:randomUUID(),conversation_id:id,request_id:requestId,input:text,status:'queued',created_at:now(),mode:conversation.mode,conversation_version:conversation.version};
      this.db.prepare('INSERT INTO runs(id,conversation_id,request_id,input,status,created_at,mode,conversation_version) VALUES(?,?,?,?,?,?,?,?)').run(run.id,id,requestId,text,run.status,run.created_at,run.mode,run.conversation_version);
      this.message(id,'user',text,run.id);this.event(id,'run.state',{run});this.db.exec('COMMIT');return {run,duplicate:false};
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  run(id){return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);}
  runs(id){return this.db.prepare('SELECT * FROM runs WHERE conversation_id=? ORDER BY rowid').all(id);}
  state(id,status,error=null){this.db.prepare('UPDATE runs SET status=?,error=? WHERE id=?').run(status,error,id);const run=this.run(id);this.event(run.conversation_id,'run.state',{run});return run;}
  artifact(a){this.db.prepare('INSERT INTO artifacts(id,conversation_id,run_id,name,path,size) VALUES(?,?,?,?,?,?)').run(a.id,a.conversation_id,a.run_id??null,a.name,a.path,a.size);}
  artifacts(id){return this.db.prepare('SELECT id,run_id,name,size FROM artifacts WHERE conversation_id=?').all(id);}
  getArtifact(id){return this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id);}
  recover(){for(const r of this.db.prepare("SELECT id FROM runs WHERE status IN ('queued','running','waiting_approval')").all())this.state(r.id,'interrupted','server_restarted');}
  snapshot(id){const runs=this.runs(id),waiting=runs.find(r=>r.status==='waiting_approval');const approval=waiting?this.db.prepare("SELECT data FROM events WHERE conversation_id=? AND type='approval.request' ORDER BY seq DESC LIMIT 1").get(id):null;return {conversation:this.conversation(id),messages:this.messages(id),runs,artifacts:this.artifacts(id),approval:approval?JSON.parse(approval.data):null,seq:this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE conversation_id=?').get(id).seq};}
  close(){this.db.close();}
}
