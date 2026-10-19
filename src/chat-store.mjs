import {digest,chatSeed,validateChatPolicy,modelUsage} from './chat-policy.mjs';
export function initChatTables(db){db.exec(`
 CREATE TABLE IF NOT EXISTS chat_execution(run_id TEXT PRIMARY KEY REFERENCES runs(id),policy TEXT NOT NULL,seed TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS chat_web_groups(run_id TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL CHECK(kind IN ('search','fetch')),manifest_hash TEXT NOT NULL,PRIMARY KEY(run_id,kind));
 CREATE TABLE IF NOT EXISTS chat_web_calls(run_id TEXT NOT NULL REFERENCES runs(id),call_id TEXT NOT NULL,kind TEXT NOT NULL,signature TEXT NOT NULL,status TEXT NOT NULL,result TEXT,PRIMARY KEY(run_id,call_id));
 CREATE TABLE IF NOT EXISTS chat_model_calls(run_id TEXT NOT NULL REFERENCES runs(id),step INTEGER NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,usage TEXT,PRIMARY KEY(run_id,step));
`);}
export function saveChatExecution(store,run,policy){const checked=validateChatPolicy(policy),seed=chatSeed(store.messages(run.conversation_id),store.artifacts(run.conversation_id));store.db.prepare('INSERT INTO chat_execution VALUES(?,?,?)').run(run.id,JSON.stringify(checked),JSON.stringify(seed));}
export function chatExecution(db,runId){const row=db.prepare('SELECT policy,seed FROM chat_execution WHERE run_id=?').get(runId);return row?{policy:JSON.parse(row.policy),seed:JSON.parse(row.seed)}:null;}
export function boundedResult(result){try{const encoded=JSON.stringify(result);return encoded&&encoded.length<=60000?JSON.parse(encoded):{error:'tool_result_too_large'};}catch{return{error:'tool_result_invalid'};}}
function activeChat(db,id){const row=db.prepare('SELECT mode,status FROM runs WHERE id=?').get(id);if(row?.mode!=='chat'||row.status!=='running'||!chatExecution(db,id))throw Error('invalid_chat_run');}
export function reserveChatGroup(db,id,kind,calls){
 if(!['search','fetch'].includes(kind)||!Array.isArray(calls)||!calls.length||calls.length>64)throw Error('invalid_tool_group');
 const entries=calls.map(call=>{if(typeof call.id!=='string'||!call.id||call.id.length>128||call.function?.name!==(kind==='search'?'search':'read_page')||typeof call.function.arguments!=='string')throw Error('invalid_tool_call');return{id:call.id,signature:digest(call.function),args:JSON.parse(call.function.arguments)};});
 if(new Set(entries.map(e=>e.id)).size!==entries.length)throw Error('invalid_tool_call');
 db.exec('BEGIN IMMEDIATE');
 try{
  activeChat(db,id);const existing=db.prepare('SELECT manifest_hash FROM chat_web_groups WHERE run_id=? AND kind=?').get(id,kind);
  const result=[];
  if(existing){for(const entry of entries){const saved=db.prepare('SELECT * FROM chat_web_calls WHERE run_id=? AND call_id=?').get(id,entry.id);result.push({id:entry.id,dispatch:false,result:saved&&saved.kind===kind&&saved.signature===entry.signature?(saved.result?JSON.parse(saved.result):{error:'tool_outcome_unknown'}):{error:saved?'invalid_tool_call_reused':'tool_allowance_exhausted'}});}}
  else{
   db.prepare('INSERT INTO chat_web_groups VALUES(?,?,?)').run(id,kind,digest(calls));const urls=new Set();
   for(const entry of entries){
    let denied;
    if(kind==='fetch'){let url;try{url=new URL(entry.args.url);url.hash='';}catch{throw Error('invalid_tool_arguments');}if(urls.has(url.href))denied={error:'tool_url_already_read'};urls.add(url.href);}
    db.prepare('INSERT INTO chat_web_calls VALUES(?,?,?,?,?,?)').run(id,entry.id,kind,entry.signature,denied?'complete':'reserved',denied?JSON.stringify(denied):null);
    result.push({id:entry.id,dispatch:!denied,...(denied?{result:denied}:{})});
   }
  }
  db.exec('COMMIT');return result;
 }catch(error){db.exec('ROLLBACK');throw error;}
}
export function settleChatTool(db,id,call,result){const encoded=JSON.stringify(boundedResult(result));const saved=db.prepare('SELECT signature,status,result FROM chat_web_calls WHERE run_id=? AND call_id=?').get(id,call.id);if(!saved||saved.signature!==digest(call.function))throw Error('invalid_tool_receipt');if(saved.status==='complete'){if(saved.result!==encoded)throw Error('invalid_tool_receipt');return;}db.prepare("UPDATE chat_web_calls SET status='complete',result=? WHERE run_id=? AND call_id=? AND status='reserved'").run(encoded,id,call.id);}
export function startChatModelCall(db,id,step,hash){activeChat(db,id);if(!Number.isSafeInteger(step)||step<0||!/^[a-f0-9]{64}$/.test(hash))throw Error('invalid_model_call');if(db.prepare('SELECT step FROM chat_model_calls WHERE run_id=? AND step=?').get(id,step))throw Error('model_outcome_unknown');db.prepare("INSERT INTO chat_model_calls VALUES(?,?,?,'pending',NULL)").run(id,step,hash);}
export function finishChatModelCall(db,id,step,status,usage){if(!['complete','failed','cancelled'].includes(status))throw Error('invalid_model_call');const parsed=modelUsage(usage);db.prepare("UPDATE chat_model_calls SET status=?,usage=? WHERE run_id=? AND step=? AND status='pending'").run(status,parsed?JSON.stringify(parsed):null,id,step);}
export function chatModelCalls(db,id){return db.prepare('SELECT step,status,usage FROM chat_model_calls WHERE run_id=? ORDER BY step').all(id).map(row=>({...row,usage:row.usage?JSON.parse(row.usage):null}));}
