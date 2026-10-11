import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openProductDatabase } from '../../src/db/database.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { RunRepository } from '../../src/runs/repository.ts';
import { HarnessCoordinator } from '../../src/harness/coordinator.ts';
import { HarnessWorker } from '../../src/harness/worker.ts';
import {ModelBudgetLedger} from '../../src/workbench/model-budget.ts';

function fixture(text, content) {
  const directory = mkdtempSync(join(tmpdir(), 'ga-worker-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  const events = new EventStore(db); const runs = new RunRepository(db, events);
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv-1', 'owner-1', 'ws', 't', '{}', 1, 'now', 'now');
  const receipt = runs.enqueue('conv-1', 'owner-1', { client_message_id: 'm1',
    content: content ?? [{ type: 'text', text }] });
  return { directory, db, events, runs, receipt };
}

function addArtifact(x, artifactId = 'artifact-output', version = 5) {
  const now = new Date().toISOString()
  x.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(artifactId, 'conv-1', 'owner-1', 'upload', version, now, now)
  x.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(artifactId, version, '/safe/version-5.docx', 'a'.repeat(64), 21172,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      JSON.stringify({ file_name: '修改版.docx', status: 'ready' }), now)
}

test('worker does not overwrite cancelling with interrupted when DSH ends',async()=>{
 const x=fixture('stop');try{
 const worker=new HarnessWorker(x.db,new HarnessCoordinator(x.db,x.runs,x.events),{run:async input=>{
  input.onReady();assert.equal(worker.isReady(x.receipt.run_id),true);
  x.db.prepare("UPDATE ga_runs SET status='cancelling' WHERE id=?").run(x.receipt.run_id);
  return {observed:true,completed:false,reason_code:'SESSION_TURN_INTERRUPTED',runtime_status:'not_required'};
 }},{workerId:'worker-1',leaseMs:30000});
 await worker.processNext();assert.equal(x.runs.get(x.receipt.run_id,'owner-1').status,'cancelling');assert.equal(worker.isReady(x.receipt.run_id),false);
 }finally{x.db.close();rmSync(x.directory,{recursive:true,force:true})}
});

test('Harness final text completes ordinary chat without Runtime completion gating', async () => {
  const x = fixture('你好');
  try {
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events), {
      run: async () => ({ observed: true, completed: false, reason_code: 'DSH_CHAT_ANSWER',
        runtime_status: 'not_required', tool_marker: false, final_text: '你好！有什么我可以帮你的？' }),
    }, { workerId: 'worker-1', leaseMs: 30_000 });
    await worker.processNext();
    assert.equal(x.runs.get(x.receipt.run_id, 'owner-1').status, 'succeeded');
    const row = x.db.prepare("SELECT content_json FROM ga_messages WHERE run_id=? AND role='assistant'").get(x.receipt.run_id);
    assert.equal(JSON.parse(row.content_json).blocks[0].text, '你好！有什么我可以帮你的？');
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
});

test('terminal publication releases its exact lease and rejects a late callback',()=>{
 const x=fixture('Lease lifecycle');try{
  const coordinator=new HarnessCoordinator(x.db,x.runs,x.events),lease=coordinator.claimNext('terminal-worker',30000);
  coordinator.start(lease);coordinator.recordAssistant(lease,'Original answer');
  coordinator.finalizePublication(lease,'succeeded',null);
  assert.equal(x.runs.get(lease.run_id,'owner-1').status,'succeeded');
  assert.equal(x.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(lease.run_id).n,0);
  assert.throws(()=>coordinator.recordAssistant(lease,'Late duplicate'),/worker_fence_rejected/);
  assert.equal(x.db.prepare("SELECT count(*) n FROM ga_messages WHERE run_id=? AND role='assistant'").get(lease.run_id).n,1);
 }finally{x.db.close();rmSync(x.directory,{recursive:true,force:true});}
});

test('failed terminal publication rolls back status and retains the original retry lease',()=>{
 const x=fixture('Publication rollback');try{
  const coordinator=new HarnessCoordinator(x.db,x.runs,x.events),lease=coordinator.claimNext('retry-worker',30000);
  coordinator.start(lease);
  x.db.exec("CREATE TEMP TRIGGER reject_terminal_event BEFORE INSERT ON ga_events WHEN NEW.type='run.state' BEGIN SELECT RAISE(ABORT,'fixture_publication_failure'); END");
  assert.throws(()=>coordinator.finalizePublication(lease,'succeeded',null),/fixture_publication_failure/);
  assert.equal(x.runs.get(lease.run_id,'owner-1').status,'running');
  assert.equal(x.db.prepare('SELECT generation FROM ga_worker_leases WHERE resource_id=?').get(lease.run_id).generation,lease.generation);
  x.db.exec('DROP TRIGGER reject_terminal_event');
  coordinator.finalizePublication(lease,'running',null);
  assert.equal(x.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(lease.run_id).n,1);
  coordinator.finalizePublication(lease,'succeeded',null);
  assert.equal(x.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(lease.run_id).n,0);
 }finally{x.db.close();rmSync(x.directory,{recursive:true,force:true});}
});

test('background task cannot publish or notify an intermediate answer when its runner has not completed',async()=>{
 const x=fixture('Persistent task');let deliveries=0;
 x.db.prepare('INSERT INTO ga_channel_bindings(channel,principal,conversation_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('wecom','fixture-recipient','conv-1','now','now');
 try{
  const worker=new HarnessWorker(x.db,new HarnessCoordinator(x.db,x.runs,x.events),{
   run:async input=>{assert.equal(input.checkpointTask,true);return {observed:true,completed:false,reason_code:'SESSION_GOAL_PAUSED',runtime_status:'not_required',final_text:'Intermediate answer awaiting review'};},
  },{workerId:'worker-1',leaseMs:30000,executionGuard:{assertRunActive:()=>{},contextForRun:()=>({kind:'task'})},channelDelivery:{enqueueText:()=>{deliveries++;}}});
  await worker.processNext();
  assert.equal(x.runs.get(x.receipt.run_id,'owner-1').status,'interrupted');
  assert.equal(x.db.prepare("SELECT count(*) n FROM ga_messages WHERE run_id=? AND role='assistant'").get(x.receipt.run_id).n,0);
  assert.equal(deliveries,0);
 }finally{x.db.close();rmSync(x.directory,{recursive:true,force:true});}
});

test('Harness enqueues the final assistant text for a bound WeCom channel', async () => {
  const x = fixture('需要登录'); const deliveries = [];
  x.db.prepare('INSERT INTO ga_channel_bindings(channel,principal,conversation_id,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('wecom', 'user-1', 'conv-1', 'now', 'now');
  try {
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events), {
      run: async () => ({ observed: true, completed: false, reason_code: 'LOGIN_REQUIRED',
        runtime_status: 'not_required', final_text: '需要登录：请打开登录链接。' }),
    }, { workerId: 'worker-1', leaseMs: 30_000,
      channelDelivery: { enqueueText: input => deliveries.push(input) } });
    await worker.processNext();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].recipient, 'user-1');
    assert.equal(deliveries[0].text, '需要登录：请打开登录链接。');
    assert.match(deliveries[0].messageId, /^msg-/);
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
});

