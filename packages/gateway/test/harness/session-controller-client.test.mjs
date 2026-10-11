import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openProductDatabase } from '../../src/db/database.ts'
import { SessionBindingRepository } from '../../src/harness/session-bindings.ts'
import { SessionControllerClient } from '../../src/harness/session-controller-client.ts'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ga-session-binding-'))
  const db = openProductDatabase(join(directory, 'db.sqlite'))
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv-1', 'owner-1', 'ws', 't', '{}', 1, 'now', 'now')
  return { directory, db }
}

test('one owned conversation always reuses one official Harness session id', () => {
  const x = fixture()
  try {
    const repo = new SessionBindingRepository(x.db)
    const first = repo.getOrCreate('owner-1', 'conv-1')
    const second = repo.getOrCreate('owner-1', 'conv-1')
    assert.equal(first.session_id, second.session_id)
    assert.match(first.session_id, /^jot-/)
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }) }
})

test('binding lookup enforces conversation ownership', () => {
  const x = fixture()
  try {
    const repo = new SessionBindingRepository(x.db)
    assert.throws(() => repo.getOrCreate('owner-2', 'conv-1'), /conversation_not_found/)
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }) }
})

test('a new preset namespace rotates an old binding once and then reuses it', () => {
  const x = fixture()
  try {
    const now = new Date().toISOString()
    x.db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run('conv-1', 'owner-1', 'jot-old-session', now, now)
    const repo = new SessionBindingRepository(x.db, 'jot-ugs1')
    const rotated = repo.getOrCreate('owner-1', 'conv-1')
    const reused = repo.getOrCreate('owner-1', 'conv-1')
    assert.match(rotated.session_id, /^jot-ugs1-/)
    assert.notEqual(rotated.session_id, 'jot-old-session')
    assert.equal(reused.session_id, rotated.session_id)
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }) }
})

test('client refuses non-loopback adapter endpoints', () => {
  assert.throws(() => new SessionControllerClient('https://example.com', 'a'.repeat(32)), /adapter_endpoint_not_loopback/)
})

test('completion transport authenticates the encoded Session and forwards only the durable intent',async()=>{
 const requests=[],receipt={confirmed:true,intent_id:'intent-1'};
 const client=new SessionControllerClient('http://127.0.0.1:18841','a'.repeat(32),async(url,init)=>{
  requests.push({url:String(url),init});return Response.json(receipt);
 });
 assert.deepEqual(await client.goalComplete('session/foreign?x=1','intent-1'),receipt);
 assert.equal(requests.length,1);
 assert.equal(requests[0].url,'http://127.0.0.1:18841/v1/sessions/session%2Fforeign%3Fx%3D1/goal-complete');
 assert.equal(requests[0].init.headers.authorization,`Bearer ${'a'.repeat(32)}`);
 assert.deepEqual(JSON.parse(requests[0].init.body),{intent_id:'intent-1'});
 const controller=new AbortController();controller.abort();
 const cancelled=new SessionControllerClient('http://127.0.0.1:18841','a'.repeat(32),async(_url,init)=>{
  init.signal.throwIfAborted();throw new Error('must not dispatch');
 });
 await assert.rejects(cancelled.goalComplete('session-1','intent-1',controller.signal),error=>error.name==='AbortError');
});

test('restore transport sends only the original run and intent through the authenticated private Session path',async()=>{
 const requests=[],client=new SessionControllerClient('http://127.0.0.1:18841','a'.repeat(32),async(url,init)=>{
  requests.push({url:String(url),init});return Response.json({restored:true});
 });
 assert.deepEqual(await client.goalRestore('session/1','run-1','intent-1'),{restored:true});
 assert.equal(requests[0].url,'http://127.0.0.1:18841/v1/sessions/session%2F1/goal-restore');
 assert.equal(requests[0].init.headers.authorization,`Bearer ${'a'.repeat(32)}`);
 assert.deepEqual(JSON.parse(requests[0].init.body),{run_id:'run-1',intent_id:'intent-1'});
 await client.goalRestore('session/1','run-1');
 assert.deepEqual(JSON.parse(requests[1].init.body),{run_id:'run-1'});
});

