import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const create=(await import('../ordinary-run-completion.js').catch(()=>({}))).createOrdinaryRunCompletionReader;
import * as completion from '../ordinary-run-completion.js';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const sha=v=>createHash('sha256').update(v).digest('hex');
import {ordinaryCompletionFixture as fixture} from "./support/ordinary-completion-fixture.mjs";

test('full native completion covers original and every supplement and retains settled output events without replay',async()=>{
 assert.equal(typeof create,'function');for(const count of [0,2]){const f=fixture(count),before=canonical(f.events),view=await create(f.options)(f.request());assert.equal(view.kind,'ordinary_run_completion');assert.equal(view.execution_authorized,false);assert.equal(view.source_sha256,sha(canonical(f.source)));assert.deepEqual(view.command_ids,f.source.commands.map(c=>c.command_id));assert.deepEqual(view.native_message_ids,f.messages.map(m=>m.id));assert.equal(view.answer_event.type,'assistant/message');assert.equal(view.answer_event.data.message.content[0].type,'reasoning');assert.equal(view.answer_sha256,sha('Synthetic answer'));assert.equal(canonical(f.events),before);assert.deepEqual(f.counts(),{opens:2,closes:2});}
});

function attachmentFixture(){const f=fixture(1),c=f.source.commands[0],message=f.messages[1],sha256='e'.repeat(64),manifest={protocol:1,attachments:[{artifact_id:'artifact-a',version:1,sha256,size_bytes:5,media_type:'application/octet-stream',file_name:'file.bin',kind:'file'}]};message.content.push({type:'file',attachment:{attachmentId:'sha256:'+sha256,bytes:5,name:'file.bin'}});Object.assign(c,{protocol:2,attachment_manifest:manifest,attachment_manifest_sha256:sha(canonical(manifest)),text_sha256:sha(message.content[0].text)});delete c.native_content_sha256;Object.assign(f.stamps[1],{protocol:4,attachment_manifest_sha256:c.attachment_manifest_sha256,native_content_sha256:sha(JSON.stringify(message.content)),native_message_sha256:sha(canonical(message))});f.options.attachmentSteeringProtocol=1;f.options.admissions.steeringAttachmentAdmissionProtocol=1;return f;}

test('full historical attachment completion requires source-bound protocol-4 receipt without replay or reading files',async()=>{const f=attachmentFixture(),before=canonical(f.events),proof=await create(f.options)(f.request());assert.equal(proof.execution_authorized,false);assert.equal(proof.answer_sha256,sha('Synthetic answer'));assert.deepEqual(proof.command_ids,f.source.commands.map(c=>c.command_id));assert.equal(canonical(f.events),before);});

for(const mutation of ['disabled','capability','manifest','normalized','native','legacy-admission'])test('historical attachment completion refuses '+mutation,async()=>{const f=attachmentFixture();if(mutation==='disabled')delete f.options.attachmentSteeringProtocol;if(mutation==='capability')delete f.options.admissions.steeringAttachmentAdmissionProtocol;if(mutation==='manifest')f.stamps[1].attachment_manifest_sha256='f'.repeat(64);if(mutation==='normalized')f.stamps[1].native_content_sha256='f'.repeat(64);if(mutation==='native')f.messages[1].content[1].attachment.bytes=6;if(mutation==='legacy-admission')f.stamps[1].protocol=3;await assert.rejects(async()=>create(f.options)(f.request()));assert.equal(f.counts().opens,f.counts().closes);});

test('missing, late, duplicate or foreign human input cannot certify complete command coverage',async()=>{
 for(const mode of ['missing','late','duplicate','foreign']){const f=fixture();if(mode==='missing')f.events.splice(5,1);if(mode==='late'){const [m]=f.events.splice(5,1);f.events.splice(-2,0,m);}if(mode==='duplicate')f.events.splice(6,0,structuredClone(f.events[5]));if(mode==='foreign')f.events.splice(6,0,{type:'user/message',data:{id:'foreign',role:'user',source:{kind:'user',rpcId:'other'},content:[]}});f.resequence();await assert.rejects(create(f.options)(f.request()),undefined,mode);assert.equal(f.counts().opens,f.counts().closes);}
});