test('worker resolves owned message attachments, passes them to DSH, and releases its lease', async () => {
  const x = fixture('', [{ type: 'file', artifact_id: 'artifact-1' }]); const calls = []
  try {
    const attachment = { artifactId: 'artifact-1', displayName: '图.png', mediaType: 'image/png',
      sizeBytes: 8, sha256: 'x', localPath: 'safe.png', kind: 'image' }
    const resolver = {
      resolveForMessage: (...args) => { calls.push(['resolve', ...args]); return [attachment] },
      releaseLease: value => calls.push(['release', value]),
    }
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events), {
      run: async input => { calls.push(['run', input]); return { observed: true, completed: true,
        reason_code: 'SESSION_TURN_COMPLETED', runtime_status: 'not_required', final_text: '图片内容' } },
    }, { workerId: 'worker-1', leaseMs: 30_000, attachmentResolver: resolver })
    await worker.processNext()
    assert.deepEqual(calls[0], ['resolve', 'owner-1', 'conv-1', ['artifact-1'], x.receipt.run_id])
    assert.deepEqual(calls[1][1].attachments, [attachment])
    assert.deepEqual(calls[2], ['release', x.receipt.run_id])
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
})

test('worker separates Runtime session identity from DSH/Universe owner identity', async () => {
  const x = fixture('继续'); const refs = []; const universeRefs = []; const staged = [];
  try {
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events), {
      run: async input => { refs.push(input.sessionRef); universeRefs.push(input.universeSessionRef); return { observed: true, completed: false,
        reason_code: 'SESSION_COMPLETED', runtime_status: 'not_required', final_text: '完成' }; },
    }, { workerId: 'worker-1', leaseMs: 30_000, sessionResolver: conversationId => `jot-${conversationId}`,
      contextStager: { stageContext: async input => { staged.push(input); return { ok: true }; } } });
    await worker.processNext();
    assert.deepEqual(refs, ['jot-conv-1']);
    assert.deepEqual(universeRefs, ['jot-conv-1']);
    assert.equal(staged[0].controllerSessionRef, 'jot-conv-1');
    assert.notEqual(staged[0].sessionRef, 'jot-conv-1');
    assert.match(staged[0].sessionRef, /^runtime-session-[0-9a-f]{32}$/);
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
});

