import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OfficialSessionRunner } from '../../src/harness/official-session-runner.ts'
import {taskGoalStopReason} from '../../src/harness/task-goal-status.ts';

function goalFacts(goal={},task={}) {
 return {state:{protocol:1,host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:1,phase:'active',activation:'armed',rounds_started:0,max_goal_rounds:3,...goal},
  task:{run_status:'running',business_state:'queued',steps:{total:0,completed:0,evidence_verified:0,all_completed:false,all_execution_evidence_verified:false},
   budget:{configured:true,balances:[{scope_id:'scope-fixture',limits:{tokens:'1000',nano_usd:'1000',model_calls:'10'},used:{tokens:'1',nano_usd:'1',model_calls:'1'},held:{tokens:'0',nano_usd:'0',model_calls:'0'}}],pending_unknown:0,pending_in_flight:0},...task}}};
}

test('input and review requests alone cannot claim native quiescence or suppress unresolved usage',()=>{
 for(const business_state of ['input_requested','approval_requested']){
  assert.equal(taskGoalStopReason(goalFacts({}, {business_state}).state,true),undefined);
  assert.equal(taskGoalStopReason(goalFacts({phase:'paused',activation:'disarmed'}, {business_state,budget:{...goalFacts().state.task.budget,pending_unknown:1}}).state,true),'SESSION_GOAL_USAGE_UNKNOWN');
 }
});

test('a new active native round already streaming is not interrupted by its own held or in-flight usage',()=>{
 const budget={...goalFacts().state.task.budget,pending_in_flight:1,balances:[{...goalFacts().state.task.budget.balances[0],held:{tokens:'999',nano_usd:'999',model_calls:'9'}}]};
 const state=goalFacts({rounds_started:1},{budget}).state;state.host_status='running';
 assert.equal(taskGoalStopReason(state,true),undefined);
 state.host_status='idle';assert.equal(taskGoalStopReason(state,true),'SESSION_GOAL_USAGE_PENDING');
 state.host_status='running';state.task.budget.pending_unknown=1;
 assert.equal(taskGoalStopReason(state,true),'SESSION_GOAL_USAGE_UNKNOWN');
});

test('native Goal turns share one follow stream and do not start a competing crawl continuation',async()=>{
 let prompts=0,follows=0,observations=0,saved;
 const client={create:async()=>({}),prompt:async()=>{prompts++;return {};},goalStatus:async()=>{
  observations++;return observations===1?goalFacts():goalFacts({goal_revision:2,phase:'paused',activation:'disarmed',rounds_started:1});
 },goalStop:async()=>({...goalFacts({goal_revision:2,phase:'paused',activation:'disarmed',rounds_started:1}),turn_end_seq:5}),checkpoint:async(_session,seq)=>({checkpoint:{session_ref:'session-fixture',seq_exclusive:seq+1,turn_end_seq:seq,goal_id:'goal-fixture',goal_revision:2,log_sha256:'a'.repeat(64)}}),
 async *follow(){follows++;yield {type:'snapshot',cursor:0,records:[]};
  yield {type:'event',event:{type:'tool/result',seq:1,data:{batch_id:'batch-fixture-12345678',status:'pending',terminal:false}}};
  yield {type:'event',event:{type:'assistant/message',seq:2,data:{message:{content:[{type:'text',text:'Intermediate round'}]}}}};
  yield {type:'event',event:{type:'turn/end',seq:3,data:{reason:{kind:'completed'}}}};
  yield {type:'event',event:{type:'assistant/message',seq:4,data:{message:{content:[{type:'text',text:'Waiting for review'}]}}}};
  yield {type:'event',event:{type:'turn/end',seq:5,data:{reason:{kind:'completed'}}}};
 }};
 const result=await new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'}).run({enabled:true,taskRequestId:'run-fixture',message:'Task',sessionRef:'session-fixture',workbenchRunId:'run-fixture',checkpointTask:true,deferCompletionProbe:true,onCheckpoint:value=>{saved=value;}});
 assert.equal(prompts,1);assert.equal(follows,1);assert.equal(observations,2);assert.equal(saved.turn_end_seq,5);
 assert.equal(result.completed,false);assert.equal(result.reason_code,'SESSION_GOAL_PAUSED');assert.equal(result.final_text,undefined);
 assert.equal(result.task_candidate?.text,'Waiting for review');
});

