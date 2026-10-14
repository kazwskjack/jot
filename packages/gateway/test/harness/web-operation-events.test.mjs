import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openProductDatabase } from '../../src/db/database.ts'
import { EventStore } from '../../src/events/event-store.ts'
import { buildSnapshot } from '../../src/events/snapshot.ts'
import { RunRepository } from '../../src/runs/repository.ts'
import { HarnessCoordinator } from '../../src/harness/coordinator.ts'
import { OfficialSessionRunner } from '../../src/harness/official-session-runner.ts'

test('C batch revisions project once into the durable Jot activity stream and resume by cursor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-web-operation-events-'))
  const db = openProductDatabase(join(directory, 'db.sqlite'))
  const events = new EventStore(db)
  const runs = new RunRepository(db, events)
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('conv', 'owner', 'ws', 'title', '{}', 1, 'now', 'now')
  const receipt = runs.enqueue('conv', 'owner', { client_message_id: 'm', content: [{ type: 'text', text: 'read pages' }] })
  const coordinator = new HarnessCoordinator(db, runs, events)
  const lease = coordinator.claimNext('worker', 30_000)
  coordinator.start(lease)
  const sessionRef = `runtime-session-${'a'.repeat(32)}`
  coordinator.bindSession(lease, sessionRef)
  const snapshot = {
    ok: true, operation_id: `web-${'a'.repeat(32)}`, kind: 'read_page', status: 'running', revision: 3,
    event_cursor: 3, events: [1, 2, 3].map(revision => ({ revision, event_type: 'item.updated', payload: {} })),
    accepted_count: 2, counts: { running: 1, succeeded: 1 },
    items: [
      { item_id: 'one', position: 0, inputs: { url: 'https://example.com/a' }, status: 'succeeded', attempt: 1, result_ref: 'a'.repeat(32) },
      { item_id: 'two', position: 1, inputs: { url: 'https://example.org/b' }, status: 'running', attempt: 1, result_ref: null },
    ],
  }
  try {
    const cursor = coordinator.recordWebOperationSnapshot(lease, sessionRef, 'dsh-call-1', snapshot)
    assert.equal(cursor, 3)
    assert.deepEqual({...db.prepare('SELECT last_status,items_settled FROM ga_web_operation_cursors').get()}, {last_status:'running',items_settled:0})
    let rows = db.prepare("SELECT payload_json FROM ga_events WHERE run_id=? AND type='activity.upsert'").all(receipt.run_id)
    assert.equal(rows.length, 1)
    let activity = JSON.parse(rows[0].payload_json)
    assert.equal(activity.activity_id, 'dsh-call-1')
    assert.equal(activity.detail.revision, 3)
    assert.equal(activity.detail.request_id, 'dsh-call-1')
    assert.equal(activity.detail.generation, 1)
    assert.deepEqual(activity.detail.items.map(item => item.status), ['succeeded', 'running'])
    assert.deepEqual(activity.detail.items[0], {
      item_id: 'one', position: 0, url: 'https://example.com/a', status: 'succeeded',
      attempt: 1, result_ref: 'a'.repeat(32), action_label: '读取页面',
    })
    assert.equal(activity.title, '正在读取网页')
    assert.equal(activity.detail.action, 'read')
    assert.equal(activity.detail.items[0].action_label, '读取页面')
    assert.equal(buildSnapshot(db, 'conv', 'owner').activities.length, 1)

    assert.equal(coordinator.recordWebOperationSnapshot(lease, sessionRef, 'dsh-call-1', snapshot), 3)
    rows = db.prepare("SELECT payload_json FROM ga_events WHERE run_id=? AND type='activity.upsert'").all(receipt.run_id)
    assert.equal(rows.length, 1)

    const finalSnapshot = { ...snapshot, status: 'partial', revision: 4, event_cursor: 4,
      events: [{ revision: 4, event_type: 'item.updated', payload: {} }],
      counts: { succeeded: 1, failed: 1 },
      items: snapshot.items.map((item, index) => index ? { ...item, status: 'failed', reason_code: 'PAGE_TIMEOUT' } : item) }
    assert.equal(coordinator.recordWebOperationSnapshot(lease, sessionRef, 'dsh-call-1', finalSnapshot), 4)
    assert.deepEqual({...db.prepare('SELECT last_status,items_settled FROM ga_web_operation_cursors').get()}, {last_status:'partial',items_settled:1})
    coordinator.recordWebOperationSnapshot(lease, sessionRef, 'dsh-call-1', snapshot)
    assert.equal(db.prepare('SELECT items_settled FROM ga_web_operation_cursors').get().items_settled,1)
    rows = db.prepare("SELECT payload_json FROM ga_events WHERE run_id=? AND type='activity.upsert' ORDER BY seq").all(receipt.run_id)
    assert.equal(rows.length, 2)
    activity = JSON.parse(rows[1].payload_json)
    assert.equal(activity.status, 'partial')
    assert.equal(activity.detail.items[1].reason_code, 'PAGE_TIMEOUT')
    const pageSnapshot = buildSnapshot(db, 'conv', 'owner')
    assert.equal(pageSnapshot.activities.length, 1)
    assert.equal(pageSnapshot.activities[0].status, 'partial')
    assert.equal(db.prepare('SELECT last_revision FROM ga_web_operation_cursors WHERE run_id=? AND tool_call_id=?')
      .get(receipt.run_id, 'dsh-call-1').last_revision, 4)

    const terminalItems = finalSnapshot.items
    const incompleteEvidence = [
      { accepted_count: undefined, items: terminalItems },
      { accepted_count: null, items: terminalItems },
      { accepted_count: '2', items: terminalItems },
      { accepted_count: 3, items: terminalItems },
      { accepted_count: 2, items: [terminalItems[0], terminalItems[0]] },
      { accepted_count: 2, items: [terminalItems[0], { ...terminalItems[1], position: 0 }] },
    ]
    for (const [index, evidence] of incompleteEvidence.entries()) {
      const callId = `incomplete-${index}`
      coordinator.recordWebOperationSnapshot(lease, sessionRef, callId, {
        ...finalSnapshot, ...evidence, revision: 1, event_cursor: 1,
        events: [{ revision: 1, event_type: 'item.updated', payload: {} }],
      })
      assert.equal(db.prepare('SELECT items_settled FROM ga_web_operation_cursors WHERE tool_call_id=?')
        .get(callId).items_settled, 0, `incomplete evidence ${index} cannot release handoff`)
      coordinator.recordWebOperationSnapshot(lease, sessionRef, callId, {
        ...finalSnapshot, revision: 2, event_cursor: 2,
        events: [{ revision: 2, event_type: 'item.updated', payload: {} }],
      })
      assert.equal(db.prepare('SELECT items_settled FROM ga_web_operation_cursors WHERE tool_call_id=?')
        .get(callId).items_settled, 1, 'new complete evidence releases the observation barrier')
    }

    const taintedSnapshot = { ...snapshot, operation_id: `web-${'b'.repeat(32)}`, status: 'private status',
      revision: 1, event_cursor: 1, events: [{ revision: 1, event_type: 'item.updated', payload: {} }],
      counts: { succeeded: 1, private_count: 88 },
      items: [{ item_id: 'private item id', position: 0,
        inputs: { url: 'https://example.test/path?q=private#section' }, status: 'succeeded private',
        reason_code: 'PRIVATE USER TEXT', result_ref: 'private result token' }] }
    assert.equal(coordinator.recordWebOperationSnapshot(lease, sessionRef, 'dsh-call-tainted', taintedSnapshot), 1)
    const taintedActivity = JSON.parse(db.prepare("SELECT payload_json FROM ga_events WHERE run_id=? AND type='activity.upsert' ORDER BY seq DESC LIMIT 1")
      .get(receipt.run_id).payload_json)
    assert.equal(taintedActivity.status, 'unknown')
    assert.equal(taintedActivity.detail.operation_status, 'unknown')
    assert.deepEqual(taintedActivity.detail.counts, { succeeded: 1 })
    assert.equal(taintedActivity.detail.items[0].item_id, 'item-0')
    assert.equal(taintedActivity.detail.items[0].status, 'unknown')
    assert.equal(taintedActivity.detail.items[0].url, 'https://example.test/path?q=private#section')
    assert.equal(taintedActivity.detail.items[0].reason_code, undefined)
    assert.equal(taintedActivity.detail.items[0].result_ref, undefined)
    assert.doesNotMatch(JSON.stringify(taintedActivity), /private status|private_count|private item id|PRIVATE USER TEXT|private result token/)

    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1
    const beforeInvalid = db.prepare("SELECT COUNT(*) AS n FROM ga_events WHERE run_id=? AND type='activity.upsert'")
      .get(receipt.run_id).n
    assert.throws(() => coordinator.recordWebOperationSnapshot(lease, sessionRef, 'unsafe-revision', {
      ...snapshot, operation_id: `web-${'d'.repeat(32)}`, revision: unsafeInteger, event_cursor: 0, events: [],
    }), /web_operation_snapshot_invalid/)
    assert.throws(() => coordinator.recordWebOperationSnapshot(lease, sessionRef, 'unsafe-cursor', {
      ...snapshot, operation_id: `web-${'f'.repeat(32)}`, revision: 1, event_cursor: unsafeInteger, events: [],
    }), /web_operation_snapshot_invalid/)
    assert.throws(() => coordinator.recordWebOperationSnapshot(lease, sessionRef, 'string-revision', {
      ...snapshot, operation_id: `web-${'1'.repeat(32)}`, revision: '1', event_cursor: 0, events: [],
    }), /web_operation_snapshot_invalid/)
    assert.throws(() => coordinator.recordWebOperationSnapshot(lease, sessionRef, 'boolean-cursor', {
      ...snapshot, operation_id: `web-${'2'.repeat(32)}`, revision: 1, event_cursor: false, events: [],
    }), /web_operation_snapshot_invalid/)
    assert.throws(() => coordinator.recordWebOperationSnapshot(lease, sessionRef, 'unsafe-event-revision', {
      ...snapshot, operation_id: `web-${'e'.repeat(32)}`, revision: 1, event_cursor: 1,
      events: [{ revision: unsafeInteger, event_type: 'item.updated', payload: {} }],
    }), /web_operation_event_invalid/)
    assert.throws(() => coordinator.recordWebOperationSnapshot(lease, sessionRef, 'string-event-revision', {
      ...snapshot, operation_id: `web-${'3'.repeat(32)}`, revision: 1, event_cursor: 1,
      events: [{ revision: '1', event_type: 'item.updated', payload: {} }],
    }), /web_operation_event_invalid/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ga_web_operation_cursors').get().n, 2 + incompleteEvidence.length)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ga_events WHERE run_id=? AND type='activity.upsert'")
      .get(receipt.run_id).n, beforeInvalid)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('empty C event page at an already persisted cursor is an idempotent poll, not a bridge error', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-web-operation-empty-page-'))
  const db = openProductDatabase(join(directory, 'db.sqlite'))
  const events = new EventStore(db)
  const runs = new RunRepository(db, events)
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('conv', 'owner', 'ws', 'title', '{}', 1, 'now', 'now')
  const receipt = runs.enqueue('conv', 'owner', { client_message_id: 'm', content: [{ type: 'text', text: 'read pages' }] })
  const coordinator = new HarnessCoordinator(db, runs, events)
  const lease = coordinator.claimNext('worker', 30_000)
  coordinator.start(lease)
  const sessionRef = `runtime-session-${'d'.repeat(32)}`
  coordinator.bindSession(lease, sessionRef)
  const base = {
    operation_id: `web-${'c'.repeat(32)}`, kind: 'read_page', status: 'running', revision: 3,
    accepted_count: 1, counts: { running: 1 },
    items: [{ item_id: 'one', position: 0, inputs: { url: 'https://example.com/' }, status: 'running', attempt: 1 }],
  }
  try {
    assert.equal(coordinator.recordWebOperationSnapshot(lease, sessionRef, 'call-1', {
      ...base, event_cursor: 3,
      events: [1, 2, 3].map(revision => ({ revision, event_type: 'item.updated', payload: {} })),
    }), 3)
    assert.equal(coordinator.recordWebOperationSnapshot(lease, sessionRef, 'call-1', {
      ...base, event_cursor: 3, events: [],
    }), 3)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ga_events WHERE run_id=? AND type='activity.upsert'")
      .get(receipt.run_id).n, 1)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('execute batch confirmation is projected as a web operation, not a page read', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-web-operation-execute-'))
  const db = openProductDatabase(join(directory, 'db.sqlite'))
  const events = new EventStore(db)
  const runs = new RunRepository(db, events)
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('conv', 'owner', 'ws', 'title', '{}', 1, 'now', 'now')
  const receipt = runs.enqueue('conv', 'owner', { client_message_id: 'm', content: [{ type: 'text', text: 'submit forms' }] })
  const coordinator = new HarnessCoordinator(db, runs, events)
  const lease = coordinator.claimNext('worker', 30_000)
  coordinator.start(lease)
  const sessionRef = `runtime-session-${'c'.repeat(32)}`
  coordinator.bindSession(lease, sessionRef)
  try {
    coordinator.recordWebOperationSnapshot(lease, sessionRef, 'execute-call', {
      operation_id: `web-${'f'.repeat(32)}`, kind: 'execute', status: 'waiting_confirmation',
      revision: 1, event_cursor: 1, events: [{ revision: 1, event_type: 'operation.accepted', payload: {} }],
      accepted_count: 1, counts: { waiting: 1 },
      items: [{ item_id: 'submit-a', position: 0, inputs: { url: 'https://example.test/form' }, status: 'waiting' }],
    })
    const activity = JSON.parse(db.prepare("SELECT payload_json FROM ga_events WHERE run_id=? AND type='activity.upsert'")
      .get(receipt.run_id).payload_json)
    assert.equal(activity.title, '网页操作等待确认')
    assert.equal(activity.detail.action, 'execute')
    assert.equal(activity.detail.operation, 'execute')
    assert.equal(activity.detail.items[0].action_label, '网页操作')
    assert.equal(activity.status, 'waiting')
    assert.equal(activity.detail.items[0].url, undefined)
    assert.deepEqual(activity.detail.urls, [])
    assert.doesNotMatch(JSON.stringify(activity), /example\.test\/form/)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('batch event ingestion rejects a mismatched Session binding without persisting', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-web-operation-owner-'))
  const db = openProductDatabase(join(directory, 'db.sqlite'))
  const events = new EventStore(db)
  const runs = new RunRepository(db, events)
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('conv', 'owner', 'ws', 'title', '{}', 1, 'now', 'now')
  const receipt = runs.enqueue('conv', 'owner', { client_message_id: 'm', content: [{ type: 'text', text: 'read pages' }] })
  const coordinator = new HarnessCoordinator(db, runs, events)
  const lease = coordinator.claimNext('worker', 30_000)
  coordinator.start(lease)
  coordinator.bindSession(lease, 'trusted-session')
  try {
    assert.throws(() => coordinator.recordWebOperationSnapshot(lease, 'other-session', 'call-1', {
      operation_id: 'web-1', status: 'running', revision: 1, event_cursor: 1, events: [], items: [],
    }), /session_binding/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ga_web_operation_cursors').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ga_events WHERE run_id=? AND type=\'activity.upsert\'').get(receipt.run_id).n, 0)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('runner persists each durable batch revision exactly once to the Jot event stream', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-web-operation-runner-'))
  const db = openProductDatabase(join(directory, 'db.sqlite'))
  const events = new EventStore(db)
  const runs = new RunRepository(db, events)
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('conv', 'owner', 'ws', 'title', '{}', 1, 'now', 'now')
  const receipt = runs.enqueue('conv', 'owner', { client_message_id: 'm', content: [{ type: 'text', text: 'read pages' }] })
  const coordinator = new HarnessCoordinator(db, runs, events)
  const lease = coordinator.claimNext('worker', 30_000)
  coordinator.start(lease)
  const sessionRef = `runtime-session-${'b'.repeat(32)}`
  coordinator.bindSession(lease, sessionRef)
  const operationId = `web-${'d'.repeat(32)}`
  const running = { operation_id: operationId, kind: 'read_page', status: 'running', revision: 2,
    event_cursor: 2, events: [1, 2].map(revision => ({ revision, event_type: 'item.updated', payload: {} })),
    accepted_count: 2, counts: { succeeded: 1, running: 1 }, items: [
      { item_id: 'one', position: 0, inputs: { url: 'https://example.com/a' }, status: 'succeeded', result_ref: 'e'.repeat(32) },
      { item_id: 'two', position: 1, inputs: { url: 'https://example.org/b' }, status: 'running' },
    ] }
  const final = { ...running, status: 'partial', revision: 3, event_cursor: 3,
    events: [{ revision: 3, event_type: 'item.updated', payload: {} }],
    counts: { succeeded: 1, failed: 1 }, items: [running.items[0],
      { ...running.items[1], status: 'failed', reason_code: 'PAGE_TIMEOUT' }] }
  let statePoll = 0
  const client = {
    create: async () => ({ sessionId: 's' }),
    prompt: async () => ({ accepted: true }),
    nativeTool: async () => statePoll++ === 0 ? running : final,
    async *follow() {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield { type: 'event', event: { type: 'tool/call', seq: 1, data: {
        callId: 'dsh-call-batch', name: 'universe_read_page',
        arguments: { urls: ['https://example.com/a', 'https://example.org/b'] },
      } } }
      await new Promise(resolve => setTimeout(resolve, 20))
      yield { type: 'event', event: { type: 'tool/result', seq: 2, data: { callId: 'dsh-call-batch' } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 3,
        data: { message: { content: [{ type: 'text', text: 'Done.' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } } }
    },
  }
  const runner = new OfficialSessionRunner(client, {
    cwd: '/opt/jot', agentPreset: 'jot-general', webOperationPollIntervalMs: 100,
  })
  try {
    await runner.run({ enabled: true, taskRequestId: receipt.run_id, message: 'read pages',
      sessionRef: 'controller-session', universeSessionRef: sessionRef, deferCompletionProbe: true,
      onWebOperationCursor: callId => coordinator.webOperationCursor(lease, sessionRef, callId),
      onWebOperationSnapshot: (callId, snapshot) =>
        coordinator.recordWebOperationSnapshot(lease, sessionRef, callId, snapshot),
      onProjection: projection => coordinator.recordProjection(lease, projection),
    })
    const projected = db.prepare("SELECT payload_json FROM ga_events WHERE run_id=? AND type='activity.upsert' ORDER BY seq")
      .all(receipt.run_id).map(row => JSON.parse(row.payload_json))
      .filter(value => value.detail?.operation_id === operationId)
    assert.equal(projected.length, 2)
    assert.deepEqual(projected.map(value => value.detail.revision), [2, 3])
    assert.equal(projected[0].detail.items[1].status, 'running')
    assert.equal(projected[1].detail.items[1].reason_code, 'PAGE_TIMEOUT')
    const pageSnapshot = buildSnapshot(db, 'conv', 'owner')
    assert.equal(pageSnapshot.activities.length, 1)
    const finalActivity = pageSnapshot.activities[0]
    assert.equal(finalActivity.status, 'partial')
    assert.equal(finalActivity.detail.operation_id, operationId)
    assert.deepEqual(finalActivity.detail.items.map(item => item.item_id), ['one', 'two'])
    assert.deepEqual(finalActivity.detail.items.map(item => item.url), [
      'https://example.com/a', 'https://example.org/b',
    ])
    assert.equal(finalActivity.detail.items[0].result_ref, 'e'.repeat(32))
    assert.equal(finalActivity.detail.items[1].reason_code, 'PAGE_TIMEOUT')
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
