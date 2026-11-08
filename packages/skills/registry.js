import { createHash } from 'node:crypto'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEFAULT_RESOURCE_BYTES = 64 * 1024
const MAX_RESOURCE_BYTES = 1024 * 1024

function failure(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function lookupOptions({ cwd, scope, signal }) {
  return { cwd, scope, signal }
}

function requireSkillsService(skills) {
  if (!skills || typeof skills.snapshot !== 'function' || typeof skills.get !== 'function') {
    throw failure('skills_service_unavailable')
  }
  return skills
}

function publicSummary(skill) {
  if (!skill || typeof skill !== 'object' || !SKILL_NAME.test(skill.name)
    || typeof skill.description !== 'string' || !skill.invocation
    || typeof skill.invocation.modelInvocable !== 'boolean'
    || typeof skill.invocation.userInvocable !== 'boolean'
    || typeof skill.source !== 'string' || typeof skill.provider !== 'string') {
    throw failure('skill_summary_invalid')
  }

  return {
    name: skill.name,
    description: skill.description,
    ...(typeof skill.whenToUse === 'string' ? { whenToUse: skill.whenToUse } : {}),
    invocation: {
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable,
    },
    source: skill.source,
    provider: skill.provider,
  }
}

function normalizeRelativeResource(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
    || value.startsWith('/') || value.startsWith('\\') || value.includes('\\')
    || /^[a-z]:/iu.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw failure('skill_resource_path_invalid')
  }
  const parts = value.split('/')
  if (parts.some(part => part.length === 0 || part === '..' || part.includes(':'))) {
    throw failure('skill_resource_path_invalid')
  }
  const normalized = parts.filter(part => part !== '.')
  if (normalized.length === 0) throw failure('skill_resource_path_invalid')
  return normalized
}

function requireFileSystem(fs) {
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.contains !== 'function'
    || typeof fs.stat !== 'function' || typeof fs.readBytes !== 'function') {
    throw failure('skill_filesystem_unavailable')
  }
  return fs
}

async function fileSystemCall(operation, signal) {
  try {
    signal?.throwIfAborted()
    const result = await operation()
    signal?.throwIfAborted()
    return result
  } catch (error) {
    if (signal?.aborted || error?.code === 'FS_ABORTED' || error?.name === 'AbortError') {
      throw failure('skill_resource_cancelled')
    }
    if (error?.code === 'FS_TOO_LARGE') throw failure('skill_resource_too_large')
    if (error?.code === 'FS_NOT_TEXT') throw failure('skill_resource_encoding_invalid')
    if (typeof error?.code === 'string' && error.code.startsWith('skill_')) throw error
    throw failure('skill_resource_unavailable')
  }
}

async function snapshot(skills, options) {
  const result = await requireSkillsService(skills).snapshot(lookupOptions(options))
  if (!result || typeof result.complete !== 'boolean' || !Array.isArray(result.skills)) {
    throw failure('skill_snapshot_invalid')
  }
  return { complete: result.complete, skills: result.skills.map(publicSummary) }
}

/**
 * Return the current DSH skill catalog for a workspace and viewing scope.
 * DSH owns discovery, root precedence, providers, invocation policy, and resource locations.
 * Filesystem locators and provider-specific metadata are intentionally omitted from this view.
 */
export async function listSkills({ skills, cwd, scope, signal } = {}) {
  return snapshot(skills, { cwd, scope, signal })
}

/**
 * Load one human-invocable skill using the DSH registry's current winning definition.
 * Incomplete catalogs and policy changes fail closed; the returned digest covers the body only.
 */
export async function loadUserSkill({ skills, name, cwd, scope, signal } = {}) {
  const definition = await getUserSkillDefinition({ skills, name, cwd, scope, signal })
  const result = publicSummary(definition)
  return {
    ...result,
    content: definition.content,
    bodySha256: createHash('sha256').update(definition.content, 'utf8').digest('hex'),
  }
}

