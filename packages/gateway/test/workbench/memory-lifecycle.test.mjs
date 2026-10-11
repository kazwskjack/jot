import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openProductDatabase } from '../../src/db/database.ts';
import { ProjectRepository } from '../../src/projects/repository.ts';
import { WorkbenchService } from '../../src/workbench/service.ts';
import { MemoryLifecycle, memoryExpired } from '../../src/workbench/memory-lifecycle.ts';

const base = resolve('../../.test-tmp/memory-lifecycle');
mkdirSync(base, { recursive: true });
function fixture(t, options = {}) {
  const root = mkdtempSync(join(base, 'case-'));
  const db = openProductDatabase(join(root, 'synthetic.sqlite'));
  const config = { workspaceIds: ['ws-1', 'ws-2'], root: join(root, 'shared'), ...options };
  const service = new WorkbenchService(db, config);
  const agent = service.createAgent('owner-a', { name: 'Synthetic researcher', instructions: 'frozen instructions' });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, service, agent, config };
}
const note = (agent, fields = {}) => ({ scope: 'project', project_id: agent.project_id, content: 'synthetic conclusion', ...fields });

test('metadata normalizes UTC and corrections keep immutable source versions while CAS rejects stale changes', t => {
  const { service, agent } = fixture(t);
  const first = service.saveMemory('owner-a', 'ws-1', note(agent, { verified: true, provenance: [{ kind: 'document', reference: 'synthetic://revision-1' }], source_revision: 'rev-1', expires_at: '2099-01-02T10:00:00+08:00', verified_at: 'forged' }));
  assert.equal(first.expires_at, '2099-01-02T02:00:00.000Z');
  assert.match(first.verified_at, /^\d{4}-/);
  const corrected = service.saveMemory('owner-a', 'ws-1', note(agent, { memory_id: first.memory_id, expected_version: 1, content: 'corrected conclusion' }));
  assert.deepEqual(corrected.provenance, [{ kind: 'document', reference: 'synthetic://revision-1' }]);
  assert.equal(corrected.source_revision, 'rev-1');
  assert.equal(corrected.verified, false);
  assert.equal(corrected.verified_at, null);
  assert.equal(corrected.history, undefined);
  assert.throws(() => service.saveMemory('owner-a', 'ws-1', note(agent, { memory_id: first.memory_id, expected_version: 1 })), /version_conflict/);
  const history = service.exportMemory('owner-a', 'ws-1', { project_id: agent.project_id }).items[0].history;
  assert.deepEqual(history.map(x => [x.version, x.content, x.source_revision]), [[1, 'synthetic conclusion', 'rev-1'], [2, 'corrected conclusion', 'rev-1']]);
  assert.equal(history[0].verified, true);
  assert.equal(history[0].expires_at, '2099-01-02T02:00:00.000Z');
});

test('invalid metadata cannot partially mutate records and run-origin verification is always false', t => {
  const { service, agent } = fixture(t);
  for (const fields of [{ provenance: Array.from({ length: 21 }, () => ({ kind: 'x', reference: 'x' })) }, { provenance: [{ kind: 'x', reference: 2 }] }, { source_revision: 'x'.repeat(129) }, { expires_at: '2099-01-01T00:00:00' }, { expires_at: '2099-02-30T00:00:00Z' }]) {
    assert.throws(() => service.saveMemory('owner-a', 'ws-1', note(agent, fields)), /invalid_memory_/);
  }
  assert.equal(service.listMemory('owner-a', 'ws-1').items.length, 0);
  const run = service.enqueueAgentMessage('owner-a', agent.agent_id, { text: 'synthetic task', client_message_id: 'verify' });
  const proposed = service.saveMemory('owner-a', 'ws-1', note(agent, { verified: true }), run.run_id);
  assert.equal(proposed.verified, false);
  assert.equal(proposed.verified_at, null);
});

