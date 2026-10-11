import assert from 'node:assert/strict'
import test from 'node:test'
import { projectSessionFrame, projectWebOperationSnapshot } from '../../src/harness/session-event-projector.ts'

const context = { runId: 'run-1', attemptId: 'attempt-run-1', messageId: 'stream-run-1',
  blockId: 'stream-run-1:0', deltaIndex: 0, at: '2026-09-13T00:00:00.000Z' }

test('native Goal lifecycle and projections remain internal rather than entering conversation SSE',()=>{
 for(const type of ['goal/change','goal/changed','session/projection'])assert.equal(projectSessionFrame({type:'event',event:{type,data:{goal:{id:'goal-private-fixture',objective:'internal binding marker'},sessionId:'session-private-fixture'}}},context),null);
})

test('projects contract-shaped assistant text and safe tool status', () => {
  assert.deepEqual(projectSessionFrame({ type: 'assistant-stream', frame: { type: 'chunk',
    chunk: { type: 'text-delta', text: '你' } } }, context),
  { type: 'assistant.delta', payload: { message_id: 'stream-run-1', block_id: 'stream-run-1:0',
    kind: 'text', attempt_id: 'attempt-run-1', delta_index: 0, text: '你' } })
  assert.deepEqual(projectSessionFrame({ type: 'event', event: { type: 'tool/call', seq: 2,
    data: { callId: 'c1', name: 'universe_search', arguments: { query: '亦庄天气' } } } }, context),
  { type: 'activity.upsert', payload: { activity_id: 'c1', run_id: 'run-1', tool_call_id: 'c1',
    attempt_id: 'attempt-run-1', status: 'running', title: '正在搜索资料', started_at: context.at,
    kind: 'search', detail: { queries: ['亦庄天气'], source_ids: [], tool_name: 'universe_search' } } })
})

test('retains real tool, action, full URLs and start time through result',()=>{
 const ctx={...context,knownTools:new Map()};
 const urls=Array.from({length:7},(_,i)=>`https://example.com/${i}?q=one#section`);
 const call=projectSessionFrame({type:'event',event:{type:'tool/call',data:{callId:'url-call',name:'mcp__browser__navigate',arguments:JSON.stringify({urls,action:'navigate',password:'not-public'})}}},ctx);
 assert.deepEqual(call.payload.detail.urls,urls);
 assert.equal(call.payload.detail.tool_name,'mcp__browser__navigate');
 assert.equal(call.payload.detail.action,'navigate');
 assert.equal(JSON.stringify(call).includes('not-public'),false);
 const result=projectSessionFrame({type:'event',event:{type:'tool/result',data:{callId:'url-call',result:'private result'}}},{...ctx,at:'2026-09-13T00:01:00.000Z'});
 assert.deepEqual(result.payload.detail,call.payload.detail);
 assert.equal(result.payload.started_at,context.at);
});
test('generic tool activity preserves complete bounded URLs and rejects credential-bearing or over-limit URLs', () => {
 const ctx={...context,knownTools:new Map()};
 const prefix='https://example.test/';
 const atLength=length=>prefix+'a'.repeat(length-prefix.length);
 const atCodePointLength=length=>prefix+'😀'.repeat(length-[...prefix].length);
 const urls=[atLength(2001),atLength(8192),atLength(8193),atLength(20000),
  'https://@example.test/private','https://:@example.test/private',
  'https://test-user:test-password@example.test/private?q=x#y',atCodePointLength(8192),atCodePointLength(8193)];
 const projected=projectSessionFrame({type:'event',event:{type:'tool/call',data:{
  callId:'bounded-url-call',name:'mcp__browser__navigate',arguments:{urls},
 }}},ctx);
 assert.ok(projected);
 assert.deepEqual(projected.payload.detail.urls,[urls[0],urls[1],urls[7]]);
});
test('invalid argument JSON and unsafe URL protocols do not escape into public details',()=>{
 for(const args of ['invalid',{url:'javascript:alert(1)'},{url:'data:text/html,test'}]){
 const p=projectSessionFrame({type:'event',event:{type:'tool/call',data:{callId:'c2',name:'browser',arguments:args}}},context);
 assert.equal(p.payload.detail.urls,undefined);
  }
});

