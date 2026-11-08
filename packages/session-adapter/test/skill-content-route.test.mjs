import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdapterHandler } from '../index.js'
import { createSkillContentCommand, createSkillContentReader } from '../skill-content-reader.js'

const token = 'skill-content-route-test-token-0123456789'
const scope = { owner_id: 'alice', project_id: 'project', workspace_id: 'workspace', agent_id: 'role', run_id: 'run', session_ref: 'session', capability_epoch: 1 }
const body = '# Workspace rules\nUse the original project registry.\n'

test('authenticated route returns selected skill content from the guarded resident Agent', async () => {
  const session = { id: 'session', header: { cwd: 'E:/workspace' } }
  const skills = { snapshot: async () => ({ complete: true, skills: [{ name: 'workspace-rules', description: 'Rules', source: 'project-dsh', provider: 'filesystem', invocation: { userInvocable: true, modelInvocable: true } }] }), get: async () => ({ name: 'workspace-rules', description: 'Rules', source: 'project-dsh', provider: 'filesystem', invocation: { userInvocable: true, modelInvocable: true }, content: body }) }
  const agent = { id: 'session', session, ctx: { get: key => key === 'skills' ? skills : undefined } }
  const binding = { runId: 'run', sessionRef: 'session' }
  const bridge = { bindingFor: () => binding, guard: async () => {}, request: async () => ({ context: scope }) }
  const reader = createSkillContentReader({ agents: { get: id => id === 'session' ? agent : undefined }, sessions: { get: id => id === 'session' ? session : undefined }, bridge })
  const command = createSkillContentCommand(reader)
  const handler = createAdapterHandler({ token, controller: {}, skillContentCommand: command })
  const request = (authorization = `Bearer ${token}`, payload = { protocol: 1, scope, name: 'workspace-rules' }) => handler({ method: 'POST', url: new URL('http://localhost/v1/skills/read'), headers: { authorization }, body: payload, signal: new AbortController().signal })
  assert.equal((await request('Bearer wrong')).status, 401)
  assert.equal((await handler({ method: 'GET', url: new URL('http://localhost/v1/skills/read'), headers: { authorization: `Bearer ${token}` }, body: {}, signal: new AbortController().signal })).status, 405)
  const response = await request()
  assert.equal(response.status, 200)
  assert.equal(response.value.skill.content, body)
  assert.equal(response.value.skill.source, 'project-dsh')
  assert.equal(response.value.execution_authorized, false)
  assert.equal((await request(undefined, { protocol: 1, scope, name: 'workspace-rules', action: 'install' })).status, 422)
  const unavailable = createAdapterHandler({ token, controller: {} })
  assert.equal((await unavailable({ method: 'POST', url: new URL('http://localhost/v1/skills/read'), headers: { authorization: `Bearer ${token}` }, body: { protocol: 1, scope, name: 'workspace-rules' }, signal: new AbortController().signal })).status, 503)
})

test('reader refuses owner substitution and an absent resident skill registry', async () => {
  const session = { id: 'session', header: { cwd: 'E:/workspace' } }, binding = { runId: 'run', sessionRef: 'session' }
  const agent = { id: 'session', session, ctx: { get: () => undefined } }
  const reader = createSkillContentReader({ agents: { get: () => agent }, sessions: { get: () => session }, bridge: { bindingFor: () => binding, guard: async () => {}, request: async () => ({ context: scope }) } })
  await assert.rejects(reader({ scope: { ...scope, owner_id: 'mallory' }, name: 'workspace-rules' }), /skill_content_scope_forbidden/)
  await assert.rejects(reader({ scope, name: 'workspace-rules' }), /skills_service_unavailable/)
})

test('reader discards content if the resident Agent is replaced during the registry read', async () => {
  const session = { id: 'session', header: { cwd: 'E:/workspace' } }, binding = { runId: 'run', sessionRef: 'session' }
  let active
  const skills = {
    snapshot: async () => ({ complete: true, skills: [{ name: 'workspace-rules', description: 'Rules', source: 'project-dsh', provider: 'filesystem', invocation: { userInvocable: true, modelInvocable: true } }] }),
    get: async () => { active = { ...active }; return { name: 'workspace-rules', description: 'Rules', source: 'project-dsh', provider: 'filesystem', invocation: { userInvocable: true, modelInvocable: true }, content: body } },
  }
  active = { id: 'session', session, ctx: { get: () => skills } }
  const reader = createSkillContentReader({ agents: { get: () => active }, sessions: { get: () => session }, bridge: { bindingFor: () => binding, guard: async () => {}, request: async () => ({ context: scope }) } })
  await assert.rejects(reader({ scope, name: 'workspace-rules' }), /skill_content_scope_changed/)
})
