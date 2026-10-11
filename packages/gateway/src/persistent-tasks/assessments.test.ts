import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openProductDatabase } from '../db/database.ts';
import { PersistentTaskService } from './service.ts';
import {ConversationRepository} from '../conversations/repository.ts';
import {TaskExecutionEvidence} from './execution-evidence.ts';

const moduleUrl = new URL('./assessments.ts', import.meta.url);
const source = [{ kind: 'observation', reference: 'synthetic:verified-1' }];
function observations(model_raw_score = 99) {
  return { understanding: { confirmed: true, objective_summary: 'Read public source', acceptance_criteria: ['Deliver report'], source_refs: source },
    prerequisites: [{ key: 'source-access', status: 'met', source_refs: source }],
    evidence_requirements: [{ key: 'source', evidence_refs: source }],
    target: { expected_count: 1, observed_count: 1, source_refs: source },
    capabilities: [{ name: 'reader', status: 'healthy', source_refs: source }],
    authorization: { status: 'authorized', source_refs: source }, model_raw_score };
}
async function fixture(databasePath = ':memory:') {
  const module = await import(moduleUrl.href).catch(() => ({}));
  assert.equal(typeof (module as any).PersistentTaskAssessmentService, 'function', 'assessment service must exist');
  const db = openProductDatabase(databasePath);
  let conversationId='synthetic-conversation',projectId='synthetic-project';
  const workbench = { getAgent: () => ({ agent_id: 'synthetic-agent', status: 'active', workspace_id: 'synthetic-workspace', project_id: projectId, conversation_id: conversationId }), bindRun() {} };
  let now = new Date('2026-10-01T00:00:00Z');
  const tasks = new PersistentTaskService(db, workbench, { now: () => now });
  const task = tasks.create('alice', { agent_id: 'synthetic-agent', title: 'Synthetic report', objective: 'Read public source', trigger: { kind: 'once' } });
  const service = new (module as any).PersistentTaskAssessmentService(db, { now: () => now, ttlMs: 86_400_000 });
  function subtask(title: string, priority = 50, dependencies: string[] = []) { return tasks.upsertSubtask('alice', task.task_id, { title, priority, dependencies, acceptance: 'Deliver report' }); }
  function save(subject?: any, value: any = observations(), revision = 0) {
    const input = { ...(subject ? { subtask_id: subject.subtask_id, expected_subtask_version: subject.version } : {}),
      expected_task_version: tasks.get('alice', task.task_id).version, expected_assessment_revision: revision,
      expected_observation_revision: service.observationRevision('alice', task.task_id, subject?.subtask_id, value), observations: value };
    return service.saveAssessment('alice', task.task_id, input);
  }
  function proof(){
    const conversation=new ConversationRepository(db).create('alice',{workspace_id:'synthetic-workspace',model:{provider:'fixture',model:'fixture'}});conversationId=conversation.conversation_id;projectId=conversation.project_id;
    const occurrence=tasks.runNow('alice',task.task_id,'receipt-fixture');
    return new TaskExecutionEvidence(db).record(occurrence.run_id,'fixture-read','files.read',{content:'controlled source fixture'});
  }
  return { db, tasks, task, service, subtask, save, proof, setTime(value: string) { now = new Date(value); }, close() { db.close(); } };
}

// Mutation caught: trusting model score or allowing a score to mutate business status.
test('derived readiness keeps raw model score separate and never completes missing evidence', async () => {
  const f = await fixture(); try {
    const s = f.subtask('Read'); const obs = observations(); obs.evidence_requirements[0]!.evidence_refs = [];
    const assessment = f.save(s, obs);
    assert.equal(assessment.model_raw_score, 99); assert.equal(assessment.calibration_version, null);
    assert.ok(assessment.readiness_score < 100); assert.ok(assessment.uncertainty_reasons.includes('evidence_missing:source'));
    assert.equal(f.tasks.subtasks('alice', f.task.task_id).items[0]!.status, 'pending');
    const display = JSON.parse(JSON.stringify(f.service.assessment('alice', f.task.task_id, s.subtask_id))).display;
    assert.equal(display.label, '执行准备度，供参考'); assert.equal(display.completion_confirmed, false);
    assert.equal(display.business_status, 'pending'); assert.equal(display.evidence_count, 0);
    assert.equal('success_probability' in display, false);
    assert.throws(() => f.tasks.upsertSubtask('alice', f.task.task_id, { subtask_id: s.subtask_id, expected_version: 1, status: 'completed' }), /evidence_required/);
  } finally { f.close(); }
});

