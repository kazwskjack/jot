const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/,EVENT='jot-git-request-drafts-changed',MAX=1024*1024;
const invalid=()=>{throw Error('GIT_REQUEST_DRAFT_INVALID')};
const object=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))invalid()};
const id=value=>{if(typeof value!=='string'||!ID.test(value))invalid();return value};
const encoded=value=>{let decoded;try{decoded=decodeURIComponent(value)}catch{invalid()}id(decoded);if(encodeURIComponent(decoded)!==value)invalid();return decoded};
const storageValue=value=>typeof value==='function'?value():value;
const prefix=(scope,project)=>{if(typeof scope!=='string'||!SHA.test(scope))invalid();id(project);return 'jot-git-request:v1:'+scope+':'+encodeURIComponent(project)+':'};
const changed=()=>{if(globalThis.window?.dispatchEvent)window.dispatchEvent(new window.Event(EVENT))};
export const gitCommandDraftEvent=EVENT;
function command(value,project){
 object(value,['path','method','body','key']);if(value.method!=='POST'||typeof value.path!=='string'||value.path.length>4096)invalid();id(value.key);
 const parts=/^\/projects\/([^/]+)\/git\/(intents|executions)(?:\/([^/]+)\/(admissions|control|controls))?$/.exec(value.path);if(!parts||encoded(parts[1])!==project)invalid();
 const body=value.body;object(body,['request_id','action','paths','snapshot_id','message','expected_version','review_sha256','expected_state_sha256','acknowledge_unknown']);id(body.request_id);
 const exact=keys=>{if(Object.keys(body).length!==keys.length||Object.keys(body).some(key=>!keys.includes(key)))invalid()};
 const version=()=>{if(!Number.isSafeInteger(body.expected_version)||body.expected_version<1||typeof body.review_sha256!=='string'||!SHA.test(body.review_sha256))invalid()};
 if(parts[2]==='intents'&&!parts[3]){
  if(!['stage','unstage','commit','discard','delete-untracked'].includes(body.action))invalid();exact(['request_id','action','paths','snapshot_id',...(body.action==='commit'?['message']:[])]);
  if(typeof body.snapshot_id!=='string'||!SHA.test(body.snapshot_id)||!Array.isArray(body.paths)||!body.paths.length||body.paths.length>100||new Set(body.paths).size!==body.paths.length)invalid();
  for(const path of body.paths)if(typeof path!=='string'||!path||path.length>4096||path.startsWith('/')||path.startsWith('-')||/^[A-Za-z]:/.test(path)||/[\\\0]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))invalid();
  if(body.action==='commit'&&(typeof body.message!=='string'||!body.message.trim()||body.message.length>4096||body.message.includes('\0')))invalid();
  return{kind:'review-prepare'};
 }
 if(!parts[3])invalid();const target=encoded(parts[3]);
 if(parts[2]==='intents'&&parts[4]==='admissions'){exact(['request_id','expected_version','review_sha256']);version();return{kind:'admit',intent_id:target}}
 if(parts[2]==='intents'&&parts[4]==='control'){exact(['request_id','expected_version','review_sha256','action']);version();if(!['approve','cancel'].includes(body.action))invalid();return{kind:'review-control',intent_id:target}}
 if(parts[2]==='executions'&&parts[4]==='controls'){exact(['request_id','expected_state_sha256','acknowledge_unknown']);if(typeof body.expected_state_sha256!=='string'||!SHA.test(body.expected_state_sha256)||body.acknowledge_unknown!==true)invalid();return{kind:'control',execution_id:target}}
 invalid();
}
function record(raw,scope,project,key){
 if(typeof raw!=='string'||raw.length>MAX)invalid();let value;try{value=JSON.parse(raw)}catch{invalid()}
 object(value,['version','scope','project','command']);if(Object.keys(value).length!==4||value.version!==1||value.scope!==scope||value.project!==project||value.command?.key!==key)invalid();
 return{key,...command(value.command,project),command:structuredClone(value.command)};
}
/** Untrusted browser recovery hints only. Server receipts remain authoritative;
 * loading a hint never sends a request or grants review/native execution. */
export class GitCommandDraftStore{
 constructor(storage,scope,project,key){this.storage=storage;this.scope=scope;this.project=project;this.key=key??null;this.original=null}
 read(){if(this.key===null)return null;id(this.key);const raw=storageValue(this.storage).getItem(prefix(this.scope,this.project)+encodeURIComponent(this.key));if(raw===null){this.original=null;return null}const value=record(raw,this.scope,this.project,this.key);this.original=raw;return{command:value.command}}
 saveCommand(value){
  if(value===null){this.complete();return}command(value,this.project);const name=prefix(this.scope,this.project)+encodeURIComponent(value.key);if(this.key!==null&&this.key!==value.key)invalid();
  const raw=JSON.stringify({version:1,scope:this.scope,project:this.project,command:structuredClone(value)});if(raw.length>MAX)invalid();const storage=storageValue(this.storage),prior=storage.getItem(name);if(prior!==null&&prior!==raw)throw Error('GIT_REQUEST_DRAFT_CONFLICT');storage.setItem(name,raw);this.key=value.key;this.original=raw;changed();
 }
 complete(){if(this.key===null)return;const storage=storageValue(this.storage),name=prefix(this.scope,this.project)+encodeURIComponent(this.key),current=storage.getItem(name);if(current!==null&&current!==this.original)throw Error('GIT_REQUEST_DRAFT_CONFLICT');if(current!==null)storage.removeItem(name);this.key=null;this.original=null;changed()}
}
export function listGitCommandDrafts(source,scope,project){
 const start=prefix(scope,project),storage=storageValue(source),rows=[];if(!Number.isSafeInteger(storage.length)||storage.length>2000)invalid();
 for(let n=0;n<storage.length;n++){const name=storage.key(n);if(typeof name!=='string'||!name.startsWith(start))continue;const key=encoded(name.slice(start.length)),raw=storage.getItem(name);if(raw===null)continue;rows.push(record(raw,scope,project,key));if(rows.length>50)invalid()}
 return rows.sort((a,b)=>a.key.localeCompare(b.key));
}
