// Synthetic process-exit fixture; no network listener, provider or credentials.
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {buildServer} from '../../../src/server.ts';
const [directory,stage]=process.argv.slice(2),bytes=Buffer.from('Upload recovery fixture.'),sha=createHash('sha256').update(bytes).digest('hex');
if(!directory||!['init','content','complete'].includes(stage))throw new Error('fixture_arguments_invalid');
const service=await buildServer({databasePath:join(directory,'product.sqlite'),workspaces:['shared'],uploadRoot:join(directory,'uploads'),templateRoot:resolve('file-engine/templates'),csrfToken:'test-upload-recovery-auth',allowedOrigins:['http://localhost:3058']});
const conversation=service.conversations.create('test-owner',{workspace_id:'shared',model:{provider:'fixture',model:'fixture'}}),headers=key=>({'x-user-id':'test-owner',origin:'http://localhost:3058','x-csrf-token':'test-upload-recovery-auth','idempotency-key':key});
const init=()=>service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/uploads`,headers:headers('test-upload-init'),payload:{file_name:'sample.txt',size_bytes:bytes.length,media_type:'text/plain',sha256:sha}});
let id;
if(stage!=='init')id=(await init()).json().upload_id;
const put=()=>service.app.inject({method:'PUT',url:`/v1/uploads/${id}/content`,headers:{...headers('test-upload-content'),'content-type':'application/octet-stream'},payload:bytes});
if(stage==='complete')await put();
service.db.function('test_exit',()=>{process.exit(91);});
const status=stage==='content'?204:201,key=`test-upload-${stage}`;
service.db.exec(`CREATE TRIGGER test_exit BEFORE UPDATE ON ga_idempotency WHEN NEW.response_status=${status} AND OLD.idempotency_key='${key}' BEGIN SELECT test_exit();END;`);
if(stage==='init')await init();else if(stage==='content')await put();else await service.app.inject({method:'POST',url:`/v1/uploads/${id}/complete`,headers:headers('test-upload-complete'),payload:{sha256:sha}});
throw new Error('fixture_did_not_exit');
