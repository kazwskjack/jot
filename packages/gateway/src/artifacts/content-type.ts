import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

export type ArtifactContentKind = 'image' | 'text' | 'document' | 'file';
export interface DetectedContentType {
  mediaType: string;
  previewKind: 'text' | 'image' | 'unsupported';
  kind: ArtifactContentKind;
}

function starts(value: Buffer, bytes: number[]): boolean {
  return bytes.every((byte, index) => value[index] === byte);
}

function looksText(value: Buffer): boolean {
  if (value.includes(0)) return false;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(value);
    return !/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded);
  } catch { return false; }
}

function zipEntryNames(path: string): Set<string> | null {
  const size = statSync(path).size;
  const tailSize = Math.min(size, 65_557);
  const tail = Buffer.alloc(tailSize);
  const handle = openSync(path, 'r');
  try { readSync(handle, tail, 0, tail.length, size - tailSize); }
  finally { closeSync(handle); }
  let end = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) return null;
  const entries = tail.readUInt16LE(end + 10);
  const centralSize = tail.readUInt32LE(end + 12);
  const centralOffset = tail.readUInt32LE(end + 16);
  if (entries > 10_000 || centralSize > 8 * 1024 * 1024 || centralOffset + centralSize > size) return null;
  const directory = Buffer.alloc(centralSize);
  const directoryHandle = openSync(path, 'r');
  try { readSync(directoryHandle, directory, 0, directory.length, centralOffset); }
  finally { closeSync(directoryHandle); }
  const names = new Set<string>(); let cursor = 0;
  while (cursor + 46 <= directory.length && names.size < entries) {
    if (directory.readUInt32LE(cursor) !== 0x02014b50) return null;
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > directory.length) return null;
    const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').replaceAll('\\', '/');
    if (name.startsWith('/') || name.split('/').includes('..')) return null;
    names.add(name); cursor = next;
  }
  return names.size === entries ? names : null;
}

function detectZipDocument(path: string): DetectedContentType | null {
  const entries = zipEntryNames(path);
  if (!entries?.has('[Content_Types].xml')) return null;
  if (entries.has('word/document.xml')) return {
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    previewKind: 'unsupported', kind: 'document',
  };
  if (entries.has('xl/workbook.xml')) return {
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    previewKind: 'unsupported', kind: 'document',
  };
  if (entries.has('ppt/presentation.xml')) return {
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    previewKind: 'unsupported', kind: 'document',
  };
  return null;
}

export function detectContentType(path: string, declared = 'application/octet-stream'): DetectedContentType {
  const head = readFileSync(path).subarray(0, 8192);
  if (starts(head, [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) return { mediaType: 'image/png', previewKind: 'image', kind: 'image' };
  if (starts(head, [0xff,0xd8,0xff])) return { mediaType: 'image/jpeg', previewKind: 'image', kind: 'image' };
  if (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a') return { mediaType: 'image/gif', previewKind: 'image', kind: 'image' };
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return { mediaType: 'image/webp', previewKind: 'image', kind: 'image' };
  if (head.subarray(0, 5).toString('ascii') === '%PDF-') return { mediaType: 'application/pdf', previewKind: 'unsupported', kind: 'document' };
  if (starts(head, [0x50,0x4b,0x03,0x04])) return detectZipDocument(path)
    ?? { mediaType: 'application/zip', previewKind: 'unsupported', kind: 'file' };
  const normalized = declared.toLowerCase().split(';')[0]!.trim();
  if (normalized === 'image/svg+xml' || normalized === 'text/html' || normalized === 'application/xhtml+xml') {
    return { mediaType: normalized, previewKind: 'unsupported', kind: 'file' };
  }
  if (looksText(head)) {
    const mediaType = normalized.startsWith('text/') || ['application/json','application/xml'].includes(normalized)
      ? normalized : 'text/plain';
    return { mediaType, previewKind: 'text', kind: 'text' };
  }
  return { mediaType: normalized || 'application/octet-stream', previewKind: 'unsupported', kind: 'file' };
}