test('raw open boundaries and projected pending or paused/active/blocked Goals never become completion',async()=>{
 for(const mode of ['open-turn','open-step','pending','paused','active','blocked','invalid-projection','logical-closer']){const f=fixture();if(mode==='open-turn')f.events.pop();if(mode==='open-step')f.events.splice(-2,1);if(mode==='pending')f.projected.inbox['next-step'].push(f.messages[1]);if(['paused','active','blocked'].includes(mode))f.projected.goal={goal:{phase:mode}};if(mode==='invalid-projection')delete f.projected.goal;if(mode==='logical-closer'){f.events.pop();f.options.Session.create=(id,log,header)=>{log.push({seq:log.length,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});return{id,header,seq:log.length,snapshotEvents:()=>log};};}f.resequence();await assert.rejects(create(f.options)(f.request()),undefined,mode);}
});

test('source, profile/admission, attachment and incarnation changes refuse before publication',async()=>{
 for(const mode of ['source-digest','cancelled','attached','session-attached','seeded','profile','admission','incarnation','abort']){const f=fixture(),q=f.request();if(mode==='source-digest')q.expectedSourceSha256='0'.repeat(64);if(mode==='cancelled'){f.source.run_status='cancelled';q.expectedSourceSha256=sha(canonical(f.source));}if(mode==='attached')f.options.agents.get=()=>({});if(mode==='session-attached')f.options.sessions.get=()=>({});if(mode==='seeded')f.header.isSeeded=true;if(mode==='profile')f.stamps[1].profile_fingerprint='3'.repeat(64);if(mode==='admission')f.stamps[1].native_message_sha256='3'.repeat(64);if(mode==='incarnation')f.header.createdAt++;if(mode==='abort')q.signal=AbortSignal.abort();await assert.rejects(create(f.options)(q),undefined,mode);assert.equal(f.counts().opens,f.counts().closes);if(['source-digest','cancelled','attached','session-attached','abort'].includes(mode))assert.equal(f.counts().opens,0);}
});

test('a source or raw-prefix change during admission checks invalidates the complete observation',async()=>{
 for(const mode of ['source','raw']){const f=fixture(),read=f.options.admissions.read;let changed=false;f.options.admissions.read=async q=>{const value=await read(q);if(!changed){changed=true;if(mode==='source')f.source.canonical={message_id:'old',status:'complete',content_sha256:'4'.repeat(64),record_sha256:'5'.repeat(64)};else f.events.push({seq:f.events.length,type:'session/end-seed',data:{}});}return value;};await assert.rejects(create(f.options)(f.request()),undefined,mode);assert.equal(f.counts().opens,f.counts().closes);}
});

test('unmatched tool calls remain unknown; matched outputs and file presentations are retained for existing output interpretation',async()=>{
 for(const complete of [false,true]){const f=fixture(0),call={type:'tool/call',data:{turn:1,step:1,callId:'call-1',name:'file_tool'}};f.events.splice(4,0,call);if(complete)f.events.splice(5,0,{type:'tool/result',data:{turn:1,step:1,message:{source:{callId:'call-1'},content:[{type:'text',text:JSON.stringify({status:'completed',output_version:1,artifact_ref:'artifact-fixture'})}]}}},{type:'deliverables/presented',data:{files:[{path:'outputs/report.pdf',description:'Report'}]}});f.resequence();if(!complete)await assert.rejects(create(f.options)(f.request()));else{const view=await create(f.options)(f.request());assert.deepEqual(view.output_events.map(e=>e.type),['tool/result','deliverables/presented']);}}
});

test('an explicit unknown tool result or an uncommitted foreign claimed input cannot be hidden by closed steps',async()=>{
 for(const mode of ['unknown-tool','foreign-claim']){const f=fixture(0);if(mode==='unknown-tool')f.events.splice(4,0,{type:'tool/call',data:{turn:1,step:1,callId:'call-1'}},{type:'tool/result',data:{turn:1,step:1,error:{code:'TOOL_OUTCOME_UNKNOWN'},message:{source:{callId:'call-1'},isError:true}}});else f.events.splice(4,0,{type:'agent/inbox/spliced',data:{target:'next-step',start:0,inserted:[{id:'foreign-claim',role:'user',source:{kind:'user',rpcId:'foreign'},content:[]}]}},{type:'agent/inbox/spliced',data:{target:'next-step',start:0,removedCount:1,inserted:[]}});f.resequence();await assert.rejects(create(f.options)(f.request()),undefined,mode);}
});