test('supersedes records the previous conclusion atomically and cannot cross project or private instance', t => {
  const { service, agent, db } = fixture(t);
  const first = service.saveMemory('owner-a', 'ws-1', note(agent));
  const replacement = service.saveMemory('owner-a', 'ws-1', note(agent, { content: 'replacement', supersedes: first.memory_id }));
  assert.equal(replacement.supersedes, first.memory_id);
  assert.deepEqual(service.listMemory('owner-a', 'ws-1').items.map(x => x.content), ['replacement']);
  assert.equal(db.prepare('SELECT status,version FROM wb_memories WHERE memory_id=?').get(first.memory_id).status, 'superseded');
  assert.equal(db.prepare('SELECT count(*) n FROM wb_memory_revisions WHERE memory_id=?').get(first.memory_id).n, 2);
  const exported = service.exportMemory('owner-a', 'ws-1', { project_id: agent.project_id });
  assert.deepEqual(exported.items.map(x => x.status).sort(), ['active', 'superseded']);
  assert.equal(exported.items.find(x => x.memory_id === first.memory_id).history[0].content, 'synthetic conclusion');
  assert.throws(() => service.saveMemory('owner-a', 'ws-1', note(agent, { supersedes: first.memory_id })), /memory_not_found/);
  const project = new ProjectRepository(db).create('owner-a', { title: 'Other synthetic project' });
  assert.throws(() => service.saveMemory('owner-a', 'ws-1', note(agent, { project_id: project.project_id, supersedes: replacement.memory_id })), /memory_scope_forbidden/);
  const other = service.createAgent('owner-a', { name: 'Other synthetic instance' });
  const secret = service.saveMemory('owner-a', 'ws-1', { scope: 'private', agent_id: agent.agent_id, content: 'private' });
  assert.throws(() => service.saveMemory('owner-a', 'ws-1', { scope: 'private', agent_id: other.agent_id, content: 'replacement secret', supersedes: secret.memory_id }), /memory_scope_forbidden/);
  assert.throws(() => service.saveMemory('owner-b', 'ws-1', { scope: 'project', content: 'foreign', supersedes: replacement.memory_id }), /memory_not_found/);
  assert.equal(service.listMemory('owner-a', 'ws-1', { scope: 'private', agent_id: other.agent_id }).items.length, 0);
});

test('expired records are management-only and later frozen reads exclude deletion or expiry while continuation keeps its role', t => {
  const { service, agent, db } = fixture(t);
  const expired = service.saveMemory('owner-a', 'ws-1', note(agent, { expires_at: '2000-01-01T00:00:00Z' }));
  assert.equal(service.listMemory('owner-a', 'ws-1').items.length, 0);
  assert.equal(service.listMemory('owner-a', 'ws-1', { include_expired: true }).items[0].expired, true);
  assert.equal(service.listMemory('owner-a', 'ws-1', { include_expired: 'true' }).items[0].expired, true);
  assert.equal(service.listMemory('owner-a', 'ws-1', { include_expired: 'false' }).items.length, 0);
  const live = service.saveMemory('owner-a', 'ws-1', note(agent, { content: 'live conclusion' }));
  const toExpire = service.saveMemory('owner-a', 'ws-1', note(agent, { content: 'soon expired' }));
  const run = service.enqueueAgentMessage('owner-a', agent.agent_id, { text: 'synthetic task', client_message_id: 'ttl' });
  assert.equal(service.contextForRun(run.run_id).memories.length, 2);
  assert.equal(service.listMemory('owner-a', 'ws-1', { include_expired: true }, run.run_id).items.some(x => x.memory_id === expired.memory_id), false);
  service.deleteMemory('owner-a', 'ws-1', live.memory_id, 1);
  db.prepare('UPDATE wb_memories SET expires_at=? WHERE memory_id=?').run('2000-01-01T00:00:00.000Z', toExpire.memory_id);
  service.updateAgent('owner-a', agent.agent_id, { expected_version: 1, instructions: 'new instructions' });
  assert.deepEqual(service.contextForRun(run.run_id).memories, []);
  const next = service.enqueueAgentMessage('owner-a', agent.agent_id, { text: 'continue', client_message_id: 'next' });
  db.prepare('DELETE FROM wb_run_bindings WHERE run_id=?').run(next.run_id);
  service.inheritChatRun('owner-a', run.run_id, next.run_id);
  assert.equal(service.contextForRun(next.run_id).instructions, 'frozen instructions');
  assert.deepEqual(service.contextForRun(next.run_id).memories, []);
  const restored = service.saveMemory('owner-a', 'ws-1', note(agent, { memory_id: expired.memory_id, expected_version: 1, expires_at: null }));
  assert.equal(restored.expired, false);
});

