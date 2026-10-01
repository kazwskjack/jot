import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openProductDatabase } from '../../src/db/database.ts';
import { ProjectRepository } from '../../src/projects/repository.ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ga-projects-'));
  const db = openProductDatabase(join(directory, 'jot.db'));
  return { directory, db, projects: new ProjectRepository(db) };
}

function close(value) {
  value.db.close();
  rmSync(value.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

test('ensureDefault creates one jotV0 project and backfills old conversations', () => {
  const value = fixture();
  try {
    value.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('conv-old', 'owner-a', 'ws', 'Old', '{}', 1, '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z');
    const first = value.projects.ensureDefault('owner-a');
    const second = value.projects.ensureDefault('owner-a');
    assert.equal(first.project_id, second.project_id);
    assert.equal(first.title, 'jotV0');
    assert.equal(value.db.prepare('SELECT project_id FROM ga_conversations WHERE id=?').get('conv-old').project_id, first.project_id);
    assert.equal(value.projects.list('owner-a').items.length, 1);
  } finally { close(value); }
});

test('projects are owner isolated and expose active and archived counts', () => {
  const value = fixture();
  try {
    const project = value.projects.create('owner-a', { title: 'Research' });
    value.db.prepare(`INSERT INTO ga_conversations(
      id,owner_id,workspace_id,title,model,version,created_at,updated_at,project_id,archived_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run('conv-active', 'owner-a', 'ws', 'A', '{}', 1, 'now', 'now', project.project_id, null);
    value.db.prepare(`INSERT INTO ga_conversations(
      id,owner_id,workspace_id,title,model,version,created_at,updated_at,project_id,archived_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run('conv-archived', 'owner-a', 'ws', 'B', '{}', 1, 'now', 'now', project.project_id, '2026-09-14T01:00:00.000Z');
    assert.equal(value.projects.list('owner-a').items.find(item => item.project_id === project.project_id).active_conversation_count, 1);
    assert.equal(value.projects.list('owner-a').items.find(item => item.project_id === project.project_id).archived_conversation_count, 1);
    assert.throws(() => value.projects.get(project.project_id, 'owner-b'), /project_not_found/);
  } finally { close(value); }
});

test('project rename uses optimistic locking and validates titles', () => {
  const value = fixture();
  try {
    const project = value.projects.create('owner-a', { title: '  News  ' });
    assert.equal(project.title, 'News');
    const renamed = value.projects.update(project.project_id, 'owner-a', { expected_version: 1, title: 'Daily' });
    assert.equal(renamed.title, 'Daily');
    assert.equal(renamed.version, 2);
    assert.throws(() => value.projects.update(project.project_id, 'owner-a', { expected_version: 1, title: 'Stale' }), /version_conflict/);
    assert.throws(() => value.projects.create('owner-a', { title: '   ' }), /invalid_project_title/);
  } finally { close(value); }
});