test('arbitrary action and operation strings cannot leak target text into persisted details', () => {
  const projected = projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-private-action', name: 'universe_browse', arguments: {
      url: 'https://example.test/', action: 'click private account billing',
      operation: 'submit private card number',
    },
  } } }, { ...context, knownTools: new Map() });
  assert.equal(projected.payload.detail.action, undefined);
  assert.doesNotMatch(JSON.stringify(projected), /private account billing|private card number/);
});

test('requested action types are restricted to the supported action enum', () => {
  const projected = projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-private-action-type', name: 'universe_browse', arguments: {
      inputs: { actions: [{ type: 'click' }, { type: 'privatebilling123' }] },
    },
  } } }, { ...context, knownTools: new Map() });
  assert.deepEqual(projected.payload.detail.requested_action_types, ['click']);
  assert.doesNotMatch(JSON.stringify(projected), /privatebilling123/);
});

test('projects nested Universe browse inputs as requested actions without implying a click receipt', () => {
  const projected = projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-click', name: 'universe_browse', arguments: {
      goal: 'click a visible link', inputs: { url: 'https://www.w3.org/', actions: [
        { type: 'click', target: { role: 'link', text: 'standards and guidelines' } },
      ] },
    },
  } } }, { ...context, knownTools: new Map() });

  assert.deepEqual(projected.payload.detail.urls, ['https://www.w3.org/']);
  assert.deepEqual(projected.payload.detail.requested_action_types, ['click']);
  assert.equal(projected.payload.detail.click_receipt, undefined);
  assert.doesNotMatch(JSON.stringify(projected), /standards and guidelines|click a visible link/);
});

test('projects only verified Browse action evidence from the official tool result', () => {
  const ctx = { ...context, knownTools: new Map() };
  const call = projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-result', name: 'universe_browse', arguments: {
      goal: 'open a private link label', inputs: { url: 'https://www.w3.org/', actions: [
        { type: 'click', target: { role: 'link', text: 'private link label' } },
      ] },
    },
  } } }, ctx);
  const universeResult = {
    status: 'completed',
    events: [{ payload: { event_type: 'capability_result', capability: 'browse', outcome: 'success',
      data: { interaction_trace: [{
        action: { type: 'click', target: { text: 'private link label' } },
        before_state_lite: { final_url: 'https://www.w3.org/?token=secret', page_title: 'Private before title' },
        after_state_lite: { final_url: 'https://www.w3.org/TR/?token=secret', page_title: 'Private after title' },
        settlement: { status: 'SETTLED', changes: ['url'] },
        verification: { status: 'BUSINESS_SUCCESS' },
      }] },
    } }],
  };
  const result = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: {
    message: { source: { kind: 'tool', callId: 'browse-result' }, content: [{ type: 'tool-result',
      toolCallId: 'browse-result', isError: false, content: [{ type: 'text', text: JSON.stringify(universeResult) }] }] },
  } } }, ctx);

  assert.deepEqual(call.payload.detail.requested_action_types, ['click']);
  assert.deepEqual(result.payload.detail.verified_action_types, ['click']);
  assert.deepEqual(result.payload.detail.verification_statuses, ['BUSINESS_SUCCESS']);
  assert.equal(result.payload.detail.action_trace_count, 1);
  assert.equal(result.payload.detail.browse_outcome, 'success');
  assert.equal(result.payload.status, 'succeeded');
  assert.doesNotMatch(JSON.stringify(result), /private link label|Private before title|Private after title|token=secret/);
});

test('Browse failure and unknown verification states are projected without free-text leakage', () => {
  const ctx = { ...context, knownTools: new Map() };
  projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-failure', name: 'universe_browse', arguments: { inputs: { url: 'https://example.test/' } },
  } } }, ctx);
  const payload = { events: [{ payload: { event_type: 'capability_result', capability: 'browse',
    outcome: 'failure', reason: 'PROVIDER_FAILED', data: { interaction_trace: [{
      action: { type: 'click', target: { text: 'private target' } },
      verification: { status: 'PRIVATE_ERROR_TEXT', detail: 'do not persist' },
    }] },
  } }], body: 'private page body' };
  const result = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: {
    callId: 'browse-failure', result: JSON.stringify(payload),
  } } }, ctx);
  assert.equal(result.payload.status, 'failed');
  assert.equal(result.payload.detail.browse_outcome, 'failure');
  assert.deepEqual(result.payload.detail.verification_statuses, ['UNKNOWN']);
  assert.deepEqual(result.payload.detail.verified_action_types, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR_TEXT|do not persist|private target|private page body/);
});