test('tool use does not turn Runtime completion into a publication gate', async () => {
  const x = fixture('搜索 AI'); let staged = 0;
  try {
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events), {
      run: async () => ({ observed: true, completed: false, reason_code: 'DSH_RUNTIME_PENDING',
        runtime_status: 'completion_ineligible', tool_marker: true, final_text: '已找到相关资料。' }),
    }, { workerId: 'worker-1', leaseMs: 30_000,
      contextStager: { stageContext: async () => { staged += 1; return { ok: true }; } } });
    const result = await worker.processNext();
    assert.equal(staged, 1); assert.equal(result.runtime_status, 'runtime_observed');
    assert.equal(x.runs.get(x.receipt.run_id, 'owner-1').status, 'succeeded');
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
});

test('Runtime context staging failure does not block ordinary Harness conversation', async () => {
  const x = fixture('你好'); let runnerCalls = 0;
  try {
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events),
      { run: async () => { runnerCalls += 1; return { observed: true, completed: false,
        reason_code: 'DSH_CHAT_ANSWER', runtime_status: 'not_required', tool_marker: false,
        final_text: '你好！' }; } },
      { workerId: 'worker-1', leaseMs: 30_000,
        contextStager: { stageContext: async () => { throw new Error('runtime_context_stage_http_503'); } } });
    await worker.processNext();
    assert.equal(runnerCalls, 1); assert.equal(x.runs.get(x.receipt.run_id, 'owner-1').status, 'succeeded');
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
});

test('missing Harness final text interrupts instead of publishing an empty answer', async () => {
  const x = fixture('你好');
  try {
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events),
      { run: async () => ({ observed: false, completed: false,
        reason_code: 'DSH_PROCESS_FAILED', runtime_status: 'DSH_PROCESS_FAILED' }) },
      { workerId: 'worker-1', leaseMs: 30_000 });
    await worker.processNext();
    assert.equal(x.runs.get(x.receipt.run_id, 'owner-1').status, 'interrupted');
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
});

test('Session runner failure interrupts the run and releases attachment leases', async () => {
  const x = fixture('', [{ type: 'file', artifact_id: 'artifact-1' }]); const released = [];
  try {
    const resolver = {
      resolveForMessage: () => [{ artifactId: 'artifact-1', displayName: '图.png', mediaType: 'image/png',
        sizeBytes: 8, sha256: 'x', localPath: 'safe.png', kind: 'image' }],
      releaseLease: value => released.push(value),
    };
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events), {
      run: async () => { throw new Error('session_adapter_http_500:adapter_internal_error'); },
    }, { workerId: 'worker-1', leaseMs: 30_000, attachmentResolver: resolver });
    const result = await worker.processNext();
    assert.equal(result.runtime_status, 'harness_failed');
    assert.equal(x.runs.get(x.receipt.run_id, 'owner-1').status, 'interrupted');
    assert.deepEqual(released, [x.receipt.run_id]);
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
});

