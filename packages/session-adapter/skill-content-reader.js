import {isDeepStrictEqual} from 'node:util'
import {normalizeSkillReadScope as scopeOf,createSkillReadBinding} from './skill-read-scope.js'
import { loadUserSkill } from './skill-registry.js'
import {readSkillSourceManifest} from './skill-source-manifest.js'

const readers = new WeakSet()
const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',')

/** Borrow the resident Agent and its original Workbench guard; never restore a Session or mint authority. */
export function createSkillContentReader({ agents, sessions, bridge, parseYaml, ordinaryPresets } = {}) {
  if (typeof agents?.get !== 'function' || typeof sessions?.get !== 'function'
    || typeof bridge?.guard !== 'function' || typeof bridge?.bindingFor !== 'function' || typeof bridge?.request !== 'function') {
    throw Error('skill_content_host_unavailable')
  }
  const read = async ({ scope: input, name, signal, include_manifest = false, include_source_manifest = false } = {}) => {
    const scope = scopeOf(input)
    if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw Error('skill_name_invalid')
    const bounded = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    const {agent,cwd,authorize}=createSkillReadBinding({scope,signal:bounded,agents,sessions,bridge,ordinaryPresets})
    await authorize()
    const skills = agent.ctx?.get('skills')
    const skill = await loadUserSkill({ skills, name, cwd, scope: agent, signal: bounded, includeManifest:include_manifest,
      includeSourceManifest:include_source_manifest,
      readOriginalManifest:request=>readSkillSourceManifest({...request,skills,fs:agent.ctx?.get('fs',false),parseYaml}) })
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
      || exact(request, ['protocol', 'scope', 'name', 'include_manifest']) && request.include_manifest === true
      || exact(request, ['protocol', 'scope', 'name', 'include_manifest', 'include_source_manifest'])
        && request.include_manifest === true && request.include_source_manifest === true)
      || request.protocol !== 1) throw Error('skill_content_command_invalid')
    const scope = scopeOf(request.scope)
    signal?.throwIfAborted()
    const result = await readContent({ scope, name: request.name, ...(signal ? { signal } : {}),
      ...(request.include_manifest ? {include_manifest:true} : {}),
      ...(request.include_source_manifest ? {include_source_manifest:true} : {}) })
    signal?.throwIfAborted()
    if (!exact(result, ['scope', 'skill', 'execution_authorized']) || result.execution_authorized !== false) throw Error('skill_content_scope_changed')
    const observed = scopeOf(result.scope)
    if (!isDeepStrictEqual(observed,scope)) throw Error('skill_content_scope_changed')
    return result
  }
}