for(const scenario of ['complete','waiting_user','waiting_approval','unknown','exhausted','ended','budget_unconfigured','usage_pending','budget_exhausted','blocked','disarmed','input_requested','approval_requested'])test(`native Goal ${scenario} cannot publish an intermediate answer as task completion`,async()=>{
 let reachedTail=false,prompts=0;const projections=[];
 const state=scenario.endsWith('_requested')?goalFacts({phase:'paused',activation:'disarmed'},{business_state:scenario})
  :scenario==='complete'?goalFacts({phase:'complete',activation:'disarmed'}):scenario.startsWith('waiting_')?goalFacts({}, {run_status:scenario})
  :scenario==='unknown'?goalFacts({}, {budget:{...goalFacts().state.task.budget,pending_unknown:1}})
  :scenario==='exhausted'?goalFacts({rounds_started:3})
  :scenario==='budget_unconfigured'?goalFacts({}, {budget:{configured:false,balances:[],pending_unknown:null,pending_in_flight:null}})
  :scenario==='usage_pending'?goalFacts({}, {budget:{...goalFacts().state.task.budget,pending_in_flight:1}})
  :scenario==='budget_exhausted'?goalFacts({}, {budget:{...goalFacts().state.task.budget,balances:[{...goalFacts().state.task.budget.balances[0],used:{tokens:'900',nano_usd:'1',model_calls:'1'},held:{tokens:'100',nano_usd:'0',model_calls:'0'}}]}})
  :scenario==='blocked'?goalFacts({phase:'blocked',activation:'disarmed'})
  :scenario==='disarmed'?goalFacts({activation:'disarmed',rounds_started:1}):goalFacts();
 const codes={input_requested:'SESSION_GOAL_WAITING_USER',approval_requested:'SESSION_GOAL_WAITING_APPROVAL',complete:'SESSION_GOAL_REVIEW_REQUIRED',waiting_user:'SESSION_GOAL_WAITING_USER',waiting_approval:'SESSION_GOAL_WAITING_APPROVAL',unknown:'SESSION_GOAL_USAGE_UNKNOWN',exhausted:'SESSION_GOAL_ROUND_LIMIT',ended:'SESSION_GOAL_STREAM_ENDED',budget_unconfigured:'SESSION_GOAL_BUDGET_UNCONFIGURED',usage_pending:'SESSION_GOAL_USAGE_PENDING',budget_exhausted:'SESSION_GOAL_BUDGET_EXHAUSTED',blocked:'SESSION_GOAL_BLOCKED',disarmed:'SESSION_GOAL_DISARMED'};
 const client={create:async()=>({}),prompt:async()=>{prompts++;return {};},goalStatus:async()=>state,goalStop:async()=>({state:{...state.state,goal:{...state.state.goal,phase:state.state.goal.phase==='active'?'paused':state.state.goal.phase,activation:'disarmed',goal_revision:2}},turn_end_seq:2}),
  checkpoint:async(_id,seq)=>({checkpoint:{session_ref:'session-fixture',seq_exclusive:seq+1,turn_end_seq:seq,goal_id:'goal-fixture',goal_revision:2,log_sha256:'a'.repeat(64)}}),
  async *follow(){yield {type:'snapshot',cursor:0,records:[]};yield {type:'event',event:{type:'assistant/message',seq:1,data:{message:{content:[{type:'text',text:'Intermediate result'}]}}}};yield {type:'event',event:{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}}};reachedTail=true;}};
 const result=await new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'}).run({enabled:true,taskRequestId:'run-fixture',message:'Task',sessionRef:'session-fixture',checkpointTask:true,deferCompletionProbe:true,onCheckpoint:()=>{},onProjection:value=>{projections.push(value);}});
 assert.equal(prompts,1);assert.equal(result.completed,false);assert.equal(result.final_text,undefined);assert.equal(result.reason_code,codes[scenario]);assert.equal(reachedTail,scenario==='ended');
 const message=projections.find(value=>value.type==='assistant.settled').payload.message;
 assert.equal(message.status,'streaming');assert.equal(message.blocks[0].text,'Intermediate result');
});