// Mutation caught: ownerless access, updates to history, or CAS accepting concurrent prior revision.
test('assessments isolate owners, preserve immutable history and reject concurrent replacement', async () => {
  const f = await fixture(); try {
    const first = f.save(); assert.equal(first.revision, 1);
    assert.throws(() => f.service.assessment('bob', f.task.task_id), /task_not_found/);
    assert.throws(() => f.service.saveAssessment('bob', f.task.task_id, {}), /task_not_found/);
    assert.throws(() => f.save(), /assessment_revision_conflict/);
    const second = f.save(undefined, observations(2), 1);
    assert.equal(second.revision, 2); assert.equal(second.model_raw_score, 2); assert.equal(second.readiness_score, 100);
    assert.equal(f.service.assessment('alice', f.task.task_id).history[1].model_raw_score, 99);
    assert.throws(() => f.db.prepare('UPDATE wb_task_assessments SET assessed_at=?').run('bad'), /assessment_immutable/);
    assert.throws(() => f.db.prepare('DELETE FROM wb_task_assessments').run(), /assessment_immutable/);
    const other = f.tasks.create('alice', { agent_id: 'synthetic-agent', title: 'Other', objective: 'Other', trigger: { kind: 'once' } });
    const child = f.tasks.upsertSubtask('alice', other.task_id, { title: 'Other child' });
    assert.throws(() => f.service.assessment('alice', f.task.task_id, child.subtask_id), /subtask_not_found/);
  } finally { f.close(); }
});

// Mutation caught: using an assessment after expiry, task/subtask version or underlying source revision changes.
test('version, expiry and changed source observations invalidate assessment reads and stale saves', async () => {
  const f = await fixture(); try {
    const s = f.subtask('Read'); const obs = observations(); f.save(s, obs);
    const changed = observations(); changed.capabilities[0]!.status = 'unavailable';
    assert.equal(f.service.assessment('alice', f.task.task_id, s.subtask_id, changed).fresh, false);
    const digest = f.service.observationRevision('alice', f.task.task_id, s.subtask_id, obs);
    f.tasks.upsertSubtask('alice', f.task.task_id, { subtask_id: s.subtask_id, expected_version: 1, title: 'Changed' });
    assert.equal(f.service.assessment('alice', f.task.task_id, s.subtask_id).fresh, false);
    assert.throws(() => f.service.saveAssessment('alice', f.task.task_id, { subtask_id: s.subtask_id, expected_task_version: 1, expected_subtask_version: 1, expected_assessment_revision: 1, expected_observation_revision: digest, observations: obs }), /version_conflict/);
    f.save(); f.tasks.pause('alice', f.task.task_id, 1);
    assert.equal(f.service.assessment('alice', f.task.task_id).fresh, false);
    f.setTime('2026-10-02T00:00:00Z');
    assert.ok(f.service.assessment('alice', f.task.task_id, s.subtask_id).stale_reasons.includes('assessment_expired'));
    assert.equal(f.service.assessment('alice', f.task.task_id, s.subtask_id).display.readiness_score, null);
  } finally { f.close(); }
});

