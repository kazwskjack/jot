import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeClaimedInputRecoverySetup} from '../native-claimed-input.js';

const message=id=>({id,role:'user',source:{kind:'user'},content:[{type:'text',text:'Original '+id}]});
function fixture({step=false,cancelled=false,later=false,goal=false,partial=false,reason='interrupted',persistedMarker=false}={}){
 const one=message('one'),two=message('two'),queued=message('queued');if(goal)two.source={kind:'goal',goalId:'original-goal',revision:1,round:1};
 const history=[['agent/inbox/spliced',{target:'next-step',start:0,inserted:[one]}],['agent/inbox/spliced',{target:'next-turn',start:0,inserted:[two,queued]}],['turn/start',{turn:1}],['agent/inbox/spliced',{target:'next-step',start:0,removedCount:1,inserted:[],...(cancelled?{outcome:'canceled'}:{})}],['agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]}],...(step?[['step/start',{turn:1,step:1}],['user/message',one],['step/end',{turn:1,step:1}]]:[]),['turn/end',{turn:1,reason:{kind:'interrupted'}}],['session/end-seed',{}],...(later?[['turn/start',{turn:2}],['step/start',{turn:2,step:1}],['step/end',{turn:2,step:1}],['turn/end',{turn:2,reason:{kind:'completed'}}]]:[])];
 const events=history.filter(([type,data])=>type!=='session/end-seed'&&!(partial&&type==='agent/inbox/spliced'&&data.target==='next-turn'&&data.removedCount)).map(([type,data],seq)=>({seq,type,data:type==='turn/end'&&data.turn===1?{...data,reason:{kind:reason}}:data,surfaceOp:'append'}));let storedCount=events.length;events.push({seq:events.length,type:'session/end-seed',data:{},surfaceOp:'append'});if(persistedMarker)storedCount=events.length;let calls=0,validations=0,safe=0;
 const project=view=>{const state={'next-step':[],'next-turn':[]};for(const event of view.snapshotEvents()){if(event.type==='agent/inbox/spliced'){const d=event.data;state[d.target].splice(d.start,d.removedCount??0,...d.inserted);}}return state;};
 const session={id:'original',header:{id:'original',isSeeded:false},inheritedEventCount:0,get firstLiveSeq(){return storedCount;},get seq(){return events.length;},eventAt:index=>events[index],snapshotEvents:(start=0,end=events.length)=>events.slice(start,end)};
 const agent={id:'original',status:'idle',session,inbox:{get nextStep(){return project(session)['next-step'];},get nextTurn(){return project(session)['next-turn'];},splice:(target,start,removedCount,inserted)=>events.push({seq:events.length,type:'agent/inbox/spliced',data:{target,start,removedCount,inserted},surfaceOp:'append'}),prepend:(target,item)=>events.push({seq:events.length,type:'agent/inbox/spliced',data:{target,start:0,inserted:[item]},surfaceOp:'append'})}};
 class Detached{static create(id,seed,header){const log=[...seed];if(log.at(-1)?.type!=='session/end-seed')log.push({seq:log.length,type:'session/end-seed',data:{}});return Object.assign(new Detached(),{id,header,firstLiveSeq:seed.length,seq:log.length,snapshotEvents:()=>log});}}
 const options={Session:Detached,agents:{get:()=>undefined},sessions:{get:()=>undefined},query:{readSession:async()=>({session:session.header,inheritedEventCount:0,events:events.slice(0,storedCount+1)})},projections:{snapshot:view=>{assert.ok(view instanceof Detached);return {asOfSeq:view.seq-1,values:{inbox:project(view)}};}},validateLog:async()=>{validations++;return {validated:true};},authorize:async({agent:subject})=>{assert.equal(subject,agent);calls++;return {authorized:true};},confirmReplaySafety:async()=>{safe++;return {safe:true};}};
 return {one,two,queued,events,agent,options,remount:()=>{storedCount=events.length;events.push({seq:events.length,type:'session/end-seed',data:{},surfaceOp:'append'});},counts:()=>({calls,validations,safe})};
}

test('setup restores the original native targets and order without sending, waking or changing Goal messages',async()=>{
 const f=fixture({goal:true}),setup=createNativeClaimedInputRecoverySetup(f.options);await setup({},f.agent);
 assert.deepEqual(f.agent.inbox.nextStep.map(item=>item.id),['one']);assert.deepEqual(f.agent.inbox.nextTurn.map(item=>item.id),['queued']);assert.equal(f.events.filter(event=>event.type==='user/message').length,0);
 assert.deepEqual(f.agent.inbox.nextStep[0],f.one);assert.deepEqual(setup.resultFor(f.agent),{state:'restored',restored:1,already_pending:0,goal_owned:1,execution_authorized:false});assert.ok(f.counts().calls>=2);
});

test('a second setup and a partially persisted restore retain exactly the same messages once',async()=>{
 const f=fixture(),setup=createNativeClaimedInputRecoverySetup(f.options);f.agent.inbox.prepend('next-turn',f.two);f.remount();await setup({},f.agent);assert.deepEqual(f.agent.inbox.nextStep.map(item=>item.id),['one']);assert.deepEqual(f.agent.inbox.nextTurn.map(item=>item.id),['two','queued']);
 f.remount();const seq=f.agent.session.seq;await setup({},f.agent);assert.equal(f.agent.session.seq,seq);assert.equal(setup.resultFor(f.agent).restored,0);assert.equal(setup.resultFor(f.agent).already_pending,2);
});

test('started steps, cancelled removals and later work do not become an automatic replay',async()=>{
 for(const input of [{step:true},{cancelled:true},{later:true}]){const f=fixture(input),setup=createNativeClaimedInputRecoverySetup(f.options),seq=f.agent.session.seq;await assert.rejects(setup({},f.agent),/claim_recovery_(started|cancelled|later_work)/);assert.equal(f.agent.session.seq,seq);}
});

test('revoked authority, unknown hook safety and changed history fail before restoration',async()=>{
 for(const kind of ['permission','safety','history','validator','conflict']){const f=fixture(),seq=f.agent.session.seq;
  if(kind==='permission')f.options.authorize=async()=>({authorized:false});
  if(kind==='safety')f.options.confirmReplaySafety=async()=>({safe:false});
  if(kind==='validator')f.options.validateLog=async()=>({validated:false});
  if(kind==='conflict'){f.agent.inbox.prepend('next-step',{...f.one,content:[{type:'text',text:'Different original data'}]});f.remount();}
  if(kind==='history')f.options.confirmReplaySafety=async()=>{f.events.push({seq:f.events.length,type:'tool/call',data:{}});return {safe:true};};
  const before=f.agent.session.seq;await assert.rejects(createNativeClaimedInputRecoverySetup(f.options)({},f.agent));assert.equal(f.agent.session.seq,before+(kind==='history'?1:0));assert.ok(seq<=before);
 }
});

test('missing trusted policy and replacement identity are never accepted as a recovery setup',async()=>{
 const f=fixture();assert.throws(()=>createNativeClaimedInputRecoverySetup({...f.options,confirmReplaySafety:undefined}));const setup=createNativeClaimedInputRecoverySetup(f.options);f.agent.id='other';await assert.rejects(setup({},f.agent));
});

test('an explicit removal after an earlier partial restore cannot resurrect the cancelled input',async()=>{
 const f=fixture(),setup=createNativeClaimedInputRecoverySetup(f.options);f.agent.inbox.prepend('next-step',f.one);f.events.push({seq:f.events.length,type:'agent/inbox/spliced',data:{target:'next-step',start:0,removedCount:1,inserted:[],outcome:'canceled'},surfaceOp:'append'});f.remount();const seq=f.agent.session.seq;await assert.rejects(setup({},f.agent),/claim_recovery_cancelled/);assert.equal(f.agent.session.seq,seq);
});

test('recovery refuses publication races and restores missing positions inside a partially restored batch',async()=>{
 const f=fixture(),third=message('third');f.events[0].data.inserted.push(third);f.events[3].data.removedCount=2;f.agent.inbox.prepend('next-step',f.one);f.remount();const setup=createNativeClaimedInputRecoverySetup(f.options);await setup({},f.agent);assert.deepEqual(f.agent.inbox.nextStep.map(item=>item.id),['one','third']);
 const g=fixture();g.options.confirmReplaySafety=async()=>{g.options.agents.get=()=>g.agent;return {safe:true};};const seq=g.agent.session.seq;await assert.rejects(createNativeClaimedInputRecoverySetup(g.options)({},g.agent),/identity_changed/);assert.equal(g.agent.session.seq,seq);
});

test('validators cannot change recovered message content and the second query detects a same-length storage rewrite',async()=>{
 for(const mutation of ['view','storage']){const f=fixture(),seq=f.agent.session.seq;
  if(mutation==='view')f.options.validateLog=async view=>{view.snapshotEvents()[0].data.inserted[0].content[0].text='Altered';return {validated:true};};
  else f.options.confirmReplaySafety=async()=>{f.events[0].data.inserted[0].content[0].text='Rewritten source';return {safe:true};};
  await assert.rejects(createNativeClaimedInputRecoverySetup(f.options)({},f.agent));assert.equal(f.agent.session.seq,seq);
 }
});

test('a prefix ending between the two native claim deletions preserves the unclaimed turn queue',async()=>{
 const f=fixture({partial:true}),setup=createNativeClaimedInputRecoverySetup(f.options);await setup({},f.agent);assert.deepEqual(f.agent.inbox.nextStep.map(item=>item.id),['one']);assert.deepEqual(f.agent.inbox.nextTurn.map(item=>item.id),['two','queued']);assert.equal(setup.resultFor(f.agent).restored,1);
});

test('normal completion and user-aborted turns are not reinterpreted as crashes',async()=>{
 for(const reason of ['completed','aborted']){const f=fixture({reason}),seq=f.agent.session.seq,setup=createNativeClaimedInputRecoverySetup(f.options);await setup({},f.agent);assert.equal(f.agent.session.seq,seq);assert.equal(setup.resultFor(f.agent).state,'none');assert.equal(f.counts().safe,0);}
});

test('approval, scheduling and internal sources cannot masquerade as a human replay',async()=>{
 for(const kind of ['user-approval','user-question-reply','schedule','agent-message','subagent-settled','skill-invocation','model-selection','tool-registry']){const f=fixture(),seq=f.agent.session.seq;f.one.source={kind};await assert.rejects(createNativeClaimedInputRecoverySetup(f.options)({},f.agent),/claim_recovery_source_unsupported/);assert.equal(f.agent.session.seq,seq);assert.equal(f.counts().safe,0);}
});

test('the actual Controller RPC source retains kind user and its original correlation ID',async()=>{
 const f=fixture();f.one.source={kind:'user',rpcId:'original-request',clientTimeZone:'UTC'};await createNativeClaimedInputRecoverySetup(f.options)({},f.agent);assert.deepEqual(f.agent.inbox.nextStep[0].source,f.one.source);
});

 test('an existing durable neutral end-seed marker survives a rejected setup retry',async()=>{const f=fixture({persistedMarker:true});await createNativeClaimedInputRecoverySetup(f.options)({},f.agent);assert.deepEqual(f.agent.inbox.nextStep.map(item=>item.id),['one']);assert.deepEqual(f.agent.inbox.nextTurn.map(item=>item.id),['two','queued']);});