test('goal status uses the private authenticated Session address and sends no client identity or lifecycle mutation',async()=>{
 const requests=[],state={protocol:1,goal:{phase:'active'}};
 const client=new SessionControllerClient('http://127.0.0.1:18841','a'.repeat(32),async(url,init)=>{requests.push({url:String(url),init});return Response.json({state});});
 assert.deepEqual(await client.goalStatus('jot-local'),{state});
 assert.equal(requests.length,1);assert.equal(requests[0].url,'http://127.0.0.1:18841/v1/sessions/jot-local/goal-status');
 assert.equal(requests[0].init.headers.authorization,`Bearer ${'a'.repeat(32)}`);assert.deepEqual(JSON.parse(requests[0].init.body),{});
});

test('goal stop sends only a CAS ref to the bounded private host stop channel',async()=>{
 const calls=[],receipt={state:{protocol:1,goal:{phase:'paused'}},turn_end_seq:9};
 const client=new SessionControllerClient('http://127.0.0.1:18841','a'.repeat(32),async(url,init)=>{calls.push({url:String(url),init});return Response.json(receipt);});
 assert.deepEqual(await client.goalStop('jot-local',{goal_id:'goal-1',goal_revision:2}),receipt);
 assert.equal(calls[0].url,'http://127.0.0.1:18841/v1/sessions/jot-local/goal-stop');assert.equal(calls[0].init.headers.authorization,`Bearer ${'a'.repeat(32)}`);
 assert.deepEqual(JSON.parse(calls[0].init.body),{goal_id:'goal-1',goal_revision:2});assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('client sends prompt to the private adapter with its service token', async () => {
  const requests = []
  const client = new SessionControllerClient('http://127.0.0.1:18841', 'a'.repeat(32), async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'content-type': 'application/json' } })
  })
  const value = await client.prompt('jot-1', 'request-1', '你好')
  assert.equal(value.accepted, true)
  assert.equal(requests[0].init.headers.authorization, `Bearer ${'a'.repeat(32)}`)
  assert.deepEqual(JSON.parse(requests[0].init.body), { request_id: 'request-1', text: '你好', mode: 'queue' })
})

test('client sends host timing through the private native bridge without exposing a model tool', async () => {
  const requests = []
  const client = new SessionControllerClient('http://127.0.0.1:18841', 'a'.repeat(32), async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify({ ok: true, timing_id: 7 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }, 'http://127.0.0.1:18792')
  const value = await client.nativeTool('universe_crawl', {
    operation: 'record_timing', batch_id: 'batch-12345678', generation: 0,
    phase: 'model.decision', started_at: 10, finished_at: 12,
    metadata: { source: 'test' },
  }, { call_id: 'timing-1', session_ref: 'jot-test' })
  assert.equal(value.timing_id, 7)
  assert.equal(requests[0].url, 'http://127.0.0.1:18792/v2/native/tool')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    tool: 'universe_crawl',
    arguments: {
      operation: 'record_timing', batch_id: 'batch-12345678', generation: 0,
      phase: 'model.decision', started_at: 10, finished_at: 12,
      metadata: { source: 'test' },
    },
    execution: { call_id: 'timing-1', session_ref: 'jot-test' },
  })
})

test('client sends structured text image and file receipt prompt parts', async () => {
  const requests = []
  const client = new SessionControllerClient('http://127.0.0.1:18841', 'a'.repeat(32), async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'content-type': 'application/json' } })
  })
  await client.prompt('jot-1', 'request-1', [
    { type: 'text', text: '看图并读取文件' },
    { type: 'image', media_type: 'image/png', data: 'aGVsbG8=', name: '图片.png' },
    { type: 'file', receipt_id: 'receipt-1' },
  ])
  assert.deepEqual(JSON.parse(requests[0].init.body).content, [
    { type: 'text', text: '看图并读取文件' },
    { type: 'image', media_type: 'image/png', data: 'aGVsbG8=', name: '图片.png' },
    { type: 'file', receipt_id: 'receipt-1' },
  ])
})