test('export is complete and selected scope never includes another owner project or private instance', t => {
  const { service, agent, db } = fixture(t);
  const other = service.createAgent('owner-a', { name: 'Other instance' });
  const foreign = service.createAgent('owner-b', { name: 'Foreign owner' });
  const project = new ProjectRepository(db).create('owner-a', { title: 'Other project' });
  service.saveMemory('owner-a', 'ws-1', { scope: 'private', agent_id: other.agent_id, content: 'other secret' });
  service.saveMemory('owner-b', 'ws-1', note(foreign, { content: 'foreign secret' }));
  service.saveMemory('owner-a', 'ws-1', note(agent, { project_id: project.project_id, content: 'other project secret' }));
  for (let n = 0; n < 205; n++) service.saveMemory('owner-a', 'ws-1', note(agent, { content: `synthetic fact ${n}` }));
  const exported = service.exportMemory('owner-a', 'ws-1', { agent_id: agent.agent_id, project_id: agent.project_id, scope: 'project' });
  assert.equal(exported.schema_version, 1);
  assert.equal(exported.items.length, 205);
  assert.equal(exported.workspace_id, 'ws-1');
  assert.ok(exported.items.every(x => x.scope === 'project' && x.project_id === agent.project_id && x.history.length === 1));
  assert.equal(JSON.stringify(exported).includes('owner_id'), false);
  assert.equal(JSON.stringify(exported).includes('context_json'), false);
  assert.throws(() => service.exportMemory('owner-b', 'ws-1', { agent_id: agent.agent_id }), /agent_not_found/);
  assert.throws(() => service.exportMemory('owner-a', 'ws-1', { agent_id: agent.agent_id, project_id: project.project_id }), /memory_scope_forbidden/);
});

test('semantic adapters receive authorized candidates only and failures or injected IDs use keyword fallback', t => {
  let mode = 'injection';
  const seen = [];
  const { service, agent } = fixture(t, { memoryRankAdapter: { rank({ candidates }) { seen.push(candidates.map(x => x.content)); if (mode === 'throw') throw new Error('synthetic index unavailable'); return mode === 'injection' ? ['unauthorized-id'] : candidates.map(x => x.memory_id).reverse(); } } });
  const first = service.saveMemory('owner-a', 'ws-1', note(agent, { content: 'alpha conclusion' }));
  const second = service.saveMemory('owner-a', 'ws-1', note(agent, { content: 'beta conclusion' }));
  const other = service.createAgent('owner-a', { name: 'Hidden instance' });
  service.saveMemory('owner-a', 'ws-1', { scope: 'private', agent_id: other.agent_id, content: 'alpha hidden secret' });
  service.saveMemory('owner-a', 'ws-1', note(agent, { content: 'alpha expired', expires_at: '2000-01-01T00:00:00Z' }));
  assert.deepEqual(service.listMemory('owner-a', 'ws-1', { agent_id: agent.agent_id, q: 'alpha' }).items.map(x => x.memory_id), [first.memory_id]);
  assert.deepEqual(seen[0], ['alpha conclusion', 'beta conclusion']);
  mode = 'throw';
  assert.deepEqual(service.listMemory('owner-a', 'ws-1', { agent_id: agent.agent_id, q: 'alpha' }).items.map(x => x.memory_id), [first.memory_id]);
  mode = 'valid';
  assert.deepEqual(service.listMemory('owner-a', 'ws-1', { agent_id: agent.agent_id, q: 'conclusion' }).items.map(x => x.memory_id), [second.memory_id, first.memory_id]);
  const historical = service.listMemory('owner-a', 'ws-1', { agent_id: agent.agent_id, q: 'alpha', include_expired: true }).items;
  assert.ok(historical.some(x => x.content === 'alpha expired'));
  assert.ok(seen.flat().every(content => content !== 'alpha expired' && content !== 'alpha hidden secret'));
});

test('recall deduplicates content without dropping identity attribution or exceeding its content budget', t => {
  const { service, agent } = fixture(t);
  service.saveMemory('owner-a', 'ws-1', note(agent, { content: 'Repeated fact' }));
  service.saveMemory('owner-a', 'ws-1', note(agent, { content: ' Repeated fact ' }));
  for (let n = 0; n < 8; n++) service.saveMemory('owner-a', 'ws-1', note(agent, { content: `${n}${'x'.repeat(9999)}` }));
  const run = service.enqueueAgentMessage('owner-a', agent.agent_id, { text: 'read', client_message_id: 'dedupe' });
  const memories = service.contextForRun(run.run_id).memories;
  assert.equal(memories.filter(x => x.content === 'Repeated fact').length, 1);
  assert.ok(memories.reduce((sum, x) => sum + x.content.length, 0) <= 12000);
  assert.ok(memories.every(x => x.memory_id && x.project_id === agent.project_id && x.history === undefined));
});

