import test from 'node:test'
import assert from 'node:assert/strict'
import { loadUserSkill } from '../skill-registry.js'

const body = '# Data rules\nRead before editing.\n'
const summary = {
  name: 'data-rules', description: 'Rules for workspace data', source: 'project-dsh', provider: 'filesystem',
  invocation: { userInvocable: true, modelInvocable: true },
}

test('loads the selected human-invocable body from the original DSH registry', async () => {
  const calls = []
  const skills = {
    snapshot: async options => { calls.push(['snapshot', options]); return { complete: true, skills: [summary] } },
    get: async (name, options) => { calls.push(['get', name, options]); return { ...summary, content: body } },
  }
  const result = await loadUserSkill({ skills, name: 'data-rules', cwd: 'E:/workspace', scope: { id: 'agent' } })
  assert.equal(result.content, body)
  assert.equal(result.name, 'data-rules')
  assert.match(result.bodySha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(calls.map(call => call[0]), ['snapshot', 'get'])
})

test('refuses incomplete catalogs, non-invocable entries and changed definitions', async () => {
  const skills = { snapshot: async () => ({ complete: false, skills: [] }), get: async () => null }
  await assert.rejects(loadUserSkill({ skills, name: 'data-rules' }), /skill_catalog_incomplete/)
  const privateSkill = { ...summary, invocation: { ...summary.invocation, userInvocable: false } }
  await assert.rejects(loadUserSkill({ skills: { snapshot: async () => ({ complete: true, skills: [privateSkill] }), get: async () => assert.fail('must not load a non-user-invocable skill') }, name: 'data-rules' }), /skill_not_user_invocable/)
  await assert.rejects(loadUserSkill({ skills: { snapshot: async () => ({ complete: true, skills: [summary] }), get: async () => ({ ...summary, content: 'x'.repeat(1024 * 1024 + 1) }) }, name: 'data-rules' }), /skill_content_too_large/)
})
