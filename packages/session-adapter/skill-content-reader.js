import { isAbsolute } from 'node:path'
import { loadUserSkill } from './skill-registry.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const KEYS = ['owner_id', 'project_id', 'workspace_id', 'agent_id', 'run_id', 'session_ref', 'capability_epoch']
const readers = new WeakSet()
const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',')

function scopeOf(value) {
  if (!exact(value, KEYS) || KEYS.slice(0, -1).some(key => typeof value[key] !== 'string' || !ID.test(value[key]))
    || !Number.isSafeInteger(value.capability_epoch) || value.capability_epoch < 1) throw Error('skill_content_scope_forbidden')
  return Object.freeze({ ...value })
}

/** Borrow the resident Agent and its original Workbench guard; never restore a Session or mint authority. */
export function createSkillContentReader({ agents, sessions, bridge } = {}) {
  if (typeof agents?.get !== 'function' || typeof sessions?.get !== 'function'
    || typeof bridge?.guard !== 'function' || typeof bridge?.bindingFor !== 'function' || typeof bridge?.request !== 'function') {
    throw Error('skill_content_host_unavailable')
  }
  const read = async ({ scope: input, name, signal, include_manifest = false } = {}) => {
    const scope = scopeOf(input)
    if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw Error('skill_name_invalid')
    const bounded = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    const agent = agents.get(scope.session_ref)
    const session = sessions.get(scope.session_ref)
    const binding = agent && bridge.bindingFor(agent)
    const cwd = session?.header?.cwd
    const check = () => {
      bounded.throwIfAborted()
      if (!agent || agent.id !== scope.session_ref || agent.session !== session || session?.id !== scope.session_ref
        || typeof cwd !== 'string' || !isAbsolute(cwd) || session.header.cwd !== cwd
        || agents.get(scope.session_ref) !== agent || sessions.get(scope.session_ref) !== session
        || bridge.bindingFor(agent) !== binding || binding?.runId !== scope.run_id || binding?.sessionRef !== scope.session_ref) {
        throw Error('skill_content_scope_changed')
      }
    }
    const authorize = async () => {
      check()
      await bridge.guard(agent, bounded)
      check()
      const result = await bridge.request('guard', binding, {}, bounded)
      check()
      const context = result?.context
      if (!context || KEYS.filter(key => key !== 'session_ref').some(key => context[key] !== scope[key])) {
        throw Error('skill_content_scope_forbidden')
      }
    }

    await authorize()
    const skills = agent.ctx?.get('skills')
    const skill = await loadUserSkill({ skills, name, cwd, scope: agent, signal: bounded, includeManifest:include_manifest })
    await authorize()
    return { scope: { ...scope }, skill, execution_authorized: false }
  }
  readers.add(read)
  return read
}

/** Strict read-only request envelope for the already bearer-authenticated adapter. */
export function createSkillContentCommand(readContent) {
  if (typeof readContent !== 'function' || !readers.has(readContent)) throw Error('skill_content_host_unavailable')
  return async (request, { signal } = {}) => {
    if (!(exact(request, ['protocol', 'scope', 'name'])
      || exact(request, ['protocol', 'scope', 'name', 'include_manifest']) && request.include_manifest === true)
      || request.protocol !== 1) throw Error('skill_content_command_invalid')
    const scope = scopeOf(request.scope)
    signal?.throwIfAborted()
    const result = await readContent({ scope, name: request.name, ...(signal ? { signal } : {}),
      ...(request.include_manifest ? {include_manifest:true} : {}) })
    signal?.throwIfAborted()
    if (!exact(result, ['scope', 'skill', 'execution_authorized']) || result.execution_authorized !== false) throw Error('skill_content_scope_changed')
    const observed = scopeOf(result.scope)
    if (KEYS.some(key => observed[key] !== scope[key])) throw Error('skill_content_scope_changed')
    return result
  }
}