// Mutation caught: ignoring dependency evidence or auth in candidate selection even for high score.
test('dependency and authorization gates precede priority and high readiness', async () => {
  const f = await fixture(); try {
    const read = f.subtask('Read', 10); const notify = f.subtask('Notify', 100, [read.subtask_id]);
    const unauthorized = f.subtask('Requires authorization', 100); const obs = observations(); obs.authorization.status = 'required';
    f.save(read); f.save(notify); f.save(unauthorized, obs);
    let actions = f.service.nextActions('alice', f.task.task_id);
    assert.deepEqual(actions.items.map((x: any) => x.subtask_id), [read.subtask_id]);
    assert.ok(actions.blocked.find((x: any) => x.subtask_id === notify.subtask_id).reasons.includes(`dependency_not_completed:${read.subtask_id}`));
    assert.ok(actions.blocked.find((x: any) => x.subtask_id === unauthorized.subtask_id).reasons.includes('authorization_required'));
    f.tasks.upsertSubtask('alice', f.task.task_id, { subtask_id: read.subtask_id, expected_version: 1, status: 'completed', evidence: [{ kind: 'artifact', reference: 'synthetic:report' }] });
    assert.equal(f.service.assessment('alice', f.task.task_id, notify.subtask_id).fresh, false);
    f.save(notify, observations(), 1); actions = f.service.nextActions('alice', f.task.task_id);
    assert.equal(actions.items.length,0);
    assert.ok(actions.blocked.find((x: any) => x.subtask_id === notify.subtask_id).reasons.includes(`dependency_evidence_unverified:${read.subtask_id}`));
    const proof=f.proof(),current=f.tasks.subtasks('alice',f.task.task_id).items;
    const currentRead=current.find((item:any)=>item.subtask_id===read.subtask_id)!,currentNotify=current.find((item:any)=>item.subtask_id===notify.subtask_id)!;
    assert.equal(currentRead.status,'pending');
    f.tasks.upsertSubtask('alice',f.task.task_id,{subtask_id:read.subtask_id,expected_version:currentRead.version,status:'completed',evidence:[proof]});
    f.save(currentNotify,observations(),2);actions=f.service.nextActions('alice',f.task.task_id);
    assert.deepEqual(actions.items.map((x: any) => x.subtask_id), [notify.subtask_id]);
    f.db.prepare('UPDATE wb_task_subtasks SET evidence_json=? WHERE subtask_id=?').run('[]', read.subtask_id);
    f.save(currentNotify, observations(), 3); actions = f.service.nextActions('alice', f.task.task_id);
    assert.ok(actions.blocked.find((x: any) => x.subtask_id === notify.subtask_id).reasons.includes(`dependency_evidence_missing:${read.subtask_id}`));
  } finally { f.close(); }
});

// Mutation caught: precomputed score injection, accepting wrong observed revision, or empty refs as healthy facts.
test('observations are validated and unknown facts return actionable reasons', async () => {
  const f = await fixture(); try {
    const obs: any = observations(); obs.readiness_score = 100;
    assert.throws(() => f.save(undefined, obs), /invalid_assessment_observations/);
    const unknown: any = observations(); unknown.understanding.source_refs = []; unknown.prerequisites = [];
    unknown.capabilities = []; unknown.target.observed_count = 2; unknown.evidence_requirements = [];
    const saved = f.save(undefined, unknown);
    assert.ok(saved.uncertainty_reasons.includes('understanding_unverified'));
    assert.ok(saved.uncertainty_reasons.includes('prerequisites_unknown'));
    assert.ok(saved.uncertainty_reasons.includes('capability_health_unknown'));
    assert.ok(saved.uncertainty_reasons.includes('target_not_unique'));
    assert.ok(saved.uncertainty_reasons.includes('evidence_requirements_unknown'));
    assert.throws(() => f.service.saveAssessment('alice', f.task.task_id, { expected_task_version: 1, expected_assessment_revision: 1, expected_observation_revision: 'stale', observations: observations() }), /observation_revision_conflict/);
    assert.equal(f.service.assessment('alice', f.task.task_id).history.length, 1);
  } finally { f.close(); }
});