test('client preserves only the stable adapter reason code on a rejected image prompt', async () => {
  const client = new SessionControllerClient('http://127.0.0.1:18841', 'a'.repeat(32), async () =>
    new Response(JSON.stringify({ error: 'prompt_rejected', reason_code: 'DSH_IMAGE_MODEL_UNSUPPORTED',
      detail: 'private prompt and image data' }), { status: 422,
      headers: { 'content-type': 'application/json' } }))
  await assert.rejects(client.prompt('jot-1', 'request-1', [
    { type: 'text', text: '分析图片' },
    { type: 'image', media_type: 'image/jpeg', data: 'aGVsbG8=' },
  ]), error => {
    assert.equal(error.reasonCode, 'DSH_IMAGE_MODEL_UNSUPPORTED')
    assert.equal(error.message.includes('private prompt'), false)
    return true
  })
})

test('client preserves the allow-listed Sharp native-import failure code', async () => {
  const client = new SessionControllerClient('http://127.0.0.1:18841', 'a'.repeat(32), async () =>
    new Response(JSON.stringify({ error: 'prompt_rejected', reason_code: 'DSH_IMAGE_PROCESSING_DEPENDENCY_FAILED' }), {
      status: 422, headers: { 'content-type': 'application/json' },
    }))
  await assert.rejects(client.prompt('jot-1', 'request-1', [
    { type: 'text', text: '分析图片' },
    { type: 'image', media_type: 'image/jpeg', data: 'aGVsbG8=' },
  ]), error => {
    assert.equal(error.reasonCode, 'DSH_IMAGE_PROCESSING_DEPENDENCY_FAILED')
    return true
  })
})

test('client streams a local file and base64url encodes a unicode filename', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-session-upload-'))
  try {
    const path = join(directory, '报告.txt'); writeFileSync(path, 'hello')
    const requests = []
    const client = new SessionControllerClient('http://127.0.0.1:18841', 'a'.repeat(32), async (url, init) => {
      requests.push({ url: String(url), init })
      return new Response(JSON.stringify({ receipt_id: 'receipt-1' }), { status: 201, headers: { 'content-type': 'application/json' } })
    })
    const value = await client.stageFile('jot-1', path, '报告.txt')
    assert.equal(value.receipt_id, 'receipt-1')
    assert.equal(requests[0].init.headers['x-file-name-b64'], Buffer.from('报告.txt').toString('base64url'))
    assert.equal(requests[0].init.headers['content-type'], 'application/octet-stream')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('client creates a session with the explicitly selected product preset', async () => {
  const requests = []
  const client = new SessionControllerClient('http://127.0.0.1:18841', 'a'.repeat(32), async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify({ sessionId: 'jot-1', agentPreset: 'jot-general' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    })
  })
  const value = await client.create('jot-1', '/opt/jot', 'jot-general')
  assert.equal(value.agentPreset, 'jot-general')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    session_id: 'jot-1', cwd: '/opt/jot', agent_preset: 'jot-general',
  })
})

test('client decodes ordered follow frames without parsing terminal output', async () => {
  const lines = [
    { type: 'snapshot', cursor: 4, records: [] },
    { type: 'event', event: { type: 'tool/call', seq: 5, data: { name: 'universe_search' } } },
    { type: 'event', event: { type: 'assistant/message', seq: 6, data: { message: { content: [{ type: 'text', text: '完成' }] } } } },
  ]
  const client = new SessionControllerClient('http://127.0.0.1:18841', 'a'.repeat(32), async () =>
    new Response(lines.map(value => JSON.stringify(value)).join('\n') + '\n', { status: 200 }))
  const received = []
  for await (const frame of client.follow('jot-1')) received.push(frame)
  assert.deepEqual(received, lines)
})


test('trusted Session creation carries the exact claimed Worker fence',async()=>{
 let body;const client=new SessionControllerClient('http://127.0.0.1:18841','a'.repeat(32),async(url,init)=>{body=JSON.parse(init.body);return Response.json({sessionId:'lease-session'},{status:201})});
 await client.create('lease-session','/fixture','universe-general-shadow',undefined,'run-1',{owner:'worker-1',generation:3});
 assert.deepEqual(body.workbench_context,{run_id:'run-1',execution_lease:{owner:'worker-1',generation:3}});
});