test('the last Browse capability attempt determines the projected outcome', () => {
  const ctx = { ...context, knownTools: new Map() };
  projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-retried', name: 'universe_browse', arguments: { inputs: { url: 'https://example.test/' } },
  } } }, ctx);
  const result = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: {
    callId: 'browse-retried', result: JSON.stringify({ events: [
      { payload: { event_type: 'capability_result', capability: 'browse', outcome: 'failure',
        data: { interaction_trace: [{ action: { type: 'click' }, verification: { status: 'NO_EFFECT' } }] } } },
      { payload: { event_type: 'capability_result', capability: 'browse', outcome: 'success',
        data: { interaction_trace: [{ action: { type: 'click' }, verification: { status: 'BUSINESS_SUCCESS' } }] } } },
    ] }),
  } } }, ctx);
  assert.equal(result.payload.detail.browse_outcome, 'success');
  assert.equal(result.payload.status, 'succeeded');
  assert.deepEqual(result.payload.detail.verification_statuses, ['BUSINESS_SUCCESS']);
  assert.deepEqual(result.payload.detail.verified_action_types, ['click']);
});

test('the final failed Browse attempt cannot inherit an earlier verified action', () => {
  const ctx = { ...context, knownTools: new Map() };
  projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-retried-failure', name: 'universe_browse', arguments: { inputs: { url: 'https://example.test/' } },
  } } }, ctx);
  const result = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: {
    callId: 'browse-retried-failure', result: JSON.stringify({ events: [
      { payload: { event_type: 'capability_result', capability: 'browse', outcome: 'success',
        data: { interaction_trace: [{ action: { type: 'click' }, verification: { status: 'BUSINESS_SUCCESS' } }] } } },
      { payload: { event_type: 'capability_result', capability: 'browse', outcome: 'failure',
        data: { interaction_trace: [{ action: { type: 'click' }, verification: { status: 'NO_EFFECT' } }] } } },
    ] }),
  } } }, ctx);
  assert.equal(result.payload.detail.browse_outcome, 'failure');
  assert.equal(result.payload.status, 'failed');
  assert.deepEqual(result.payload.detail.verification_statuses, ['NO_EFFECT']);
  assert.deepEqual(result.payload.detail.verified_action_types, []);
});

test('the final failed DSH result takes precedence over inner Browse success evidence', () => {
  const ctx = { ...context, knownTools: new Map() };
  projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-outer-error', name: 'universe_browse', arguments: { inputs: { url: 'https://example.test/' } },
  } } }, ctx);
  const inner = { events: [{ payload: { event_type: 'capability_result', capability: 'browse', outcome: 'success',
    data: { interaction_trace: [{ action: { type: 'click' }, verification: { status: 'BUSINESS_SUCCESS' } }] },
  } }] };
  const result = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: {
    callId: 'browse-outer-error', error: 'private wrapper failure', result: JSON.stringify(inner),
  } } }, ctx);
  assert.equal(result.payload.status, 'failed');
  assert.equal(result.payload.detail.browse_outcome, 'failure');
  assert.deepEqual(result.payload.detail.verified_action_types, []);
  assert.doesNotMatch(JSON.stringify(result), /private wrapper failure/);

  const errorBlockContext = { ...context, knownTools: new Map() };
  projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-outer-error-block', name: 'universe_browse', arguments: { inputs: { url: 'https://example.test/' } },
  } } }, errorBlockContext);
  const errorBlockResult = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: {
    message: { source: { kind: 'tool', callId: 'browse-outer-error-block' }, content: [{
      type: 'tool-result', toolCallId: 'browse-outer-error-block', isError: true,
      content: [{ type: 'text', text: JSON.stringify(inner) }],
    }] },
  } } }, errorBlockContext);
  assert.equal(errorBlockResult.payload.status, 'failed');
  assert.equal(errorBlockResult.payload.detail.browse_outcome, 'failure');
  assert.deepEqual(errorBlockResult.payload.detail.verified_action_types, []);
});

