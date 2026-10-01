import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { openProductDatabase, withImmediateTransaction } from '../../src/db/database.ts'
import { EventStore } from '../../src/events/event-store.ts'
import { buildSnapshot } from '../../src/events/snapshot.ts'
import { ContractValidator } from '../../src/contracts/validator.ts'
import { projectSessionFrame } from '../../src/harness/session-event-projector.ts'

test('snapshot restores the latest activity and assistant stream cursor from durable events', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-snapshot-live-'))
  const db = openProductDatabase(join(directory, 'db.sqlite')); const events = new EventStore(db)
  try {
    db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run('conv-1', 'owner-1', 'ws', 't', '{}', 1, 'now', 'now')
    db.prepare("INSERT INTO ga_runs(id,conversation_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run('run-1', 'conv-1', 'running', 1, 'now', 'now')
    const activity = { activity_id: 'call-1', run_id: 'run-1', tool_call_id: 'call-1', attempt_id: 'attempt-run-1',
      status: 'running', title: '正在搜索资料', started_at: '2026-09-13T00:00:00.000Z', kind: 'search',
      detail: { queries: [], source_ids: [] } }
    withImmediateTransaction(db, () => {
      events.append('conv-1', 'run-1', 'activity.upsert', activity)
      events.append('conv-1', 'run-1', 'assistant.delta', { message_id: 'stream-run-1', block_id: 'stream-run-1:0',
        kind: 'text', attempt_id: 'attempt-run-1', delta_index: 0, text: '你' })
      events.append('conv-1', 'run-1', 'assistant.delta', { message_id: 'stream-run-1', block_id: 'stream-run-1:0',
        kind: 'text', attempt_id: 'attempt-run-1', delta_index: 1, text: '好' })
    })
    const snapshot = buildSnapshot(db, 'conv-1', 'owner-1')
    assert.deepEqual(snapshot.activities, [activity])
    assert.deepEqual(snapshot.stream_cursors, [{ attempt_id: 'attempt-run-1', block_id: 'stream-run-1:0', next_delta_index: 2 }])
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('snapshot contract accepts typed browse evidence from Session projection and rejects unknown detail keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-snapshot-browse-'))
  const db = openProductDatabase(join(directory, 'db.sqlite')); const events = new EventStore(db)
  try {
    const now = '2026-09-30T00:00:00.000Z'
    db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run('conv-browse', 'owner-1', 'ws', 'browse', '{"provider":"test","model":"test"}', 1, now, now)
    db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('message-1', 'conv-browse', 'run-browse', 'user', 'complete', '{"blocks":[{"block_id":"b1","kind":"text","text":"test"}],"attachments":[]}', now, now)
    db.prepare('INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('run-browse', 'conv-browse', 'message-1', 'succeeded', 1, now, now)
    const context = { runId: 'run-browse', attemptId: 'attempt-run-browse', messageId: 'message-1',
      blockId: 'block-1', deltaIndex: 0, at: now, knownTools: new Map() }
    const call = projectSessionFrame({ type: 'event', event: { type: 'tool/call', data: { id: 'call-browse',
      name: 'universe_browse', arguments: JSON.stringify({ url: 'https://www.example.invalid/__stability__/n02.html',
        actions: [{ type: 'click', target: 'Show details' }] }) } } }, context)
    assert.equal(call?.type, 'activity.upsert')
    const resultProjection = projectSessionFrame({ type: 'event', event: { type: 'tool/result', data: { id: 'call-browse',
      result: { event_type: 'capability_result', capability: 'browse', outcome: 'success', data: { interaction_trace: [
        { action: { type: 'click' }, verification: { status: 'NO_EFFECT' } },
      ] } } } } }, context)
    assert.equal(resultProjection?.type, 'activity.upsert')
    const activity = resultProjection.payload
    assert.deepEqual(activity.detail.requested_action_types, ['click'])
    assert.deepEqual(activity.detail.traced_action_types, ['click'])
    assert.deepEqual(activity.detail.verification_statuses, ['NO_EFFECT'])
    assert.equal(activity.detail.browse_outcome, 'success')
    assert.equal(activity.detail.action_trace_count, 1)
    withImmediateTransaction(db, () => events.append('conv-browse', 'run-browse', 'activity.upsert', activity))
    const snapshot = buildSnapshot(db, 'conv-browse', 'owner-1')
    const validator = new ContractValidator()
    const operation = validator.operationFor('GET', '/v1/conversations/:conversationId/snapshot')
    const result = validator.validateResponse(operation, 200, snapshot)
    assert.equal(result.valid, true, JSON.stringify(result.errors.map(({ instancePath, message, params }) => ({ instancePath, message, params }))))

    const document = JSON.parse(readFileSync(new URL('../../contracts/agent-event.schema.json', import.meta.url)))
    const ajv = new Ajv2020({ strict: false }); addFormats(ajv)
    const validate = ajv.compile({ $defs: document.$defs, $ref: '#/$defs/Activity' })
    assert.equal(validate(activity), true, JSON.stringify(validate.errors))

    const invalid = structuredClone(snapshot); invalid.activities[0].detail.unreviewed_free_text = 'must remain rejected'
    assert.equal(validator.validateResponse(operation, 200, invalid).valid, false)
    assert.equal(validate(invalid.activities[0]), false)
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})