// Mutation caught: readiness overriding user priority, expired candidates being admitted, or same-priority starvation.
test('priority is respected and waiting compensation advances an older equal-priority candidate', async () => {
  const f = await fixture(); try {
    const old = f.subtask('Older'); const low: any = observations(); low.evidence_requirements[0].evidence_refs = [];
    f.setTime('2026-10-04T00:00:00Z'); const recent = f.subtask('Recent'); const high = f.subtask('High user priority', 100);
    f.save(old, low); f.save(recent); f.save(high, low);
    assert.deepEqual(f.service.nextActions('alice', f.task.task_id).items.map((x: any) => x.subtask_id), [high.subtask_id, old.subtask_id, recent.subtask_id]);
    assert.equal(f.service.nextActions('alice', f.task.task_id).items[1].next_action, 'gather_evidence');
    f.setTime('2026-10-05T00:00:00Z');
    assert.equal(f.service.nextActions('alice', f.task.task_id).items.length, 0);
    assert.equal(f.service.nextActions('alice', f.task.task_id).blocked.length, 3);
    f.tasks.pause('alice', f.task.task_id, 1); f.save(old, low, 1);
    assert.equal(f.service.nextActions('alice', f.task.task_id).items.length, 0);
  } finally { f.close(); }
});

// Mutation caught: selecting a previously authorized candidate after newer authorization observations arrive.
test('candidate selection uses current source observations before admitting saved high readiness', async () => {
  const f = await fixture(); try {
    const subject = f.subtask('Notify'); f.save(subject);
    const current: any = observations(); current.authorization.status = 'denied';
    const actions = f.service.nextActions('alice', f.task.task_id, { [subject.subtask_id]: current });
    assert.equal(actions.items.length, 0);
    assert.ok(actions.blocked[0].reasons.includes('assessment_observations_changed'));
    assert.ok(actions.blocked[0].reasons.includes('authorization_denied'));
  } finally { f.close(); }
});

// Mutation caught: local-time expiry being interpreted in a host-dependent timezone or oversized observations entering storage.
test('expiry requires explicit timezone and bounded observations fail without appending history', async () => {
  const f = await fixture(); try {
    const obs = observations(); const revision = f.service.observationRevision('alice', f.task.task_id, undefined, obs);
    const input = { expected_task_version: 1, expected_assessment_revision: 0, expected_observation_revision: revision, observations: obs };
    assert.throws(() => f.service.saveAssessment('alice', f.task.task_id, { ...input, expires_at: '2026-10-01T12:00:00' }), /invalid_assessment_expiry/);
    assert.throws(() => f.service.saveAssessment('alice', f.task.task_id, { ...input, expires_at: '2026-10-03T01:00:00Z' }), /invalid_assessment_expiry/);
    assert.throws(() => f.service.saveAssessment('alice', f.task.task_id, { ...input, expires_at: '2026-09-30T23:00:00Z' }), /invalid_assessment_expiry/);
    const huge: any = observations();
    huge.prerequisites = Array.from({ length: 100 }, (_, index) => ({ key: `source-${index}`, status: 'met', source_refs: Array.from({ length: 100 }, () => ({ kind: 'synthetic', reference: 'x'.repeat(2000) })) }));
    assert.throws(() => f.save(undefined, huge), /invalid_assessment_observations/);
    assert.equal(f.service.assessment('alice', f.task.task_id).history.length, 0);
  } finally { f.close(); }
});

// Mutation caught: keeping observations only in process memory instead of the existing durable database.
test('database reopen preserves assessment history and selection without a parallel runtime', async () => {
  const base = tmpdir(); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'readiness-')); const path = join(directory, 'synthetic.sqlite');
  const f = await fixture(path); let db = f.db;
  try {
    const subject = f.subtask('Read'); f.save(subject); f.save(subject, observations(1), 1);
    db.close(); db = openProductDatabase(path);
    const { PersistentTaskAssessmentService } = await import(moduleUrl.href);
    const restarted = new PersistentTaskAssessmentService(db, { now: () => new Date('2026-10-01T00:00:00Z') });
    assert.equal(restarted.assessment('alice', f.task.task_id, subject.subtask_id).history.length, 2);
    assert.equal(restarted.nextActions('alice', f.task.task_id).items[0]!.subtask_id, subject.subtask_id);
    assert.equal(db.prepare('SELECT count(*) AS total FROM ga_runs').get()!.total, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
