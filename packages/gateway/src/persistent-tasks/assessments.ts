import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import { TaskExecutionEvidence } from './execution-evidence.ts';
import {eligibleTaskOccurrence,taskDependencyReasons} from './execution-eligibility.ts';
import {subtaskOccurrence} from './subtask-state.ts';

type Row = Record<string, any>;
export type AssessmentSource = { kind: string; reference: string; hash?: string };
export type AssessmentObservations = {
  understanding: { confirmed: boolean; objective_summary: string; acceptance_criteria: string[]; source_refs: AssessmentSource[] };
  prerequisites: { key: string; status: 'met' | 'missing' | 'unknown'; source_refs: AssessmentSource[] }[];
  evidence_requirements: { key: string; evidence_refs: AssessmentSource[] }[];
  target: { expected_count: number; observed_count: number; source_refs: AssessmentSource[] };
  capabilities: { name: string; status: 'healthy' | 'degraded' | 'unavailable' | 'unknown'; source_refs: AssessmentSource[] }[];
  authorization: { status: 'authorized' | 'required' | 'denied'; source_refs: AssessmentSource[] };
  model_raw_score?: number | null;
};
export type SaveAssessmentInput = {
  subtask_id?: string; expected_task_version: number; expected_subtask_version?: number;
  expected_assessment_revision: number; expected_observation_revision: string;
  observations: AssessmentObservations; expires_at?: string;
};
export type TaskAssessment = {
  owner_id: string; task_id: string; subtask_id: string | null; task_version: number; subtask_version: number | null;
  revision: number; understanding: number; prerequisites: number; evidence_coverage: number;
  target_uniqueness: number; capability_health: number; model_raw_score: number | null; readiness_score: number;
  uncertainty_reasons: string[]; scorer_version: string; calibration_version: null;
  observation_revision: string; assessed_at: string; expires_at: string; observations: AssessmentObservations;
};
export type AssessmentView = {
  latest: TaskAssessment | null; history: TaskAssessment[]; fresh: boolean; stale_reasons: string[];
  observation_revision: string | null;
  display: { label: string; readiness_score: number | null; business_status: string; evidence_count: number; completion_confirmed: boolean };
};
export type AssessmentCandidate = {
  task_id: string; subtask_id: string; title: string; priority: number; readiness_score: number;
  waiting_compensation: number; assessment_revision: number; observation_revision: string;
  next_action: 'execute' | 'gather_evidence' | 'resolve_uncertainty'; uncertainty_reasons: string[];
};
export type AssessmentOptions = { now?: () => Date; ttlMs?: number };
const SCORER = 'evidence-readiness-v1';
const INVALID = 'invalid_assessment_observations';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function record(value: unknown): Row { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID); return value as Row; }
function string(value: unknown, max = 2000): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(INVALID); return value.trim(); }
function list(value: unknown): unknown[] { if (!Array.isArray(value) || value.length > 100) throw new Error(INVALID); return value; }
function sources(value: unknown): AssessmentSource[] {
  return list(value).map(item => { const ref = record(item); return { kind: string(ref.kind, 60), reference: string(ref.reference, 2048), ...(ref.hash === undefined ? {} : { hash: string(ref.hash, 128) }) }; });
}
function enumeration<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(INVALID); return value as T; }
function count(value: unknown): number { if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) throw new Error(INVALID); return value; }
function normalize(value: unknown): AssessmentObservations {
  const input = record(value);
  if (Object.keys(input).some(key => !['understanding', 'prerequisites', 'evidence_requirements', 'target', 'capabilities', 'authorization', 'model_raw_score'].includes(key))) throw new Error(INVALID);
  const understanding = record(input.understanding), target = record(input.target), authorization = record(input.authorization);
  if (typeof understanding.confirmed !== 'boolean') throw new Error(INVALID);
  const raw = input.model_raw_score;
  if (raw !== undefined && raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100)) throw new Error(INVALID);
  const normalized: AssessmentObservations = {
    understanding: { confirmed: understanding.confirmed, objective_summary: string(understanding.objective_summary), acceptance_criteria: list(understanding.acceptance_criteria).map(item => string(item)), source_refs: sources(understanding.source_refs) },
    prerequisites: list(input.prerequisites).map(item => { const row = record(item); return { key: string(row.key, 200), status: enumeration(row.status, ['met', 'missing', 'unknown']), source_refs: sources(row.source_refs) }; }),
    evidence_requirements: list(input.evidence_requirements).map(item => { const row = record(item); return { key: string(row.key, 200), evidence_refs: sources(row.evidence_refs) }; }),
    target: { expected_count: count(target.expected_count), observed_count: count(target.observed_count), source_refs: sources(target.source_refs) },
    capabilities: list(input.capabilities).map(item => { const row = record(item); return { name: string(row.name, 200), status: enumeration(row.status, ['healthy', 'degraded', 'unavailable', 'unknown']), source_refs: sources(row.source_refs) }; }),
    authorization: { status: enumeration(authorization.status, ['authorized', 'required', 'denied']), source_refs: sources(authorization.source_refs) }, model_raw_score: raw ?? null,
  };
  for (const keys of [normalized.prerequisites.map(item => item.key), normalized.evidence_requirements.map(item => item.key), normalized.capabilities.map(item => item.name)]) if (new Set(keys).size !== keys.length) throw new Error(INVALID);
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 262_144) throw new Error(INVALID);
  return normalized;
}
function score(observations: AssessmentObservations) {
  const reasons: string[] = [];
  const verifiedUnderstanding = observations.understanding.confirmed && observations.understanding.acceptance_criteria.length > 0 && observations.understanding.source_refs.length > 0;
  if (!verifiedUnderstanding) reasons.push('understanding_unverified');
  if (!observations.prerequisites.length) reasons.push('prerequisites_unknown');
  for (const item of observations.prerequisites) if (item.status !== 'met' || !item.source_refs.length) reasons.push(`prerequisite_${item.status === 'missing' ? 'missing' : 'unverified'}:${item.key}`);
  if (!observations.evidence_requirements.length) reasons.push('evidence_requirements_unknown');
  for (const item of observations.evidence_requirements) if (!item.evidence_refs.length) reasons.push(`evidence_missing:${item.key}`);
  const unique = observations.target.expected_count === 1 && observations.target.observed_count === 1 && observations.target.source_refs.length > 0;
  if (!unique) reasons.push('target_not_unique');
  if (!observations.capabilities.length) reasons.push('capability_health_unknown');
  for (const item of observations.capabilities) if (item.status !== 'healthy' || !item.source_refs.length) reasons.push(`capability_${item.status === 'healthy' ? 'unverified' : item.status}:${item.name}`);
  if (observations.authorization.status !== 'authorized') reasons.push(`authorization_${observations.authorization.status}`);
  else if (!observations.authorization.source_refs.length) reasons.push('authorization_unverified');
  const ratio = (values: boolean[]) => values.length ? Math.round(values.filter(Boolean).length / values.length * 100) : 0;
  const dimensions = { understanding: verifiedUnderstanding ? 100 : 0,
    prerequisites: ratio(observations.prerequisites.map(item => item.status === 'met' && item.source_refs.length > 0)),
    evidence_coverage: ratio(observations.evidence_requirements.map(item => item.evidence_refs.length > 0)),
    target_uniqueness: unique ? 100 : 0,
    capability_health: ratio(observations.capabilities.map(item => item.status === 'healthy' && item.source_refs.length > 0)) };
  return { ...dimensions, readiness_score: Math.round(Object.values(dimensions).reduce((sum, item) => sum + item, 0) / 5), uncertainty_reasons: reasons };
}

