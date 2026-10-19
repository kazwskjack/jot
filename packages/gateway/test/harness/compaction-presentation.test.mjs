import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {projectSessionFrame} from '../../src/harness/session-event-projector.ts';
const base={runId:'run-native',attemptId:'attempt-native',messageId:'stream-native',blockId:'text',deltaIndex:0,at:'2026-10-19T00:00:00.000Z'};
const frame=(type,data={})=>({type:'event',event:{type,data:{compactionId:'compact-native',turn:null,...data}}});
const ctx=()=>({...base,compaction:{mode:'work',states:new Map()}});
test('native Work compaction explicitly projects paired metadata without tool or model content',()=>{
 const c=ctx(),start=projectSessionFrame(frame('compaction/start',{summary:'PRIVATE',rawOutput:'PRIVATE',model:'PRIVATE'}),c);
 assert.ok(start,'Work start must be projected');assert.equal(start.type,'activity.upsert');assert.equal(start.payload.kind,'compaction');assert.equal(start.payload.status,'running');assert.equal(Object.hasOwn(start.payload,'tool_call_id'),false);assert.doesNotMatch(JSON.stringify(start),/PRIVATE/);
 const end=projectSessionFrame(frame('compaction/end'),{...c,at:'2026-10-19T00:00:05.000Z'});assert.equal(end.payload.activity_id,start.payload.activity_id);assert.equal(end.payload.started_at,start.payload.started_at);assert.equal(end.payload.status,'succeeded');assert.equal(end.payload.ended_at,'2026-10-19T00:00:05.000Z');
 assert.equal(projectSessionFrame(frame('compaction/start'),c),null);assert.equal(projectSessionFrame(frame('compaction/end'),c),null);
});
test('native compaction remains invisible by default and in Chat; unmatched ends and malformed IDs cannot imply success',()=>{
 for(const c of [base,{...base,compaction:{mode:'chat',states:new Map()}},ctx()])assert.equal(projectSessionFrame(frame('compaction/end'),c),null);
 for(const c of [base,{...base,compaction:{mode:'chat',states:new Map()}}])assert.equal(projectSessionFrame(frame('compaction/start'),c),null);
 for(const compactionId of ['',3,'bad/id','x'.repeat(193)])assert.equal(projectSessionFrame(frame('compaction/start',{compactionId}),ctx()),null);
 assert.equal(projectSessionFrame(frame('compaction/summary',{summary:'PRIVATE'}),ctx()),null);
});
test('failed native compaction exposes only a fixed status and cannot later become success',()=>{
 const c=ctx();projectSessionFrame(frame('compaction/start'),c);const failed=projectSessionFrame(frame('compaction/end',{error:'PRIVATE provider response'}),c);assert.equal(failed.payload.status,'failed');assert.doesNotMatch(JSON.stringify(failed),/PRIVATE|provider response/);assert.equal(projectSessionFrame(frame('compaction/end'),c),null);
});
test('explicit compaction schemas agree and reject summary, tool authority and extra details',()=>{
 const read=name=>JSON.parse(readFileSync(new URL('../../contracts/'+name,import.meta.url),'utf8'));const spec=read('openapi.json'),event=read('agent-event.schema.json');
 const schema=spec.components.schemas.Activity_compaction;assert.ok(schema,'explicit public activity schema');const yaml=readFileSync(new URL('../../contracts/openapi.yaml',import.meta.url),'utf8');const line=yaml.split('\n').find(x=>x.trimStart().startsWith('Activity_compaction: '));assert.ok(line);assert.deepEqual(JSON.parse(line.slice(line.indexOf(':')+1)),schema);assert.deepEqual(event.$defs.Activity_compaction,schema);
 const ajv=new Ajv({strict:false});addFormats(ajv);const validate=ajv.compile(schema),c=ctx(),p=projectSessionFrame(frame('compaction/start'),c).payload;assert.equal(validate(p),true);
 for(const value of [{...p,tool_call_id:'invented'},{...p,detail:{...p.detail,summary:'PRIVATE'}},{...p,detail:{...p.detail,model:'PRIVATE'}}])assert.equal(validate(value),false);
});

