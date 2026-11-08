const fileLimit = 104_857_600;
const digestPattern = /^[a-f0-9]{64}$/;

export function workspaceRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 400 || value.startsWith('/') || /[\\:\x00-\x1f]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('workspace_directory_path_invalid');
  return value;
}

function assertWorkspacePathCompatibility(paths, existingPaths = []) {
  const existing = Array.from(existingPaths);
  const selected = new Map();
  for (const path of paths) {
    const key = path.toLowerCase();
    if (selected.has(key)) throw new Error('workspace_directory_path_conflict');
    selected.set(key, path);
  }
  for (const path of existing) {
    const key = path.toLowerCase();
    if (selected.has(key) && selected.get(key) !== path) throw new Error('workspace_directory_path_conflict');
  }
  const selectedKeys = new Set(selected.keys()), all = new Set([...existing, ...selected.values()].map(path => path.toLowerCase()));
  for (const path of all) {
    let parent = '';
    for (const part of path.split('/').slice(0, -1)) {
      parent = parent ? `${parent}/${part}` : part;
      if (all.has(parent) && (selectedKeys.has(path) || selectedKeys.has(parent))) throw new Error('workspace_directory_path_conflict');
    }
  }
}

function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('workspace_directory_export_aborted');
  error.name = 'AbortError';
  throw error;
}

export async function workspaceBytesSha256(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {File[]} files
 * @param {{workspace:string,project:string,existingFiles?:import('./types').WorkspaceFile[],api:typeof import('./client').workbenchApi,makeKey?:()=>string,signal?:AbortSignal,onProgress?:(item:{path:string,size:number,sha256:string,status:'unchanged'|'uploading'|'imported',version?:number})=>void}} [options]
 */
export async function importWorkspaceDirectory(files, { workspace, project, existingFiles = [], api, makeKey = () => globalThis.crypto.randomUUID(), signal, onProgress } = {}) {
  const entries = Array.from(files ?? [], file => ({ file, path: workspaceRelativePath(file.webkitRelativePath) }));
  if (!entries.length) throw new Error('workspace_directory_empty');
  const paths = new Set();
  for (const { path } of entries) {
    if (paths.has(path)) throw new Error('workspace_directory_path_duplicate');
    paths.add(path);
  }
  const current = new Map();
  for (const file of existingFiles) {
    const path = workspaceRelativePath(file.path);
    if (current.has(path) || !Number.isSafeInteger(file.version) || file.version < 1 || !Number.isSafeInteger(file.size) || file.size < 0 || !digestPattern.test(file.sha256))
      throw new Error('workspace_directory_file_list_invalid');
    current.set(path, file);
  }
  assertWorkspacePathCompatibility(paths, current.keys());
  const receipts = [], unchanged = [];
  for (const { file, path } of entries) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > fileLimit) throw new Error('workspace_directory_file_too_large');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== file.size) throw new Error('workspace_directory_file_size_mismatch');
    const sha256 = await workspaceBytesSha256(bytes), previous = current.get(path);
    if (previous?.size === bytes.byteLength && previous.sha256 === sha256) {
      unchanged.push(path);
      onProgress?.({ path, size: bytes.byteLength, sha256, status: 'unchanged' });
      continue;
    }
    const key = makeKey();
    onProgress?.({ path, size: bytes.byteLength, sha256, status: 'uploading' });
    const receipt = await api.importWorkspaceFileBinary(workspace, project, path, previous?.version ?? 0, file, key, signal);
    if (!receipt || receipt.workspace_id !== workspace || receipt.project_id !== project || receipt.path !== path
      || !Number.isSafeInteger(receipt.version) || receipt.version < 1 || receipt.sha256 !== sha256 || receipt.size !== bytes.byteLength
      || receipt.source?.kind !== 'directory_import' || receipt.source.relative_path !== path) throw new Error('workspace_directory_import_receipt_mismatch');
    receipts.push(receipt);
    current.set(path, receipt);
    onProgress?.({ path, size: receipt.size, sha256: receipt.sha256, status: 'imported', version: receipt.version });
  }
  return { receipts, unchanged };
}

export async function downloadWorkspaceFile(file, { workspace, project, api, signal } = {}) {
  const path = workspaceRelativePath(file.path);
  if (!Number.isSafeInteger(file.version) || file.version < 1 || !Number.isSafeInteger(file.size) || file.size < 0 || !digestPattern.test(file.sha256))
    throw new Error('workspace_binary_download_source_invalid');
  const result = await api.readWorkspaceFileBinary(workspace, project, path, file.version, file.sha256, signal);
  const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
  if (bytes.byteLength !== file.size || await workspaceBytesSha256(bytes) !== file.sha256) throw new Error('workspace_binary_download_mismatch');
  return bytes;
}

/**
 * @param {import('./types').WorkspaceFile[]} files
 * @param {{workspace:string,project:string,api:typeof import('./client').workbenchApi,directory:FileSystemDirectoryHandle,signal?:AbortSignal,onProgress?:(item:{path:string,size:number,sha256:string,status:'exported'})=>void}} [options]
 */
export async function exportWorkspaceDirectory(files, { workspace, project, api, directory, signal, onProgress } = {}) {
  assertNotAborted(signal);
  const entries = Array.from(files ?? [], file => ({ file, path: workspaceRelativePath(file.path) }));
  if (!entries.length) throw new Error('workspace_directory_empty');
  const paths = new Set();
  for (const { path } of entries) {
    if (paths.has(path)) throw new Error('workspace_directory_path_duplicate');
    paths.add(path);
  }
  assertWorkspacePathCompatibility(paths);
  const exported = [];
  for (const { file, path } of entries) {
    const bytes = await downloadWorkspaceFile(file, { workspace, project, api, signal });
    assertNotAborted(signal);
    let parent = directory;
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      parent = await parent.getDirectoryHandle(part, { create: true });
      assertNotAborted(signal);
    }
    const target = await parent.getFileHandle(parts.at(-1), { create: true });
    assertNotAborted(signal);
    const writer = await target.createWritable();
    let aborting;
    const abortWriter = () => {
      if (!aborting) aborting = Promise.resolve().then(() => writer.abort?.()).catch(() => {});
      return aborting;
    };
    signal?.addEventListener('abort', abortWriter, { once: true });
    try {
      assertNotAborted(signal);
      await writer.write(bytes);
      assertNotAborted(signal);
      await writer.close();
      assertNotAborted(signal);
    } catch (error) {
      await abortWriter();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abortWriter);
    }
    exported.push(path);
    onProgress?.({ path, size: bytes.byteLength, sha256: file.sha256, status: 'exported' });
  }
  return exported;
}