test('a structured Universe error marks the Browse activity failed without an action trace', () => {
  const ctx = { ...context, knownTools: new Map() };
  projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-conflict', name: 'universe_browse', arguments: {
      request_id: 'w3c-click', inputs: { url: 'https://www.w3.org/', actions: [{ type: 'click' }] },
    },
  } } }, ctx);
  const result = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: {
    message: { source: { kind: 'tool', callId: 'browse-conflict' }, content: [{
      type: 'tool-result', toolCallId: 'browse-conflict', isError: false,
      content: [{ type: 'text', text: '{"ok":false,"error":"request_conflict"}' }],
    }] },
  } } }, ctx);
  assert.equal(result.payload.status, 'failed');
  assert.equal(result.payload.detail.browse_outcome, 'failure');
  assert.equal(result.payload.detail.action_trace_count, 0);
  assert.deepEqual(result.payload.detail.verified_action_types, []);
  assert.doesNotMatch(JSON.stringify(result), /request_conflict/);
});

test('unverified Universe Browse result is unknown, while other browser tools keep ordinary result behavior', () => {
  const universeContext = { ...context, knownTools: new Map() };
  projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-no-evidence', name: 'universe_browse', arguments: { inputs: { url: 'https://example.test/' } },
  } } }, universeContext);
  const universeResult = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: {
    callId: 'browse-no-evidence', result: '{malformed output',
  } } }, universeContext);
  assert.equal(universeResult.payload.status, 'unknown');
  assert.equal(universeResult.payload.title, '网页结果待核实');
  assert.equal(universeResult.payload.detail.browse_outcome, 'unknown');

  const genericContext = { ...context, knownTools: new Map() };
  projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'generic-browser', name: 'mcp__browser__navigate', arguments: { url: 'https://example.test/' },
  } } }, genericContext);
  const genericResult = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: {
    callId: 'generic-browser', result: 'navigation complete',
  } } }, genericContext);
  assert.equal(genericResult.payload.status, 'succeeded');
});

test('Browse evidence keeps the latest twelve records from the final attempt', () => {
  const ctx = { ...context, knownTools: new Map() };
  projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-long-final-trace', name: 'universe_browse', arguments: { inputs: { url: 'https://example.test/' } },
  } } }, ctx);
  const oldTrace = [{ action: { type: 'click' }, verification: { status: 'BUSINESS_SUCCESS' } }];
  const finalTrace = Array.from({ length: 13 }, (_, index) => ({
    action: { type: index === 12 ? 'click' : 'scroll' },
    verification: { status: index === 12 ? 'BUSINESS_SUCCESS' : 'NO_EFFECT' },
  }));
  const result = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: {
    callId: 'browse-long-final-trace', result: JSON.stringify({ events: [
      { payload: { event_type: 'capability_result', capability: 'browse', outcome: 'failure', data: { interaction_trace: oldTrace } } },
      { payload: { event_type: 'capability_result', capability: 'browse', outcome: 'success', data: { interaction_trace: finalTrace } } },
    ] }),
  } } }, ctx);
  assert.equal(result.payload.detail.action_trace_count, 12);
  assert.deepEqual(result.payload.detail.traced_action_types, ['scroll', 'click']);
  assert.deepEqual(result.payload.detail.verification_statuses, ['NO_EFFECT', 'BUSINESS_SUCCESS']);
  assert.deepEqual(result.payload.detail.verified_action_types, ['click']);
});

test('the last unrecognized Browse outcome stays unknown instead of inheriting an earlier outcome', () => {
  const ctx = { ...context, knownTools: new Map() };
  projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-retried-unknown', name: 'universe_browse', arguments: { inputs: { url: 'https://example.test/' } },
  } } }, ctx);
  const result = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: {
    callId: 'browse-retried-unknown', result: JSON.stringify({ events: [
      { payload: { event_type: 'capability_result', capability: 'browse', outcome: 'failure' } },
      { payload: { event_type: 'capability_result', capability: 'browse' } },
    ] }),
  } } }, ctx);
  assert.equal(result.payload.detail.browse_outcome, 'unknown');
  assert.equal(result.payload.status, 'unknown');
});