test('the original Runner gates native compaction by its opt-in and accepted Work policy',async()=>{
 const {OfficialSessionRunner}=await import('../../src/harness/official-session-runner.ts');
 for(const mode of ['work','chat','legacy','disabled']){
  const projections=[];const client={create:async()=>({}),prompt:async()=>({}),async *follow(){yield {type:'snapshot',cursor:0,records:[]};yield {...frame('compaction/start'),event:{...frame('compaction/start').event,seq:1}};yield {...frame('compaction/end'),event:{...frame('compaction/end').event,seq:2}};yield {type:'event',event:{type:'assistant/message',seq:3,data:{message:{content:[{type:'text',text:'Native answer'}]}}}};yield {type:'event',event:{type:'turn/end',seq:4,data:{reason:{kind:'completed'}}}};}};
  const policy=mode==='chat'?{protocol:1,mode:'chat',thinking:'disabled',model:{provider:'fixture',model:'fast'},preset_id:'jot-chat',preset_revision:'fixture',context_revision:'fixture',conversation_version:1,model_policy_sha256:'a'.repeat(64)}:{protocol:1,mode:'work',thinking:'provider',preset_id:'jot-general',preset_revision:'fixture',context_revision:'work-native-v1',conversation_version:1,model_policy_sha256:'a'.repeat(64)};
  const runner=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general',chatAgentPreset:'jot-chat',visibleWorkCompaction:mode!=='disabled'});
  const result=await runner.run({enabled:true,taskRequestId:'run-native',sessionRef:'session-native',message:'Synthetic question',deferCompletionProbe:true,...(mode==='legacy'?{}:{conversationPolicy:policy}),...(mode==='chat'?{originalAdmission:{executionLease:{owner:'worker',generation:1}}}:{}),onProjection:p=>projections.push(p)});
  assert.equal(result.final_text,'Native answer');const activities=projections.filter(p=>p.payload.kind==='compaction');assert.equal(activities.length,mode==='work'?2:0,mode);
 }
});

test('original Worker persists compaction metadata and snapshot replay retains the same activity without another answer',async t=>{
 const {openProductDatabase}=await import('../../src/db/database.ts'),{ConversationRepository}=await import('../../src/conversations/repository.ts'),{RunRepository}=await import('../../src/runs/repository.ts'),{EventStore}=await import('../../src/events/event-store.ts'),{HarnessCoordinator}=await import('../../src/harness/coordinator.ts'),{HarnessWorker}=await import('../../src/harness/worker.ts'),{OfficialSessionRunner}=await import('../../src/harness/official-session-runner.ts'),{buildSnapshot}=await import('../../src/events/snapshot.ts');
 const db=openProductDatabase(':memory:');t.after(()=>db.close());const events=new EventStore(db),conversations=new ConversationRepository(db),runs=new RunRepository(db,events),coordinator=new HarnessCoordinator(db,runs,events);
 const c=conversations.create('owner',{workspace_id:'workspace',title:'Synthetic Work compaction',mode:'work',model:{provider:'fixture',model:'work',reasoning_effort:'high'}}),r=runs.enqueue(c.conversation_id,'owner',{client_message_id:'question',content:[{type:'text',text:'Synthetic question'}]});
 const client={create:async()=>({}),prompt:async()=>({}),async *follow(){yield {type:'snapshot',cursor:0,records:[]};yield {type:'event',event:{type:'compaction/start',seq:1,data:{compactionId:'real-native',turn:null}}};yield {type:'event',event:{type:'compaction/end',seq:2,data:{compactionId:'real-native',turn:null}}};yield {type:'event',event:{type:'assistant/message',seq:3,data:{message:{content:[{type:'text',text:'One native answer'}]}}}};yield {type:'event',event:{type:'turn/end',seq:4,data:{reason:{kind:'completed'}}}};}};
 const runner=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general',visibleWorkCompaction:true}),worker=new HarnessWorker(db,coordinator,runner,{workerId:'worker',leaseMs:10000,sessionResolver:()=> 'session-native'});
 await worker.processNext();const snapshot=buildSnapshot(db,c.conversation_id,'owner');assert.equal(snapshot.activities.length,1);assert.equal(snapshot.activities[0].kind,'compaction');assert.equal(snapshot.activities[0].status,'succeeded');assert.equal(snapshot.messages.filter(m=>m.role==='assistant'&&m.run_id===r.run_id).length,1);
 const {fromSnapshot,reduceEvent}=await import('../../../../web/jot/projection.ts');const restored=fromSnapshot(snapshot);assert.equal(Object.values(restored.activities).length,1);assert.equal(reduceEvent(restored,events.replay(c.conversation_id,0,100).find(e=>e.type==='activity.upsert')),restored);
 const ajv=new Ajv({strict:false});addFormats(ajv);const validate=ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/agent-event.schema.json',import.meta.url),'utf8')));for(const event of events.replay(c.conversation_id,0,100).filter(e=>e.type==='activity.upsert'))assert.equal(validate(event),true,JSON.stringify(validate.errors));
});