test('native Goal observation rejects malformed host facts and changed identity before publishing or checkpointing',async()=>{
 for(const invalid of ['protocol','scope_amount','step_count','identity','revision','rounds','host_status','goal_phase','goal_activation','run_status','completion_claim']){
  let count=0,checkpoints=0;
  const client={create:async()=>({}),prompt:async()=>({}),goalStatus:async()=>{
   const value=goalFacts({goal_revision:2,rounds_started:1});count++;
   if(invalid==='protocol')value.state.protocol='1';
   if(invalid==='scope_amount')value.state.task.budget.balances[0].used.tokens='-1';
   if(invalid==='step_count')value.state.task.steps.all_completed=true;
   if(invalid==='host_status')value.state.host_status=['idle'];
   if(invalid==='goal_phase')value.state.goal.phase=['active'];
   if(invalid==='goal_activation')value.state.goal.activation=['armed'];
   if(invalid==='run_status')value.state.task.run_status=['running'];
   if(invalid==='completion_claim')value.state.task.completion_verified=true;
   if(count===2&&invalid==='identity')value.state.goal.goal_id='foreign-goal';
   if(count===2&&invalid==='revision')value.state.goal.goal_revision=1;
   if(count===2&&invalid==='rounds')value.state.goal.rounds_started=0;
   return value;
  },checkpoint:async()=>{checkpoints++;throw new Error('should_not_checkpoint');},async *follow(){yield {type:'snapshot',cursor:0,records:[]};for(const seq of [1,2])yield {type:'event',event:{type:'turn/end',seq,data:{reason:{kind:'completed'}}}};}};
  await assert.rejects(new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'}).run({enabled:true,taskRequestId:'run-fixture',message:'Task',sessionRef:'session-fixture',checkpointTask:true,deferCompletionProbe:true,onCheckpoint:()=>{}}),/goal_status_invalid/,invalid);
  assert.equal(checkpoints,0);
 }
});

test('native stop confirmation uses the latest cancelled turn boundary before capturing its checkpoint',async()=>{
 const order=[],state=goalFacts({phase:'paused',activation:'disarmed'});
 const client={create:async()=>({}),prompt:async()=>({}),goalStatus:async()=>state,goalStop:async(_session,ref)=>{order.push('stop');assert.deepEqual(ref,{goal_id:'goal-fixture',goal_revision:1});return {...goalFacts({goal_revision:2,phase:'paused',activation:'disarmed'}),turn_end_seq:4};},
  checkpoint:async(_session,seq)=>{order.push('checkpoint');assert.equal(seq,4);return {checkpoint:{session_ref:'session-fixture',seq_exclusive:6,turn_end_seq:4,goal_id:'goal-fixture',goal_revision:2,log_sha256:'a'.repeat(64)}};},
  async *follow(){yield {type:'snapshot',cursor:0,records:[]};yield {type:'event',event:{seq:2,type:'turn/end',data:{reason:{kind:'completed'}}}};}};
 const result=await new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'}).run({enabled:true,taskRequestId:'run-fixture',message:'Task',sessionRef:'session-fixture',checkpointTask:true,deferCompletionProbe:true,onCheckpoint:()=>{order.push('saved');}});
 assert.deepEqual(order,['stop','checkpoint','saved']);assert.equal(result.completed,false);assert.deepEqual(result.task_stop,{goal_id:'goal-fixture',goal_revision:2,phase:'paused',turn_end_seq:4});
});

test('an armed stopped task without a confirmed private stop channel cannot claim a safe checkpoint',async()=>{
 let checkpoints=0;
 const client={create:async()=>({}),prompt:async()=>({}),goalStatus:async()=>goalFacts({}, {run_status:'waiting_user'}),checkpoint:async()=>{checkpoints++;return {};},async *follow(){yield {type:'snapshot',cursor:0,records:[]};yield {type:'event',event:{seq:2,type:'turn/end',data:{reason:{kind:'completed'}}}};}};
 await assert.rejects(new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'}).run({enabled:true,taskRequestId:'run-fixture',message:'Task',sessionRef:'session-fixture',checkpointTask:true,deferCompletionProbe:true,onCheckpoint:()=>{}}),/goal_stop_channel_unavailable/);assert.equal(checkpoints,0);
});

test('runner has no whole-task deadline when timeout is omitted', async () => {
  const client = {
    create: async () => ({ sessionId: 's' }),
    prompt: async () => ({ accepted: true }),
    async *follow(_sessionId, signal) {
      yield { type: 'snapshot', cursor: 0, records: [] }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 25)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(signal.reason ?? new Error('aborted'))
        }, { once: true })
      })
      yield { type: 'event', event: { type: 'assistant/message', seq: 1,
        data: { message: { content: [{ type: 'text', text: '完成' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', agentPreset: 'jot-general',
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-no-deadline', message: '长任务',
    sessionRef: 'jot-session-no-deadline', deferCompletionProbe: true })
  assert.equal(result.completed, true)
  assert.equal(result.final_text, '完成')
})

test('a background interrupted turn captures a host-verified checkpoint before returning its outcome',async()=>{
 const proof={session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:3,goal_id:'goal-fixture',goal_revision:3,log_sha256:'a'.repeat(64)};
 const calls=[];let saved;
 const client={create:async()=>({}),prompt:async()=>({}),checkpoint:async(session,seq)=>{calls.push([session,seq]);return {checkpoint:proof};},
  async *follow(){yield {type:'snapshot',cursor:0,records:[]};yield {type:'event',event:{type:'turn/end',seq:3,data:{reason:{kind:'interrupted'}}}};}};
 const runner=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'});
 const result=await runner.run({enabled:true,taskRequestId:'run-fixture',message:'Controlled task',sessionRef:'session-fixture',workbenchRunId:'run-fixture',checkpointTask:true,deferCompletionProbe:true,onCheckpoint:async value=>{saved=value;}});
 assert.deepEqual(saved,proof);assert.deepEqual(calls,[['session-fixture',3]]);assert.equal(result.completed,false);assert.equal(result.reason_code,'SESSION_TURN_INTERRUPTED');
});

test('background runs cannot silently claim recoverable state without the real checkpoint channel',async()=>{
 const client={create:async()=>({}),prompt:async()=>({}),async *follow(){yield {type:'snapshot',cursor:0,records:[]};yield {type:'event',event:{type:'turn/end',seq:3,data:{reason:{kind:'completed'}}}};}};
 const runner=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'});
 await assert.rejects(runner.run({enabled:true,taskRequestId:'run-fixture',message:'Task',sessionRef:'session-fixture',checkpointTask:true,deferCompletionProbe:true,onCheckpoint:async()=>{throw new Error('should_not_be_called');}}),/checkpoint_channel_unavailable/);
});

test('runner follows first, prompts once, ignores history and settles on turn end', async () => {
  const calls = []
  const client = {
    create: async (...args) => { calls.push(['create', ...args]); return { sessionId: args[0] } },
    prompt: async (...args) => { calls.push(['prompt', ...args]); return { accepted: true } },
    async *follow(sessionId) {
      calls.push(['follow', sessionId])
      yield { type: 'snapshot', cursor: 8, records: [{ type: 'event', event: { type: 'assistant/message', seq: 7,
        data: { message: { content: [{ type: 'text', text: '旧回答' }] } } } }] }
      yield { type: 'event', event: { type: 'tool/call', seq: 9, data: { callId: 'c1', name: 'universe_search' } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 10,
        data: { message: { content: [{ type: 'text', text: '新回答' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 11, data: { reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general',
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-1', message: '搜索', sessionRef: 'jot-session-1', deferCompletionProbe: true })
  assert.equal(result.final_text, '新回答')
  assert.equal(result.tool_marker, true)
  assert.deepEqual(calls.map(call => call[0]), ['create', 'follow', 'prompt'])
  assert.equal(calls[0][3], 'jot-general')
})

test('runner polls durable C batch revisions without emitting duplicate Jot projections', async () => {
  const polls = []; const snapshots = []; const projections = []
  const running = { ok: true, operation_id: `web-${'e'.repeat(32)}`, kind: 'read_page', status: 'running',
    revision: 2, event_cursor: 2, accepted_count: 2, counts: { succeeded: 1, running: 1 },
    events: [{ revision: 2, event_type: 'item.updated', payload: {} }], items: [
      { item_id: 'a', position: 0, inputs: { url: 'https://example.com/a' }, status: 'succeeded', attempt: 1, result_ref: 'c'.repeat(32) },
      { item_id: 'b', position: 1, inputs: { url: 'https://www.iana.org/domains/reserved' }, status: 'running', attempt: 1 },
    ] }
  const partial = { ...running, status: 'partial', revision: 3, event_cursor: 3,
    counts: { succeeded: 1, failed: 1 }, events: [{ revision: 3, event_type: 'item.updated', payload: {} }],
    items: [running.items[0], { ...running.items[1], status: 'failed', reason_code: 'PAGE_TIMEOUT' }] }
  const client = {
    create: async () => ({ sessionId: 's' }),
    prompt: async () => ({ accepted: true }),
    nativeTool: async (...args) => { polls.push(args); return polls.length === 1 ? running : partial },
    async *follow() {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield { type: 'event', event: { type: 'tool/call', seq: 1, data: {
        callId: 'dsh-call-batch', name: 'universe_read_page',
        arguments: { urls: ['https://example.com/a', 'https://www.iana.org/domains/reserved'] },
      } } }
      await new Promise(resolve => setTimeout(resolve, 20))
      yield { type: 'event', event: { type: 'tool/result', seq: 2, data: { callId: 'dsh-call-batch',
        message: { source: { kind: 'tool', callId: 'dsh-call-batch' }, content: [
          { type: 'tool-result', toolCallId: 'dsh-call-batch', isError: false },
        ] } } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 3,
        data: { message: { content: [{ type: 'text', text: '已读取两页。' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', timeoutMs: 2000, agentPreset: 'jot-general', webOperationPollIntervalMs: 100,
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-batch-progress', message: '读取两页',
    sessionRef: 'controller-session', universeSessionRef: 'controller-session', deferCompletionProbe: true,
    onWebOperationCursor: callId => { assert.equal(callId, 'dsh-call-batch'); return 0 },
    onWebOperationSnapshot: (callId, snapshot) => {
      assert.equal(callId, 'dsh-call-batch'); snapshots.push(snapshot); return snapshot.event_cursor
    },
    onProjection: projection => projections.push(projection),
  })
  assert.equal(result.final_text, '已读取两页。')
  assert.equal(snapshots.length, 2)
  assert.equal(polls[0][0], 'universe_get_state')
  assert.equal(polls[0][1].request_id, 'dsh-call-batch')
  assert.equal(polls[1][1].after_revision, 2)
  assert.equal(polls[0][2].session_ref, 'controller-session')
  const activityEvents = projections.filter(value => value.type === 'activity.upsert')
  assert.equal(snapshots[0].items[1].status, 'running')
  assert.equal(snapshots[1].items[1].reason_code, 'PAGE_TIMEOUT')
  assert.equal(activityEvents.filter(value => value.payload.detail?.operation_id === 'web-operation-12345678').length, 0)
})

test('runner serially resumes a completed turn while a crawl batch is still non-terminal', async () => {
  const calls = []
  let followCount = 0
  const client = {
    create: async () => ({ sessionId: 's' }),
    prompt: async (...args) => { calls.push(['prompt', ...args]); return { accepted: true } },
    async *follow() {
      followCount += 1
      calls.push(['follow', followCount])
      if (followCount === 1) {
        yield { type: 'snapshot', cursor: 0, records: [] }
        yield { type: 'event', event: { type: 'tool/result', seq: 1, data: { message: { content: [
          { type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({
            batch_id: 'batch-12345678', status: 'running', terminal: false, next_action: 'poll_status',
          }) }],
        }] } } } }
        yield { type: 'event', event: { type: 'assistant/message', seq: 2,
          data: { message: { content: [{ type: 'text', text: '已提交采集。' }] } } } }
        yield { type: 'event', event: { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } } }
        return
      }
      yield { type: 'snapshot', cursor: 3, records: [] }
      yield { type: 'event', event: { type: 'tool/result', seq: 4, data: { message: { content: [
        { type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({
          batch_id: 'batch-12345678', status: 'succeeded', terminal: true,
        }) }],
      }] } } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 5,
        data: { message: { content: [{ type: 'text', text: '采集完成。' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general',
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-crawl-resume', message: '采集',
    sessionRef: 'jot-session-crawl-resume', deferCompletionProbe: true })
  assert.equal(result.completed, true)
  assert.equal(result.final_text, '采集完成。')
  assert.equal(calls.filter(call => call[0] === 'follow').length, 2)
  assert.equal(calls.filter(call => call[0] === 'prompt').length, 2)
  const prompts = calls.filter(call => call[0] === 'prompt')
  assert.match(String(prompts[1][3]), /batch-12345678/)
})

test('runner records model, J sync, and final report timings through the private native bridge', async () => {
  const timingCalls = []
  const client = {
    create: async () => ({ sessionId: 's' }),
    prompt: async () => ({ accepted: true }),
    nativeTool: async (...args) => { timingCalls.push(args); return { ok: true, timing_id: timingCalls.length } },
    async *follow() {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield { type: 'event', event: { type: 'tool/call', seq: 1,
        data: { callId: 'crawl-call', name: 'universe_crawl', arguments: { operation: 'start' } } } }
      yield { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { content: [
        { type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({
          batch_id: 'batch-timing01', status: 'running', terminal: false, next_action: 'poll_status',
        }) }],
        }],
      } } } }
      yield { type: 'event', event: { type: 'tool/result', seq: 3, data: { message: { content: [
        { type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({
          batch_id: 'batch-timing01', status: 'succeeded', terminal: true,
        }) }],
        }],
      } } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 4,
        data: { message: { content: [{ type: 'text', text: '采集完成。' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 5, data: { reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general',
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-timing', message: '采集',
    sessionRef: 'jot-session-timing', deferCompletionProbe: true })
  assert.equal(result.completed, true)
  assert.deepEqual(timingCalls.map(call => call[1].phase), ['model.decision', 'j.sync', 'final.report'])
  for (const call of timingCalls) {
    assert.equal(call[0], 'universe_crawl')
    assert.equal(call[1].batch_id, 'batch-timing01')
    assert.equal(call[2].session_ref, 'jot-session-timing')
  }
})

test('runner recognizes terminal crawl results wrapped as an escaped Session JSON string', async () => {
  const timingCalls = []
  const terminal = JSON.stringify({ batch_id: 'batch-escaped01', status: 'succeeded', terminal: true })
  const client = {
    create: async () => ({ sessionId: 's' }),
    prompt: async () => ({ accepted: true }),
    nativeTool: async (...args) => { timingCalls.push(args); return { ok: true, timing_id: timingCalls.length } },
    async *follow() {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield { type: 'event', event: { type: 'tool/call', seq: 1,
        data: { name: 'universe_crawl', arguments: { operation: 'start' } } } }
      // This double encoding matches adapters that serialize the provider
      // JSON once more inside the official Session tool-result envelope.
      yield { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { content: [
        { type: 'tool-result', content: [{ type: 'text', text: JSON.stringify(terminal) }] },
      ] } } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 3,
        data: { message: { content: [{ type: 'text', text: '采集完成。' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general',
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-escaped-timing', message: '采集',
    sessionRef: 'jot-session-escaped-timing', deferCompletionProbe: true })
  assert.equal(result.completed, true)
  assert.deepEqual(timingCalls.map(call => call[1].phase), ['j.sync', 'final.report'])
})

test('runner passes images as multimodal parts and streams documents through file receipts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-runner-attachment-'))
  try {
    const image = join(directory, 'image.png'); const document = join(directory, 'report.txt')
    writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex')); writeFileSync(document, 'report')
    const calls = []
    const client = {
      create: async () => ({ sessionId: 's' }),
      stageFile: async (...args) => { calls.push(['stageFile', ...args]); return { receipt_id: 'receipt-1' } },
      prompt: async (...args) => { calls.push(['prompt', ...args]); return { accepted: true } },
      async *follow() {
        yield { type: 'snapshot', cursor: 0, records: [] }
        yield { type: 'event', event: { type: 'assistant/message', seq: 1,
          data: { message: { content: [{ type: 'text', text: '完成' }] } } } }
        yield { type: 'event', event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } } }
      },
    }
    const runner = new OfficialSessionRunner(client, {
      cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general',
    })
    await runner.run({ enabled: true, taskRequestId: 'run-1', message: '分析附件', sessionRef: 'jot-session-1',
      deferCompletionProbe: true, attachments: [
        { artifactId: 'a1', displayName: '图片.png', mediaType: 'image/png', sizeBytes: 8,
          sha256: 'x', localPath: image, kind: 'image' },
        { artifactId: 'a2', displayName: '报告.txt', mediaType: 'text/plain', sizeBytes: 6,
          sha256: 'y', localPath: document, kind: 'text' },
      ] })
    assert.equal(calls[0][0], 'stageFile')
    const prompt = calls.find(call => call[0] === 'prompt')
    assert.deepEqual(prompt[3].map(part => part.type), ['text', 'image', 'text', 'text', 'file'])
    assert.equal(prompt[3][1].name, '图片.png')
    assert.match(prompt[3][2].text, /附件“报告\.txt”的 UTF-8 文本内容/)
    assert.match(prompt[3][2].text, /report/)
    assert.match(prompt[3][3].text, /artifact_ref=a2/)
    assert.match(prompt[3][3].text, /sha256=y/)
    assert.equal(prompt[3][4].receipt_id, 'receipt-1')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('runner bounds injected text attachment content while retaining its official receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-runner-text-limit-'))
  try {
    const document = join(directory, 'large.txt'); writeFileSync(document, '甲'.repeat(30_000))
    const calls = []
    const client = {
      create: async () => ({ sessionId: 's' }),
      stageFile: async () => ({ receipt_id: 'receipt-large' }),
      prompt: async (...args) => { calls.push(args); return { accepted: true } },
      async *follow() {
        yield { type: 'snapshot', cursor: 0, records: [] }
        yield { type: 'event', event: { type: 'assistant/message', seq: 1,
          data: { message: { content: [{ type: 'text', text: '完成' }] } } } }
        yield { type: 'event', event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } } }
      },
    }
    const runner = new OfficialSessionRunner(client, {
      cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general',
    })
    await runner.run({ enabled: true, taskRequestId: 'run-large', message: '摘要', sessionRef: 'jot-session-large',
      deferCompletionProbe: true, attachments: [{ artifactId: 'a', displayName: 'large.txt', mediaType: 'text/plain',
        sizeBytes: 90_000, sha256: 'z', localPath: document, kind: 'text' }] })
    const content = calls[0][2]
    const injected = content.find(part => part.type === 'text' && part.text.includes('large.txt'))
    assert.ok(injected)
    assert.ok(Buffer.byteLength(injected.text, 'utf8') <= 66 * 1024)
    assert.match(injected.text, /已截断/)
    assert.equal(content.at(-1).receipt_id, 'receipt-large')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('runner never treats reasoning as final output', async () => {
  const client = {
    create: async () => ({ sessionId: 's' }), prompt: async () => ({ accepted: true }),
    async *follow() {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'hidden' } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general',
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-1', message: 'hi', sessionRef: 'jot-session-1', deferCompletionProbe: true })
  assert.equal(result.final_text, undefined)
})

test('runner batches answer and reasoning deltas independently and returns settled blocks', async () => {
  const projected = []
  const client = {
    create: async () => ({ sessionId: 's' }), prompt: async () => ({ accepted: true }),
    async *follow() {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } }
      yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', index: 0,
        chunk: { type: 'reasoning-delta', index: 0, text: '核对' } } }
      yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', index: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '资料' } } }
      yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', index: 2,
        chunk: { type: 'text-delta', index: 1, text: '你' } } }
      yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', index: 3,
        chunk: { type: 'text-delta', index: 1, text: '好' } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 1,
        data: { message: { id: 'm1', content: [{ type: 'reasoning', text: '核对资料' },
          { type: 'text', text: '你好' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general', deltaFlushMs: 10_000,
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-1', message: 'hi',
    sessionRef: 'jot-session-1', deferCompletionProbe: true, onProjection: value => projected.push(value) })
  assert.equal(result.final_text, '你好')
  assert.equal(projected.filter(value => value.type === 'assistant.delta' && value.payload.kind === 'text').length, 1)
  assert.equal(projected.find(value => value.payload.kind === 'text').payload.text, '你好')
  assert.equal(projected.filter(value => value.type === 'assistant.delta' && value.payload.kind === 'reasoning').length, 1)
  assert.equal(projected.find(value => value.payload.kind === 'reasoning').payload.text, '核对资料')
  assert.deepEqual(result.final_blocks, [{ kind: 'reasoning', text: '核对资料' }, { kind: 'text', text: '你好' }])
})

test('runner projects released-v1 durable assistant/chunk events when live frames are unavailable', async () => {
  const projected = []
  const client = {
    create: async () => ({ sessionId: 's' }), prompt: async () => ({ accepted: true }),
    async *follow() {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield { type: 'event', event: { type: 'assistant/chunk', seq: 1, time: 1,
        data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '分析' } } } }
      yield { type: 'event', event: { type: 'assistant/chunk', seq: 2, time: 2,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: '答案' } } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 3,
        data: { message: { id: 'm1', content: [{ type: 'reasoning', text: '分析' },
          { type: 'text', text: '答案' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general', deltaFlushMs: 10_000,
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-v1', message: 'hi',
    sessionRef: 'jot-session-v1', deferCompletionProbe: true, onProjection: value => projected.push(value) })
  assert.equal(result.final_text, '答案')
  assert.equal(projected.find(value => value.type === 'assistant.delta' && value.payload.kind === 'reasoning').payload.text, '分析')
  assert.equal(projected.find(value => value.type === 'assistant.delta' && value.payload.kind === 'text').payload.text, '答案')
})

test('runner does not publish an earlier progress message when a later Assistant step never settles', async () => {
  const client = {
    create: async () => ({ sessionId: 's' }), prompt: async () => ({ accepted: true }),
    async *follow() {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield { type: 'event', event: { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 2,
        data: { turn: 1, step: 1, message: { id: 'progress', content: [{ type: 'text', text: '正在回读验证。' }] } } } }
      yield { type: 'event', event: { type: 'step/end', seq: 3, data: { turn: 1, step: 1 } } }
      yield { type: 'event', event: { type: 'step/start', seq: 4, data: { turn: 1, step: 2 } } }
      yield { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a2', revision: 1, turn: 1, step: 2 } }
      yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a2', index: 0,
        chunk: { type: 'text-delta', index: 0, text: '四处修改全部成功。' } } }
      yield { type: 'event', event: { type: 'step/end', seq: 5, data: { turn: 1, step: 2 } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general',
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-unsettled', message: '修改文档',
    sessionRef: 'jot-session-unsettled', deferCompletionProbe: true })
  assert.equal(result.final_text, undefined)
  assert.equal(result.completed, false)
  assert.equal(result.reason_code, 'SESSION_FINAL_TEXT_MISSING')
})

test('runner returns the last finalized text step and structured file deliverables', async () => {
  const client = {
    create: async () => ({ sessionId: 's' }), prompt: async () => ({ accepted: true }),
    async *follow() {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield { type: 'event', event: { type: 'assistant/message', seq: 1,
        data: { turn: 1, step: 1, message: { id: 'progress', content: [{ type: 'text', text: '正在处理。' }] } } } }
      yield { type: 'event', event: { type: 'tool/result', seq: 2, data: { turn: 1, step: 1,
        message: { source: { kind: 'tool', callId: 'file-1' }, content: [{ type: 'tool-result', toolCallId: 'file-1',
          isError: false, content: [{ type: 'text', text: '{"artifact_ref":"artifact-123","version":5,"sha256":"abc","size_bytes":100,"media_type":"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}' }] }] } } } }
      yield { type: 'event', event: { type: 'deliverables/presented', seq: 3,
        data: { turn: 1, callId: 'present-1', files: [{ path: '/safe/final.docx', description: '最终文档' }] } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 4,
        data: { turn: 1, step: 2, message: { id: 'final', content: [{ type: 'text', text: '已完成并生成文档。' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general',
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-deliverable', message: '修改文档',
    sessionRef: 'jot-session-deliverable', deferCompletionProbe: true })
  assert.equal(result.final_text, '已完成并生成文档。')
  assert.deepEqual(result.output_artifact_refs, ['artifact-123'])
  assert.deepEqual(result.presented_files, [{ path: '/safe/final.docx', description: '最终文档' }])
})

test('runner does not bind a queued or read-only file reference as a generated output', async () => {
  const client = {
    create: async () => ({ sessionId: 's' }), prompt: async () => ({ accepted: true }),
    async *follow() {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield { type: 'event', event: { type: 'tool/result', seq: 1, data: { message: { content: [
        { type: 'tool-result', content: [{ type: 'text', text: '{"job_id":"job-1","artifact_ref":"artifact-input","status":"queued","output_version":null}' }] },
      ] } } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 2,
        data: { message: { content: [{ type: 'text', text: '已开始处理。' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general',
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-queued', message: '读取文档',
    sessionRef: 'jot-session-queued', deferCompletionProbe: true })
  assert.equal(result.output_artifact_refs, undefined)
})

test('runner reports context overflow precisely and exposes an artifact before final settlement', async () => {
  const observed = []
  const client = {
    create: async () => ({ sessionId: 's' }), prompt: async () => ({ accepted: true }),
    async *follow() {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield { type: 'event', event: { type: 'tool/result', seq: 1, data: { message: { content: [
        { type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({ status: 'completed',
          artifact_ref: 'artifact-output', output_version: 5, sha256: 'a'.repeat(64), size_bytes: 21172,
          media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }) }] },
      ] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'error',
        error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context overflow' } } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', timeoutMs: 1000, agentPreset: 'jot-general',
  })
  const result = await runner.run({ enabled: true, taskRequestId: 'run-overflow', message: '修改文档',
    sessionRef: 'jot-session-overflow', deferCompletionProbe: true,
    onArtifactRef: value => observed.push(value) })
  assert.deepEqual(observed, ['artifact-output'])
  assert.deepEqual(result.output_artifact_refs, ['artifact-output'])
  assert.equal(result.final_text, undefined)
  assert.equal(result.reason_code, 'SESSION_CONTEXT_WINDOW_EXCEEDED')
})


test('only trusted budget-enforced roles select the dedicated preset; missing configuration denies before create',async()=>{
 const creates=[];const client={create:async(...args)=>{creates.push(args);return{};},async *follow(){yield {type:'snapshot',cursor:0,records:[]};},prompt:async()=>({})};
 const input={enabled:true,taskRequestId:'run-fixture',message:'Fixture',sessionRef:'session-fixture',deferCompletionProbe:true};
 const runner=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general',workbenchAgentPreset:'jot-workbench-budgeted'});
 await runner.run(input);assert.equal(creates.at(-1)[2],'jot-general');
 await runner.run({...input,workbenchRunId:'run-fixture',workbenchExecutionLease:{owner:'worker-fixture',generation:1},workbenchBudgetEnforced:true});assert.equal(creates.at(-1)[2],'jot-workbench-budgeted');
 const count=creates.length;const missing=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'});
 await assert.rejects(missing.run({...input,workbenchRunId:'run-fixture',workbenchExecutionLease:{owner:'worker-fixture',generation:1},workbenchBudgetEnforced:true}),/workbench_budget_preset_required/);assert.equal(creates.length,count);
 for(const extra of [{workbenchBudgetEnforced:true},{workbenchBudgetEnforced:true,workbenchRunId:'run-fixture'},{workbenchBudgetEnforced:'true'}])await assert.rejects(runner.run({...input,...extra}),/workbench_.*(?:required|invalid)/);assert.equal(creates.length,count);
});