/** Ledger-bound advisory assessments. This service never creates a run or confirms completion. */
export class PersistentTaskAssessmentService {
  private readonly db: DatabaseSync;
  private readonly options: AssessmentOptions;
  private readonly ttlMs: number;
  private readonly executionEvidence: TaskExecutionEvidence;
  constructor(db: DatabaseSync, options: AssessmentOptions = {}) {
    this.db = db; this.options = options; this.ttlMs = options.ttlMs ?? 900_000;
    this.executionEvidence = new TaskExecutionEvidence(db);
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 604_800_000) throw new Error('invalid_assessment_ttl');
    db.exec(`CREATE TABLE IF NOT EXISTS wb_task_assessments (
      owner_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),subject_id TEXT NOT NULL,
      revision INTEGER NOT NULL,task_version INTEGER NOT NULL,subtask_version INTEGER,observation_revision TEXT NOT NULL,
      ledger_revision TEXT NOT NULL,assessed_at TEXT NOT NULL,expires_at TEXT NOT NULL,assessment_json TEXT NOT NULL,
      PRIMARY KEY(owner_id,task_id,subject_id,revision));
      CREATE TRIGGER IF NOT EXISTS wb_assessment_no_update BEFORE UPDATE ON wb_task_assessments BEGIN SELECT RAISE(ABORT,'assessment_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_assessment_no_delete BEFORE DELETE ON wb_task_assessments BEGIN SELECT RAISE(ABORT,'assessment_immutable'); END;`);
  }
  private now() { return (this.options.now?.() ?? new Date()).toISOString(); }
  private task(owner: string, id: string): Row {
    const row = this.db.prepare('SELECT * FROM wb_persistent_tasks WHERE owner_id=? AND task_id=?').get(owner, id) as Row | undefined;
    if (!row) throw new Error('task_not_found'); return row;
  }
  private subject(task: Row, id?: string): Row {
    if (id === undefined) return task;
    const row = this.db.prepare('SELECT * FROM wb_task_subtasks WHERE task_id=? AND subtask_id=?').get(task.task_id, id) as Row | undefined;
    if (!row) throw new Error('subtask_not_found'); return row;
  }
  private ledger(task: Row, subject: Row) {
    // Projection acknowledgement is derived output and cannot invalidate its source assessment.
    const { projection_pending: _projectionPending, ...parent } = task;
    const dependencies: string[] = subject.subtask_id ? JSON.parse(subject.dependencies_json) : [];
    const children = subject.subtask_id ? dependencies.map(id => this.db.prepare('SELECT * FROM wb_task_subtasks WHERE task_id=? AND subtask_id=?').get(task.task_id, id) ?? { subtask_id: id, missing: true })
      : this.db.prepare('SELECT * FROM wb_task_subtasks WHERE task_id=? ORDER BY subtask_id').all(task.task_id);
    const occurrences = this.db.prepare('SELECT * FROM wb_task_occurrences WHERE task_id=? ORDER BY occurrence_id').all(task.task_id)
      .map(row=>{const {updated_at:_refreshedAt,...facts}=row;return facts;});
    return { task: parent, subject: subject.subtask_id ? subject : parent, dependencies: children, occurrences };
  }
  observationRevision(owner: string, taskId: string, subtaskId: string | undefined, observations: AssessmentObservations): string {
    const task = this.task(owner, taskId), subject = this.subject(task, subtaskId);
    return digest({ ledger: this.ledger(task, subject), observations: normalize(observations) });
  }
  saveAssessment(owner: string, taskId: string, input: SaveAssessmentInput): TaskAssessment {
    return withImmediateTransaction(this.db, () => {
      const task = this.task(owner, taskId), subject = this.subject(task, input.subtask_id);
      if (task.version !== input.expected_task_version || (input.subtask_id !== undefined && subject.version !== input.expected_subtask_version)) throw new Error('version_conflict');
      const prior = this.db.prepare('SELECT max(revision) AS revision FROM wb_task_assessments WHERE owner_id=? AND task_id=? AND subject_id=?').get(owner, taskId, input.subtask_id ?? '') as Row;
      if (!Number.isSafeInteger(input.expected_assessment_revision) || input.expected_assessment_revision < 0 || (prior.revision ?? 0) !== input.expected_assessment_revision) throw new Error('assessment_revision_conflict');
      const observations = normalize(input.observations), ledger = this.ledger(task, subject);
      const revision = digest({ ledger, observations });
      if (revision !== input.expected_observation_revision) throw new Error('observation_revision_conflict');
      const now = this.now(), limit = Date.parse(now) + this.ttlMs;
      if (input.expires_at !== undefined && (typeof input.expires_at !== 'string' || !/T.*(Z|[+-]\d\d:\d\d)$/.test(input.expires_at))) throw new Error('invalid_assessment_expiry');
      const expiry = input.expires_at === undefined ? limit : Date.parse(input.expires_at);
      if (!Number.isFinite(expiry) || expiry <= Date.parse(now) || expiry > limit) throw new Error('invalid_assessment_expiry');
      const value: TaskAssessment = { owner_id: owner, task_id: taskId, subtask_id: input.subtask_id ?? null,
        task_version: Number(task.version), subtask_version: input.subtask_id ? Number(subject.version) : null,
        revision: input.expected_assessment_revision + 1, ...score(observations), model_raw_score: observations.model_raw_score ?? null,
        scorer_version: SCORER, calibration_version: null, observation_revision: revision, assessed_at: now, expires_at: new Date(expiry).toISOString(), observations };
      this.db.prepare('INSERT INTO wb_task_assessments VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(owner, taskId, input.subtask_id ?? '', value.revision, value.task_version, value.subtask_version, revision, digest(ledger), now, value.expires_at, JSON.stringify(value));
      this.db.prepare('UPDATE wb_persistent_tasks SET projection_pending=1 WHERE owner_id=? AND task_id=?').run(owner, taskId);
      return value;
    });
  }
  assessment(owner: string, taskId: string, subtaskId?: string, currentObservations?: AssessmentObservations): AssessmentView {
    const task = this.task(owner, taskId), subject = this.subject(task, subtaskId);
    const rows = this.db.prepare('SELECT * FROM wb_task_assessments WHERE owner_id=? AND task_id=? AND subject_id=? ORDER BY revision DESC').all(owner, taskId, subtaskId ?? '') as Row[];
    const history = rows.map(row => JSON.parse(row.assessment_json) as TaskAssessment), latest = history[0] ?? null;
    const reasons: string[] = [];
    let revision: string | null = null;
    if (!latest) reasons.push('assessment_missing');
    else {
      if (latest.task_version !== task.version || (subtaskId !== undefined && latest.subtask_version !== subject.version)) reasons.push('assessment_version_stale');
      if (Date.parse(latest.expires_at) <= Date.parse(this.now())) reasons.push('assessment_expired');
      revision = digest({ ledger: this.ledger(task, subject), observations: normalize(currentObservations ?? latest.observations) });
      if (revision !== latest.observation_revision) reasons.push('assessment_observations_changed');
    }
    const refs: AssessmentSource[] = subtaskId ? JSON.parse(subject.evidence_json) : this.db.prepare('SELECT evidence_json FROM wb_task_occurrences WHERE task_id=?').all(taskId).flatMap(row => JSON.parse(String(row.evidence_json)) as AssessmentSource[]);
    const fresh = reasons.length === 0;
    const occurrenceId=subtaskOccurrence(this.db,taskId);
    return { latest, history, fresh, stale_reasons: reasons, observation_revision: revision,
      display: { label: '执行准备度，供参考', readiness_score: fresh ? latest!.readiness_score : null,
        business_status: String(subject.status), evidence_count: refs.length,
        completion_confirmed: subject.status === 'completed' && occurrenceId!==null && this.executionEvidence.completionVerified(owner,taskId,refs,occurrenceId,subtaskId) } };
  }
  nextActions(owner: string, taskId: string, currentObservations?: Record<string, AssessmentObservations>, executionRunId?:string): { items: AssessmentCandidate[]; blocked: { subtask_id: string; title: string; reasons: string[] }[] } {
    const task = this.task(owner, taskId);
    const occurrence=eligibleTaskOccurrence(this.db,owner,taskId,executionRunId);
    const rows = this.db.prepare("SELECT * FROM wb_task_subtasks WHERE task_id=? AND status IN ('pending','blocked') ORDER BY subtask_id").all(taskId) as Row[];
    const items: AssessmentCandidate[] = [], blocked: { subtask_id: string; title: string; reasons: string[] }[] = [];
    for (const subject of rows) {
      const current = currentObservations?.[subject.subtask_id];
      const view = this.assessment(owner, taskId, subject.subtask_id, current), reasons = [...view.stale_reasons];
      if (task.status !== 'active' && !(task.status==='budget_exhausted'&&occurrence)) reasons.push('task_not_active');
      if (executionRunId!==undefined&&!occurrence) reasons.push('task_execution_inactive');
      const authorization = current ? normalize(current).authorization : view.latest?.observations.authorization;
      if (!authorization || authorization.status !== 'authorized') reasons.push(`authorization_${authorization?.status ?? 'unknown'}`);
      else if (!authorization.source_refs.length) reasons.push('authorization_unverified');
      reasons.push(...taskDependencyReasons(this.db,this.executionEvidence,owner,taskId,JSON.parse(subject.dependencies_json),occurrence?.occurrence_id));
      if (reasons.length) { blocked.push({ subtask_id: String(subject.subtask_id), title: String(subject.title), reasons }); continue; }
      const assessment = view.latest!;
      // Aging is applied inside a priority tier and grows without a cap so recurring ready work cannot starve older work.
      const waiting = Math.max(0, (Date.parse(this.now()) - Date.parse(subject.created_at)) / 86_400_000) * 10;
      const uncertainties = assessment.uncertainty_reasons;
      items.push({ task_id: taskId, subtask_id: String(subject.subtask_id), title: String(subject.title), priority: Number(subject.priority),
        readiness_score: assessment.readiness_score, waiting_compensation: waiting, assessment_revision: assessment.revision,
        observation_revision: assessment.observation_revision, next_action: uncertainties.some(reason => reason.startsWith('evidence_')) ? 'gather_evidence' : uncertainties.length ? 'resolve_uncertainty' : 'execute', uncertainty_reasons: uncertainties });
    }
    items.sort((a, b) => b.priority - a.priority || (b.readiness_score + b.waiting_compensation) - (a.readiness_score + a.waiting_compensation) || a.subtask_id.localeCompare(b.subtask_id));
    return { items, blocked };
  }
}
