import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {skillManifest,skillDefinitionDigestInput} from '../skills/catalog-contract.js'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const MAX_BODY_BYTES = 1024 * 1024

function fail(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function summary(skill) {
  if (!skill || typeof skill !== 'object' || !SKILL_NAME.test(skill.name)
    || typeof skill.description !== 'string' || skill.description.length > 16_384
    || typeof skill.source !== 'string' || !LABEL.test(skill.source)
    || typeof skill.provider !== 'string' || !LABEL.test(skill.provider) || typeof skill.invocation?.userInvocable !== 'boolean'
    || typeof skill.invocation?.modelInvocable !== 'boolean') throw fail('skill_definition_invalid')
  return {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    provider: skill.provider,
    invocation: { userInvocable: skill.invocation.userInvocable, modelInvocable: skill.invocation.modelInvocable },
  }
}

/** Read the selected user skill through the resident DSH SkillRegistry API. */
export async function loadUserSkill({ skills, name, cwd, scope, signal, includeManifest = false } = {}) {
  if (!skills || typeof skills.snapshot !== 'function' || typeof skills.get !== 'function') throw fail('skills_service_unavailable')
  if (typeof name !== 'string' || !SKILL_NAME.test(name)) throw fail('skill_name_invalid')
  signal?.throwIfAborted()
  const options = { cwd, scope, signal }
  const catalog = await skills.snapshot(options)
  signal?.throwIfAborted()
  if (!catalog || typeof catalog.complete !== 'boolean' || !Array.isArray(catalog.skills)) throw fail('skill_snapshot_invalid')
  if (!catalog.complete) throw fail('skill_catalog_incomplete')
  const selected = catalog.skills.find(skill => skill?.name === name)
  if (!selected) throw fail('skill_not_found')
  if (selected.invocation?.userInvocable !== true) throw fail('skill_not_user_invocable')

  const before = summary(selected)
  const selectedLocation = structuredClone({path: selected.path, resourceBase: selected.resourceBase})
  const definition = await skills.get(name, options)
  signal?.throwIfAborted()
  if (!definition) throw fail('skill_not_found')
  if (JSON.stringify(summary(definition)) !== JSON.stringify(before)) throw fail('skill_definition_changed')
  if (selectedLocation.path !== undefined && definition.path !== selectedLocation.path
    || selectedLocation.resourceBase !== undefined && !isDeepStrictEqual(definition.resourceBase, selectedLocation.resourceBase)) {
    throw fail('skill_definition_changed')
  }
  if (typeof definition.content !== 'string') throw fail('skill_content_invalid')
  if (Buffer.byteLength(definition.content, 'utf8') > MAX_BODY_BYTES) throw fail('skill_content_too_large')

  const skill = {
    ...before,
    content: definition.content,
    bodySha256: createHash('sha256').update(definition.content, 'utf8').digest('hex'),
  }
  if (!includeManifest) return skill
  const metadataText = value => {
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value)
    return typeof value === 'string' && value.length>0 && value.length<=512 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null
  }
  const view = {protocol:1,...skillManifest(definition),content:skill.content,bodySha256:skill.bodySha256,
    manifest:{version:metadataText(definition.metadata?.version),license:metadataText(definition.metadata?.license),source:'native-provider-metadata'},
    execution_authorized:false}
  return {...view,definitionSha256:createHash('sha256').update(skillDefinitionDigestInput(view),'utf8').digest('hex')}
}