test('a foreign claim between original admission and original commit is also part of the unknown tail',async()=>{
 const f=fixture(0);f.events.splice(3,0,{type:'agent/inbox/spliced',data:{target:'next-step',start:0,inserted:[{id:'foreign-before-root',role:'user',source:{kind:'user',rpcId:'foreign'},content:[]}]}},{type:'agent/inbox/spliced',data:{target:'next-step',start:0,removedCount:1,inserted:[]}});f.resequence();await assert.rejects(create(f.options)(f.request()));
});

test('new unfinished assistant chunks cannot be replaced by an older settled answer',async()=>{
 const f=fixture(0);f.events.splice(-1,0,{type:'step/start',data:{turn:1,step:2}},{type:'assistant/chunk',data:{turn:1,step:2,chunk:{type:'text-delta',text:'Unsettled newer draft'}}},{type:'step/end',data:{turn:1,step:2}});f.resequence();await assert.rejects(create(f.options)(f.request()));
});

test('a supplement committed before its original input cannot borrow that original lineage',async()=>{
 const f=fixture(1);[f.events[3],f.events[4]]=[f.events[4],f.events[3]];f.resequence();await assert.rejects(create(f.options)(f.request()));
});

function liveChatFixture(){
 const f=fixture(0);f.options.ordinaryPresets.add('jot-chat');f.header.agentPreset='jot-chat';f.source.run_status='succeeded';f.source.canonical={message_id:'answer',status:'complete',content_sha256:'3'.repeat(64),record_sha256:'4'.repeat(64)};
 const session={id:'s',header:f.header,inheritedEventCount:0,get seq(){return f.events.length;},snapshotEvents:()=>structuredClone(f.events)};
 const agent={id:'s',session,status:'idle',inbox:{nextStep:[],nextTurn:[]},whenIdle:async()=>{}};
 f.options.agents.get=()=>agent;f.options.sessions.get=()=>session;return{...f,agent,session};
}
test('live Chat completion reuses original immutable admissions without a foreground lease or persisted-session open',async()=>{
 assert.equal(typeof completion.createLiveChatRunCompletionReader,'function');const f=liveChatFixture(),before=canonical(f.events);
 const proof=await completion.createLiveChatRunCompletionReader(f.options)(f.request());assert.equal(proof.answer_sha256,sha('Synthetic answer'));assert.equal(proof.execution_authorized,false);assert.deepEqual(f.counts(),{opens:0,closes:0});assert.equal(canonical(f.events),before);
});
test('live maintenance completion refuses busy, pending, foreign, non-Chat and unpublished state',async()=>{
 for(const mode of ['running','pending','foreign','work','unpublished','wrong-session','changed']){
  const f=liveChatFixture();if(mode==='running')f.agent.status='running';if(mode==='pending')f.agent.inbox.nextStep.push({});if(mode==='foreign')f.agent.id='foreign';if(mode==='work')f.header.agentPreset='jot-general';if(mode==='unpublished')f.source.canonical=null;if(mode==='wrong-session')f.options.sessions.get=()=>({...f.session});if(mode==='changed')f.agent.whenIdle=async()=>{f.events.push({seq:f.events.length,type:'turn/start',data:{turn:2}});};
  await assert.rejects(()=>completion.createLiveChatRunCompletionReader(f.options)(f.request()),undefined,mode);assert.deepEqual(f.counts(),{opens:0,closes:0});
 }
});
test('live completion waits for native maintenance boundary and aborts without cancelling another activity',async()=>{
 const f=liveChatFixture(),abort=new AbortController();let entered;const ready=new Promise(resolve=>entered=resolve);
 f.agent.whenIdle=()=>{entered();return new Promise(()=>{});};const promise=completion.createLiveChatRunCompletionReader(f.options)({...f.request(),signal:abort.signal});await ready;abort.abort(Error('new input'));await assert.rejects(()=>promise,/new input/);assert.deepEqual(f.counts(),{opens:0,closes:0});
});