test('an unknown final Browse outcome cannot inherit an earlier verified action trace', () => {
  const ctx = { ...context, knownTools: new Map() };
  projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: {
    callId: 'browse-unknown-no-inherit', name: 'universe_browse', arguments: { inputs: { url: 'https://example.test/' } },
  } } }, ctx);
  const result = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: {
    callId: 'browse-unknown-no-inherit', result: JSON.stringify({ events: [
      { payload: { event_type: 'capability_result', capability: 'browse', outcome: 'success',
        data: { interaction_trace: [{ action: { type: 'click' }, verification: { status: 'BUSINESS_SUCCESS' } }] } } },
      { payload: { event_type: 'capability_result', capability: 'browse', outcome: 'unsupported', data: {} } },
    ] }),
  } } }, ctx);
  assert.equal(result.payload.detail.browse_outcome, 'unknown');
  assert.equal(result.payload.status, 'unknown');
  assert.equal(result.payload.detail.action_trace_count, 0);
  assert.deepEqual(result.payload.detail.verified_action_types, []);
});

test('execute snapshots never persist target URLs or form inputs in the Jot activity projection', () => {
  const projected = projectWebOperationSnapshot('execute-call', 'universe_execute', {
    operation_id: `web-${'e'.repeat(32)}`, kind: 'execute', status: 'waiting_confirmation',
    revision: 1, event_cursor: 1, accepted_count: 1, counts: { waiting: 1 },
    items: [{ item_id: 'submit-a', position: 0,
      inputs: { url: 'https://example.test/private?token=secret', note: 'private form value' },
      status: 'waiting' }],
  }, context)
  assert.ok(projected)
  assert.deepEqual(projected.payload.detail.urls, [])
  assert.equal(projected.payload.detail.items[0].url, undefined)
  assert.doesNotMatch(JSON.stringify(projected), /example\.test|private form value|token=secret/)
})

test('web-operation snapshots allowlist status identifiers and references while preserving the complete accepted URL', () => {
  const projected = projectWebOperationSnapshot('safe-call', 'universe_read_page', {
    operation_id: `web-${'a'.repeat(32)}`, kind: 'read_page', status: 'private operation status',
    revision: 1, event_cursor: 1, accepted_count: 2,
    counts: { succeeded: 1, 'private_count_token': 99 },
    items: [
      { item_id: 'private user input', position: 0,
        inputs: { url: 'https://example.test/article?q=gold#results' },
        status: 'succeeded private user input', reason_code: 'PRIVATE USER TOKEN', result_ref: 'private result token' },
      { item_id: 'valid-item', position: 1, inputs: { url: 'https://example.test/next' },
        status: 'succeeded', reason_code: 'PAGE_TIMEOUT', result_ref: 'a'.repeat(32) },
    ],
  }, context)
  assert.ok(projected)
  assert.equal(projected.payload.status, 'unknown')
  assert.equal(projected.payload.detail.operation_kind, 'read_page')
  assert.equal(projected.payload.detail.operation_status, 'unknown')
  assert.deepEqual(projected.payload.detail.counts, { succeeded: 1 })
  assert.deepEqual(projected.payload.detail.urls, [
    'https://example.test/article?q=gold#results', 'https://example.test/next',
  ])
  assert.deepEqual(projected.payload.detail.items[0], {
    item_id: 'item-0', position: 0, url: 'https://example.test/article?q=gold#results', status: 'unknown',
    action_label: '读取页面',
  })
  assert.equal(projected.payload.detail.items[1].reason_code, 'PAGE_TIMEOUT')
  assert.equal(projected.payload.detail.items[1].result_ref, 'a'.repeat(32))
  assert.doesNotMatch(JSON.stringify(projected), /private user input|PRIVATE USER TOKEN|private result token|private_count_token/)
})