test('worker persists a safe prompt-admission reason instead of collapsing it to the generic runtime code', async () => {
  const x = fixture('', [{ type: 'file', artifact_id: 'artifact-1' }]);
  try {
    const failure = new Error('session_adapter_http_422:prompt_rejected')
    failure.reasonCode = 'DSH_IMAGE_MODEL_UNSUPPORTED'
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events), {
      run: async () => { throw failure; },
    }, { workerId: 'worker-1', leaseMs: 30_000,
      attachmentResolver: { resolveForMessage: () => [{ artifactId: 'artifact-1', displayName: 'img.jpg',
        mediaType: 'image/jpeg', sizeBytes: 8, sha256: 'x', localPath: 'safe.jpg', kind: 'image' }],
        releaseLease: () => {} } });
    await worker.processNext();
    assert.equal(x.runs.get(x.receipt.run_id, 'owner-1').error_code, 'DSH_IMAGE_MODEL_UNSUPPORTED');
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
});

test('worker persists live Session projections before the canonical assistant message', async () => {
  const x = fixture('搜索 AI');
  try {
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events), {
      run: async input => {
        await input.onProjection({ type: 'assistant.delta', payload: { message_id: `stream-${input.taskRequestId}`,
          block_id: `stream-${input.taskRequestId}:0`, kind: 'text', attempt_id: `attempt-${input.taskRequestId}`,
          delta_index: 0, text: '正在查找' } });
        return { observed: true, completed: true, reason_code: 'SESSION_TURN_COMPLETED',
          runtime_status: 'runtime_observed', final_text: '找到了', tool_marker: true };
      },
    }, { workerId: 'worker-1', leaseMs: 30_000 });
    await worker.processNext();
    const events = x.events.replay('conv-1', 0, 100);
    const deltaIndex = events.findIndex(event => event.type === 'assistant.delta');
    const finalIndex = events.findIndex(event => event.type === 'message.created'
      && event.payload.role === 'assistant');
    assert.ok(deltaIndex >= 0); assert.ok(finalIndex > deltaIndex);
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
});

test('worker preserves settled reasoning and final text as separate message blocks', async () => {
  const x = fixture('请分析');
  try {
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events), {
      run: async () => ({ observed: true, completed: true, reason_code: 'SESSION_TURN_COMPLETED',
        runtime_status: 'not_required', final_text: '最终答案', final_blocks: [
          { kind: 'reasoning', text: '分析过程' }, { kind: 'text', text: '最终答案' },
        ] }),
    }, { workerId: 'worker-1', leaseMs: 30_000 });
    await worker.processNext();
    const row = x.db.prepare("SELECT content_json FROM ga_messages WHERE run_id=? AND role='assistant'").get(x.receipt.run_id);
    assert.deepEqual(JSON.parse(row.content_json).blocks.map(block => [block.kind, block.text, block.exposure]), [
      ['reasoning', '分析过程', 'provider'], ['text', '最终答案', 'public'],
    ]);
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
});

test('worker validates generated outputs and attaches them to the canonical assistant message', async () => {
  const x = fixture('修改文档'); const calls = []
  try {
    addArtifact(x, 'artifact-123', 5)
    const resolver = {
      resolveForMessage: () => [], releaseLease: value => calls.push(['release', value]),
      resolveOutputs: (...args) => { calls.push(['resolveOutputs', ...args]); return [
        { artifactId: 'artifact-123', displayName: '结果.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 100, sha256: 'a'.repeat(64), localPath: '/safe/final.docx', kind: 'document', version: 5 },
      ] },
    }
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events), {
      run: async () => ({ observed: true, completed: true, reason_code: 'SESSION_TURN_COMPLETED',
        runtime_status: 'runtime_observed', final_text: '已完成。', output_artifact_refs: ['artifact-123'],
        presented_files: [{ path: '/safe/final.docx' }] }),
    }, { workerId: 'worker-1', leaseMs: 30_000, attachmentResolver: resolver })
    await worker.processNext()
    const row = x.db.prepare("SELECT content_json FROM ga_messages WHERE run_id=? AND role='assistant'").get(x.receipt.run_id)
    assert.deepEqual(JSON.parse(row.content_json).attachments, ['artifact-123'])
    assert.equal(calls[0][0], 'resolveOutputs')
    assert.deepEqual(calls.at(-1), ['release', `${x.receipt.run_id}:outputs`])
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
})

