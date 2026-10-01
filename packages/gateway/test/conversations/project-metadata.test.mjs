import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openProductDatabase } from '../../src/db/database.ts';
import { ProjectRepository } from '../../src/projects/repository.ts';
import { ConversationRepository } from '../../src/conversations/repository.ts';

const model = { provider: 'test', model: 'test' };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ga-conversation-projects-'));
  const db = openProductDatabase(join(directory, 'jot.db'));
  const projects = new ProjectRepository(db);
  return { directory, db, projects, conversations: new ConversationRepository(db, projects) };
}
function close(value) { value.db.close(); rmSync(value.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }

test('legacy create assigns the owner default project and project create is persisted', () => {
  const value = fixture();
  try {
    const defaultConversation = value.conversations.create('owner-a', { workspace_id: 'ws', title: 'A', model });
    const defaultProject = value.projects.ensureDefault('owner-a');
    assert.equal(defaultConversation.project_id, defaultProject.project_id);
    const research = value.projects.create('owner-a', { title: 'Research' });
    const explicit = value.conversations.create('owner-a', { workspace_id: 'ws', title: 'B', model, project_id: research.project_id });
    assert.equal(explicit.project_id, research.project_id);
  } finally { close(value); }
});

test('list filters projects and states and orders pinned conversations first', () => {
  const value = fixture();
  try {
    const project = value.projects.create('owner-a', { title: 'Research' });
    const first = value.conversations.create('owner-a', { workspace_id: 'ws', title: 'First', model, project_id: project.project_id });
    const second = value.conversations.create('owner-a', { workspace_id: 'ws', title: 'Second', model, project_id: project.project_id });
    const pinned = value.conversations.update(first.conversation_id, 'owner-a', { expected_version: first.version, pinned: true });
    const archived = value.conversations.update(second.conversation_id, 'owner-a', { expected_version: second.version, archived: true });
    assert.deepEqual(value.conversations.list('owner-a', { project_id: project.project_id, state: 'active' }).items.map(item => item.conversation_id), [pinned.conversation_id]);
    assert.deepEqual(value.conversations.list('owner-a', { project_id: project.project_id, state: 'archived' }).items.map(item => item.conversation_id), [archived.conversation_id]);
    assert.equal(value.conversations.list('owner-a', { state: 'all' }).items.length, 2);
  } finally { close(value); }
});

test('archive can be restored and project movement enforces ownership', () => {
  const value = fixture();
  try {
    const own = value.projects.create('owner-a', { title: 'Own' });
    const foreign = value.projects.create('owner-b', { title: 'Foreign' });
    const conversation = value.conversations.create('owner-a', { workspace_id: 'ws', model, project_id: own.project_id });
    const archived = value.conversations.update(conversation.conversation_id, 'owner-a', { expected_version: conversation.version, archived: true });
    assert.equal(archived.archived, true);
    const restored = value.conversations.update(conversation.conversation_id, 'owner-a', { expected_version: archived.version, archived: false });
    assert.equal(restored.archived, false);
    assert.throws(() => value.conversations.update(conversation.conversation_id, 'owner-a', { expected_version: restored.version, project_id: foreign.project_id }), /project_not_found/);
  } finally { close(value); }
});