test('web-operation snapshot URLs follow C 8192-character limit without truncating query or fragment', () => {
  const prefix = 'https://example.test/'
  const suffix = '?q=full#fragment'
  const atLength = length => prefix + 'a'.repeat(length - prefix.length - suffix.length) + suffix
  const atCodePointLength = length => prefix + '😀'.repeat(length - [...prefix].length - [...suffix].length) + suffix
  const urls = [atLength(2001), atLength(8192), atLength(8193),
    atCodePointLength(8192), atCodePointLength(8193), 'https://@example.test/private?q=x#fragment']
  const projected = projectWebOperationSnapshot('url-limits', 'universe_read_page', {
    operation_id: `web-${'b'.repeat(32)}`, kind: 'read_page', status: 'succeeded',
    revision: 1, event_cursor: 1, accepted_count: 6,
    items: urls.map((url, index) => ({ item_id: `url-${index}`, position: index,
      inputs: { url }, status: 'succeeded' })),
  }, context)
  assert.ok(projected)
  assert.deepEqual(projected.payload.detail.urls, [
    urls[0], urls[1], urls[3],
  ])
  assert.equal(projected.payload.detail.items[0].url, urls[0])
  assert.equal(projected.payload.detail.items[1].url, urls[1])
  assert.equal(projected.payload.detail.items[2].url, undefined)
  assert.equal(projected.payload.detail.items[3].url, urls[3])
  assert.equal(projected.payload.detail.items[4].url, undefined)
  assert.equal(projected.payload.detail.items[5].url, undefined)
})

test('official DSH result message correlates with the call and preserves webpage details',()=>{
 const ctx={...context,knownTools:new Map()};
 const call=projectSessionFrame({type:'event',event:{type:'tool/call',data:{callId:'official-call',name:'universe_read_page',arguments:{url:'https://example.com/page'}}}},ctx);
 const result=projectSessionFrame({type:'event',event:{type:'tool/result',data:{message:{id:'message-result',role:'user',source:{kind:'tool',callId:'official-call'},content:[{type:'tool-result',toolCallId:'official-call',isError:true,content:[{type:'text',text:'private result'}]}]}}}},ctx);
 assert.equal(result.payload.activity_id,call.payload.activity_id);
 assert.deepEqual(result.payload.detail,call.payload.detail);
 assert.equal(result.payload.status,'failed');
 assert.equal(JSON.stringify(result).includes('private result'),false);
});

test('unidentified results never create a shared fake activity',()=>{
 assert.equal(projectSessionFrame({type:'event',event:{type:'tool/result',data:{message:{content:[]}}}},context),null);
});

test('reasoning is projected as its own incremental block', () => {
  const value = projectSessionFrame({ type: 'assistant-stream', frame: { type: 'chunk',
    chunk: { type: 'reasoning-delta', text: 'private chain of thought' } } }, context)
  assert.deepEqual(value, { type: 'assistant.delta', payload: { message_id: 'stream-run-1',
    block_id: 'stream-run-1:0', kind: 'reasoning', attempt_id: 'attempt-run-1', delta_index: 0,
    text: 'private chain of thought' } })
})

test('projects tool completion without raw result and ignores private Session events', () => {
  const completed = projectSessionFrame({ type: 'event', event: { type: 'tool/result', seq: 3,
    data: { callId: 'c1', name: 'universe_search', result: 'private payload' } } }, context)
  assert.equal(completed.type, 'activity.upsert')
  assert.equal(completed.payload.status, 'succeeded')
  assert.equal(JSON.stringify(completed).includes('private'), false)
  assert.equal(projectSessionFrame({ type: 'event', event: { type: 'request/header', seq: 1,
    data: { systemPrompt: 'secret' } } }, context), null)
  assert.deepEqual(projectSessionFrame({ type: 'event', event: { type: 'assistant/message', seq: 4,
    data: { message: { id: 'msg-final', content: [{ type: 'reasoning', text: '已核对' },
      { type: 'text', text: '最终回答' }] } } } }, context),
  { type: 'assistant.settled', payload: { attempt_id: 'attempt-run-1', message: {
    message_id: 'msg-final', run_id: 'run-1', role: 'assistant', status: 'complete',
    blocks: [{ block_id: 'msg-final:0', kind: 'reasoning', text: '已核对', exposure: 'provider' },
      { block_id: 'msg-final:1', kind: 'text', text: '最终回答', exposure: 'public' }],
    created_at: context.at,
  } } })
})

test('an abandoned Assistant attempt settles as failed so the UI can retract its partial blocks', () => {
  assert.deepEqual(projectSessionFrame({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'a1',
    outcome: { kind: 'abandoned' } } }, { ...context, attemptId: 'a1' }),
  { type: 'assistant.settled', payload: { attempt_id: 'a1', message: {
    message_id: 'stream-run-1', run_id: 'run-1', role: 'assistant', status: 'failed', blocks: [],
    created_at: context.at,
  } } })
})
