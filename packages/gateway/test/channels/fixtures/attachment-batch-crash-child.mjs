// Deliberate isolated process death inside the original SQLite transaction.
import {join,resolve} from 'node:path';
import {buildServer} from '../../../src/server.ts';
import {ChannelIntakeService} from '../../../src/channels/intake.ts';
import {OwnerChannelBindings} from '../../../src/channels/owner-bindings.ts';
const [root,bindingId,key]=process.argv.slice(2);
const service=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],uploadRoot:join(root,'files'),templateRoot:resolve('packages/gateway/file-engine/templates')});
const intake=new ChannelIntakeService(service.db,service.runs,'ws',new OwnerChannelBindings(service.db,{enabled:['wecom']}));
const complete=service.artifacts.complete.bind(service.artifacts);let calls=0;
service.artifacts.complete=(...args)=>{if(++calls===2)process.exit(73);return complete(...args);};
await intake.acceptAttachmentBatchV2('alice',bindingId,key,service.artifacts);
process.exit(74);