test('worker persists a verified output artifact when final prose is interrupted', async () => {
  const x = fixture('修改文档')
  try {
    addArtifact(x)
    const output = { artifactId: 'artifact-output', displayName: '修改版.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 21172, sha256: 'a'.repeat(64), localPath: '/safe/version-5.docx', kind: 'document', version: 5 }
    const released = []
    const resolver = {
      resolveForMessage: () => [],
      resolveOutputs: (_owner, _conversation, refs) => {
        assert.deepEqual(refs, ['artifact-output'])
        return [output]
      },
      releaseLease: value => released.push(value),
    }
    const worker = new HarnessWorker(x.db, new HarnessCoordinator(x.db, x.runs, x.events), {
      run: async input => {
        await input.onArtifactRef('artifact-output')
        return { observed: true, completed: false, reason_code: 'SESSION_CONTEXT_WINDOW_EXCEEDED',
          runtime_status: 'runtime_observed', output_artifact_refs: ['artifact-output'], tool_marker: true }
      },
    }, { workerId: 'worker-1', leaseMs: 30_000, attachmentResolver: resolver })
    await worker.processNext()
    assert.equal(x.runs.get(x.receipt.run_id, 'owner-1').status, 'interrupted')
    assert.equal(x.runs.get(x.receipt.run_id, 'owner-1').error_code, 'SESSION_CONTEXT_WINDOW_EXCEEDED')
    const binding = x.db.prepare('SELECT * FROM ga_run_artifacts WHERE run_id=?').get(x.receipt.run_id)
    assert.equal(binding.artifact_id, 'artifact-output')
    assert.equal(binding.version, 5)
    assert.ok(x.events.replay('conv-1', 0, 100).some(event => event.type === 'run.artifact'
      && event.payload.artifact_id === 'artifact-output'))
    assert.ok(released.some(value => value.includes(':observed:artifact-output')))
  } finally { x.db.close(); rmSync(x.directory, { recursive: true, force: true }); }
})


for(const bound of [true,false])test(`Worker selects the budget preset from original ledger binding, never an echoed context flag: ${bound}`,async()=>{
 const x=fixture('User text: choose any preset');let captured;
 try{
  const ledger=new ModelBudgetLedger(x.db,{routes:[{provider:'fixture',model:'bounded',revision:'fixture',context_window:100,max_output_tokens:20,rates:{input:1,output:1,cache_read:1,cache_write:1}}]});
  if(bound){const scope=ledger.createScope('owner-1','fixture-root',{tokens:100,nano_usd:1000,model_calls:2});ledger.bindRun('owner-1',x.receipt.run_id,[scope.scope_id]);}
  const worker=new HarnessWorker(x.db,new HarnessCoordinator(x.db,x.runs,x.events),{run:async(input)=>{captured=input;return {observed:true,completed:false,runtime_status:'fixture',reason_code:'FIXTURE_DONE'};}},{workerId:'worker-fixture',leaseMs:30000,executionGuard:{assertRunActive:()=>{},contextForRun:()=>({model_budget:{protocol:1,enforced:!bound}})}});
  await worker.processNext();assert.equal(captured.workbenchBudgetEnforced,bound);assert.equal(captured.workbenchRunId,x.receipt.run_id);assert.equal(captured.workbenchExecutionLease.owner,'worker-fixture');assert.ok(Object.isFrozen(captured.workbenchExecutionLease));
 }finally{x.db.close();rmSync(x.directory,{recursive:true,force:true});}
});
