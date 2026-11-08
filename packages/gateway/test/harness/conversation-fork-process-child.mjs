import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ConversationForks} from '../../src/harness/conversation-fork.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {pinRunNativeSession} from '../../src/harness/run-native-session.ts';

const [mode,root,encoded='{}']=process.argv.slice(2),passed=JSON.parse(encoded);
if(['crash-after-fork-commit','crash-after-attachment-fork-commit'].includes(mode)){
 const original=ConversationForks.prototype.fork;
 ConversationForks.prototype.fork=async function(...args){
  const receipt=await original.apply(this,args);
  writeFileSync(join(root,'fork-commit-boundary.json'),JSON.stringify({conversation_id:receipt.conversation_id,fork_id:receipt.fork_id}));
  process.exit(73);
 };
}
const {buildServer}=await import('../../src/server.ts');
const owner=passed.owner??'fork-process-owner',csrf=passed.csrf??'fork-process-csrf-token-0123456789',sessionId=passed.sessionId??'fork-process-native-session';
let sourceRunId=passed.sourceRunId??'',unexpectedSourceReads=0;
const service=await buildServer({
 databasePath:join(root,'gateway.sqlite'),uploadRoot:join(root,'uploads'),workbenchRoot:join(root,'workspaces'),
 workspaces:['ws'],templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),
 csrfToken:csrf,allowedOrigins:['https://fixture.invalid'],
 conversationForkSourceClient:{inspectConversationForkSource:async requested=>{
  if(!['crash-after-fork-commit','crash-after-attachment-fork-commit','seed-legacy','attachment-verification','attachment-corrupt'].includes(mode)){unexpectedSourceReads++;throw Error('unexpected_source_read_for_durable_fork_receipt');}
  if(requested!==sessionId)throw Error('wrong_fixture_session');
  const events=['attachment-verification','attachment-corrupt','crash-after-attachment-fork-commit'].includes(mode)
   ?[{seq:0,time:1,type:'turn/start',data:{turn:1}},{seq:1,time:2,type:'user/message',data:{source:{kind:'user',rpcId:sourceRunId}}},{seq:2,time:3,type:'assistant/message',data:{turn:1}},{seq:3,time:4,type:'turn/end',data:{turn:1}}]
   :[{seq:0,time:1,type:'user/message',data:{source:{kind:'user',rpcId:sourceRunId}}}];
  return{meta:{id:sessionId,version:4,createdAt:123,origin:'main',isSeeded:false},inheritedEventCount:0,events};
 }}
});
let conversationId=passed.conversationId,messageId=passed.messageId;
if(['crash-after-fork-commit','crash-after-attachment-fork-commit','seed-legacy','seed-empty-legacy','attachment-verification','attachment-corrupt'].includes(mode)){
 const source=service.conversations.create(owner,{workspace_id:'ws',title:'Crash recovery source',model:{provider:'fixture',model:'fixture'}});
 conversationId=source.conversation_id;
 const now=new Date().toISOString();service.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(conversationId,owner,sessionId,now,now);
 const sourceInput=service.runs.enqueue(conversationId,owner,{client_message_id:'fork-process-source-input',content:[{type:'text',text:'Original source transcript'}]});
 messageId=sourceInput.message_id;sourceRunId=sourceInput.run_id;
 const coordinator=new HarnessCoordinator(service.db,service.runs,service.events),lease=coordinator.claimNext('fork-process-worker',30000);
 coordinator.start(lease);pinRunNativeSession(service.db,sourceRunId,{owner:lease.owner,generation:lease.generation},sessionId);
 service.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(sourceRunId);
 if(['attachment-verification','attachment-corrupt','crash-after-attachment-fork-commit'].includes(mode)){
  const artifact='fork-source-artifact',bytes=Buffer.from('verified source attachment'),uploadRoot=join(root,'uploads'),path=join(uploadRoot,'source.txt'),sha256=createHash('sha256').update(bytes).digest('hex'),createdAt=new Date().toISOString();
  mkdirSync(uploadRoot,{recursive:true});writeFileSync(path,mode==='attachment-corrupt'?Buffer.from('tampered source bytes'):bytes);
  service.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,runtime_ref,created_at,updated_at) VALUES(?,?,?,?,1,NULL,?,?)').run(artifact,conversationId,owner,'file',createdAt,createdAt);
  service.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,1,?,?,?,?,?,?)').run(artifact,path,sha256,bytes.length,'text/plain',JSON.stringify({status:'ready',file_name:'source.txt'}),createdAt);
  service.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,1,?)').run(sourceRunId,artifact,createdAt);
  const assistantId='message-fork-attachment-source',assistantContent=JSON.stringify({blocks:[{block_id:'source-assistant-text',kind:'text',text:'Assistant output with a fixed attachment.'}],attachments:[artifact]});
  service.db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,'assistant','complete',?,?,?)").run(assistantId,conversationId,sourceRunId,assistantContent,createdAt,createdAt);
  const second='message-fork-attachment-source-2';service.db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,'assistant','complete',?,?,?)").run(second,conversationId,sourceRunId,assistantContent,createdAt,createdAt);
  messageId=second;
 }
}
process.stdout.write(JSON.stringify({type:'ready',owner,csrf,sessionId,conversationId,messageId,sourceRunId})+'\n');
const lines=createInterface({input:process.stdin});
for await(const line of lines){
 const action=JSON.parse(line);
 if(action.type==='stop'){await service.app.close();service.db.close();process.stdout.write(JSON.stringify({type:'stopped'})+'\n');process.exit(0);}
 if(action.type==='request'){
  const response=await service.app.inject({method:'POST',url:action.url,headers:action.headers,payload:action.payload});
  let legacyPending=false;
  if(mode==='seed-legacy'||mode==='seed-empty-legacy'){
   const operation='POST '+action.url;
   const result=service.db.prepare('UPDATE ga_idempotency SET response_status=NULL,response_json=NULL,receipt_protocol=NULL WHERE owner_id=? AND operation=? AND idempotency_key=?').run(owner,operation,action.headers['idempotency-key']);
   if(result.changes!==1)throw Error('legacy_reservation_not_found');
   legacyPending=true;
  }
  process.stdout.write(JSON.stringify({type:'response',statusCode:response.statusCode,body:response.body,unexpectedSourceReads,legacyPending})+'\n');
 }
}