test('a model cannot correct or supersede a human-verified conclusion', t => {
  const { service, agent } = fixture(t);
  const verified = service.saveMemory('owner-a', 'ws-1', note(agent, { verified: true }));
  const run = service.enqueueAgentMessage('owner-a', agent.agent_id, { text: 'propose', client_message_id: 'verified' });
  assert.throws(() => service.saveMemory('owner-a', 'ws-1', note(agent, { memory_id: verified.memory_id, expected_version: 1, content: 'model correction' }), run.run_id), /memory_verification_required/);
  assert.throws(() => service.saveMemory('owner-a', 'ws-1', note(agent, { supersedes: verified.memory_id, content: 'model replacement' }), run.run_id), /memory_verification_required/);
  assert.throws(() => service.deleteMemory('owner-a', 'ws-1', verified.memory_id, 1, run.run_id), /memory_verification_required/);
  assert.equal(service.listMemory('owner-a', 'ws-1').items[0].verified, true);
});

test('migration is idempotent on owned legacy active rows and extra columns do not break explicit inserts', t => {
  const { db, service, agent, config } = fixture(t);
  db.exec('DROP TABLE wb_memories');
  db.exec(`CREATE TABLE wb_memories(memory_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,scope TEXT NOT NULL,agent_id TEXT,content TEXT NOT NULL,verified INTEGER NOT NULL,version INTEGER NOT NULL,active INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,legacy_extra TEXT DEFAULT 'preserved')`);
  const columns = 'memory_id,owner_id,workspace_id,project_id,scope,agent_id,content,verified,version,active,created_at,updated_at';
  db.prepare(`INSERT INTO wb_memories(${columns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-active', 'owner-a', 'ws-1', agent.project_id, 'project', null, 'legacy conclusion', 1, 4, 1, '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
  db.prepare(`INSERT INTO wb_memories(${columns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-deleted', 'owner-a', 'ws-1', agent.project_id, 'project', null, 'legacy deleted', 0, 2, 0, '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
  const migrated = new WorkbenchService(db, config);
  assert.deepEqual(migrated.listMemory('owner-a', 'ws-1').items.map(x => x.memory_id), ['legacy-active']);
  assert.equal(migrated.listMemory('owner-a', 'ws-1').items[0].verified_at, '2020-01-02T00:00:00.000Z');
  const created = migrated.saveMemory('owner-a', 'ws-1', note(agent));
  assert.equal(db.prepare('SELECT legacy_extra FROM wb_memories WHERE memory_id=?').get(created.memory_id).legacy_extra, 'preserved');
  migrated.deleteMemory('owner-a', 'ws-1', created.memory_id, 1);
  assert.equal(db.prepare('SELECT active FROM wb_memories WHERE memory_id=?').get(created.memory_id).active, 0);
  const again = new WorkbenchService(db, config);
  assert.equal(again.exportMemory('owner-a', 'ws-1').items[0].history.length, 1);
  assert.equal(db.prepare('SELECT content FROM wb_memories WHERE memory_id=?').get('legacy-deleted').content, 'legacy deleted');
});

test('a legacy memory table without owner identifiers never falls back to shared global data', t => {
  const { db, config } = fixture(t);
  db.exec('DROP TABLE wb_memories');
  db.exec('CREATE TABLE wb_memories(memory_id TEXT PRIMARY KEY,content TEXT NOT NULL)');
  db.prepare('INSERT INTO wb_memories VALUES(?,?)').run('legacy-global', 'synthetic forbidden global conclusion');
  assert.throws(() => new WorkbenchService(db, config), /memory_owner_migration_required/);
  assert.equal(db.prepare('SELECT content FROM wb_memories').get().content, 'synthetic forbidden global conclusion');
});

test('index revision claims cannot revive corrected deleted expired or deleted-instance memory after rebuild', t => {
  const { db, service, agent } = fixture(t);
  const index = new MemoryLifecycle(db);
  const first = service.saveMemory('owner-a', 'ws-1', note(agent));
  assert.equal(index.claim('owner-a', first.memory_id, 1).content, 'synthetic conclusion');
  assert.equal(index.claim('owner-b', first.memory_id, 1), null);
  service.saveMemory('owner-a', 'ws-1', note(agent, { memory_id: first.memory_id, expected_version: 1, content: 'corrected' }));
  assert.equal(index.claim('owner-a', first.memory_id, 1), null);
  assert.equal(index.claim('owner-a', first.memory_id, 2).content, 'corrected');
  service.deleteMemory('owner-a', 'ws-1', first.memory_id, 2);
  index.rebuild();
  assert.equal(index.claim('owner-a', first.memory_id, 2), null);
  assert.equal(index.claim('owner-a', first.memory_id, 3), null);
  assert.deepEqual({ ...db.prepare('SELECT revision,tombstone FROM wb_memory_index_jobs WHERE memory_id=?').get(first.memory_id) }, { revision: 3, tombstone: 1 });
  const expired = service.saveMemory('owner-a', 'ws-1', note(agent, { expires_at: '2000-01-01T00:00:00Z' }));
  index.rebuild();
  assert.equal(index.claim('owner-a', expired.memory_id, 1), null);
  assert.equal(db.prepare('SELECT tombstone FROM wb_memory_index_jobs WHERE memory_id=?').get(expired.memory_id).tombstone, 1);
  const privateNote = service.saveMemory('owner-a', 'ws-1', { scope: 'private', agent_id: agent.agent_id, content: 'private index fact' });
  service.deleteAgent('owner-a', agent.agent_id, 1);
  index.rebuild();
  assert.equal(index.claim('owner-a', privateNote.memory_id, 1), null);
  assert.equal(db.prepare('SELECT tombstone FROM wb_memory_index_jobs WHERE memory_id=?').get(privateNote.memory_id).tombstone, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM wb_memory_revisions WHERE memory_id=?').get(privateNote.memory_id).n, 2);
});

test('expiry boundary is inclusive and same-version background expiry invalidates an earlier index claim', t => {
  assert.equal(memoryExpired({ expires_at: '2099-01-01T00:00:00.000Z' }, '2099-01-01T00:00:00.000Z'), true);
  assert.equal(memoryExpired({ expires_at: '2099-01-01T00:00:00.001Z' }, '2099-01-01T00:00:00.000Z'), false);
  const { db, service, agent } = fixture(t);
  const index = new MemoryLifecycle(db);
  const first = service.saveMemory('owner-a', 'ws-1', note(agent, { expires_at: '2099-01-01T00:00:00Z' }));
  assert.ok(index.claim('owner-a', first.memory_id, 1));
  db.prepare('UPDATE wb_memories SET expires_at=? WHERE memory_id=?').run('2000-01-01T00:00:00.000Z', first.memory_id);
  index.rebuild();
  assert.equal(index.claim('owner-a', first.memory_id, 1), null);
  assert.equal(db.prepare('SELECT tombstone FROM wb_memory_index_jobs WHERE memory_id=?').get(first.memory_id).tombstone, 1);
});

test('frozen recall bounds all serialized source metadata and visibly reports shortened provenance', t => {
  const { service, agent } = fixture(t);
  for (let n = 0; n < 6; n++) service.saveMemory('owner-a', 'ws-1', note(agent, { content: `${n}${'x'.repeat(9000)}`, provenance: Array.from({ length: 20 }, (_, i) => ({ kind: 'document', reference: `synthetic://${i}/${'y'.repeat(2000)}` })) }));
  const run = service.enqueueAgentMessage('owner-a', agent.agent_id, { text: 'read', client_message_id: 'source-budget' });
  const memories = service.contextForRun(run.run_id).memories;
  assert.ok(JSON.stringify(memories).length <= 12000);
  assert.ok(memories.length > 0);
  assert.ok(memories.every(x => x.provenance_truncated === true && x.truncated === true && x.memory_id && x.version === 1));
  assert.ok(memories.every(x => x.provenance.some(source => source.reference.startsWith('synthetic://'))));
  assert.equal(service.exportMemory('owner-a', 'ws-1').items[0].provenance.length, 20);
});

test('export query filters the complete scope and validates query input rather than silently ignoring it', t => {
  const { service, agent } = fixture(t);
  service.saveMemory('owner-a', 'ws-1', note(agent, { content: 'alpha finding' }));
  service.saveMemory('owner-a', 'ws-1', note(agent, { content: 'beta finding' }));
  assert.deepEqual(service.exportMemory('owner-a', 'ws-1', { project_id: agent.project_id, q: 'alpha' }).items.map(x => x.content), ['alpha finding']);
  assert.throws(() => service.exportMemory('owner-a', 'ws-1', { q: 'x'.repeat(2001) }), /invalid_memory_query/);
});