async function getUserSkillDefinition({ skills, name, cwd, scope, signal }) {
  if (typeof name !== 'string' || !SKILL_NAME.test(name)) throw failure('skill_name_invalid')

  const catalog = await snapshot(skills, { cwd, scope, signal })
  if (!catalog.complete) throw failure('skill_catalog_incomplete')
  const selected = catalog.skills.find(skill => skill.name === name)
  if (!selected) throw failure('skill_not_found')
  if (!selected.invocation.userInvocable) throw failure('skill_not_user_invocable')

  const definition = await skills.get(name, lookupOptions({ cwd, scope, signal }))
  if (!definition) throw failure('skill_not_found')
  if (definition.name !== name || definition.invocation?.userInvocable !== true) {
    throw failure('skill_definition_changed')
  }
  if (typeof definition.content !== 'string') throw failure('skill_definition_invalid')
  return definition
}

/**
 * Read one local skill reference through the DSH filesystem service.
 * Only directory-backed resource bases are supported; provider URLs and opaque bases stay with their provider.
 */
export async function readSkillResource(input = {}) {
  return readSkillResourceUnlocked(input)
}

async function readSkillResourceUnlocked({
  skills, fs, name, relativePath, cwd, scope, signal,
  maxBytes = DEFAULT_RESOURCE_BYTES,
} = {}) {
  const parts = normalizeRelativeResource(relativePath)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESOURCE_BYTES) {
    throw failure('skill_resource_limit_invalid')
  }

  if (typeof name !== 'string' || !SKILL_NAME.test(name)) throw failure('skill_name_invalid')
  const lookup = lookupOptions({ cwd, scope, signal })
  const first = await requireSkillsService(skills).snapshot(lookup)
  if (!first || !Array.isArray(first.skills)) throw failure('skill_snapshot_invalid')
  if (!first.complete) throw failure('skill_catalog_incomplete')
  const selected = first.skills.find(skill => skill?.name === name)
  if (!selected) throw failure('skill_not_found')
  if (selected.invocation?.userInvocable !== true) throw failure('skill_not_user_invocable')
  const selectedIdentity = JSON.stringify({ ...publicSummary(selected), resourceBase: selected.resourceBase })
  const base = selected.resourceBase
  if (base?.kind !== 'directory' || typeof base.path !== 'string') {
    throw failure('skill_resource_provider_unsupported')
  }
  const fileSystem = requireFileSystem(fs)
  const options = { cwd, signal }
  const parent = await fileSystemCall(() => fileSystem.resolve(base.path, options), signal)
  const target = await fileSystemCall(() => fileSystem.resolve(parts.join('/'), {
    cwd: base.path,
    signal,
  }), signal)
  let contained
  try {
    contained = fileSystem.contains(parent, target)
  } catch {
    throw failure('skill_resource_path_unsafe')
  }
  if (contained !== true) throw failure('skill_resource_path_unsafe')

  const parentInfo = await fileSystemCall(() => fileSystem.stat(parent, signal), signal)
  if (!parentInfo || parentInfo.type !== 'directory') throw failure('skill_resource_unavailable')
  const before = await fileSystemCall(() => fileSystem.stat(target, signal), signal)
  if (!before || before.type !== 'file' || !Number.isSafeInteger(before.size) || before.size < 0) {
    throw failure('skill_resource_unavailable')
  }
  if (before.size > maxBytes) throw failure('skill_resource_too_large')
  const raw = await fileSystemCall(() => fileSystem.readBytes(target, signal, maxBytes), signal)
  if (!(raw instanceof Uint8Array)) throw failure('skill_resource_unavailable')
  if (raw.byteLength > maxBytes) throw failure('skill_resource_too_large')
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw failure('skill_resource_encoding_invalid')
  }
  const after = await fileSystemCall(() => fileSystem.stat(target, signal), signal)
  if (!after || after.type !== 'file' || before.version !== after.version) {
    throw failure('skill_resource_changed')
  }

  const last = await requireSkillsService(skills).snapshot(lookup)
  const current = last?.skills?.find(skill => skill?.name === name)
  if (!last.complete || !current || current.invocation?.userInvocable !== true
    || JSON.stringify({ ...publicSummary(current), resourceBase: current.resourceBase }) !== selectedIdentity) {
    throw failure('skill_resource_changed')
  }

  const bytes = raw.byteLength
  return {
    text,
    bytes,
    textSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  }
}
